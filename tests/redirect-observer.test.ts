import assert from "node:assert/strict";
import test from "node:test";

import {
  WebViewPageObserver,
  type WebViewObserverRuntime,
} from "../scripts/runtime/redirect-observer.js";
import { CashbackError } from "../scripts/core/errors.js";

class FakeSocket {
  readyState = 0;
  readonly sent: Array<{
    id: number;
    method: string;
    sessionId?: string;
    params: Record<string, unknown>;
  }> = [];
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: unknown }) => void>
  >();

  constructor(
    private readonly failMethod?: string,
    private readonly targets = ["page-1"],
  ) {}

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  send(data: string): void {
    const command = JSON.parse(data) as {
      id: number;
      method: string;
      sessionId?: string;
      params: Record<string, unknown>;
    };
    this.sent.push(command);
    queueMicrotask(() => {
      if (command.method === this.failMethod) {
        this.message({
          id: command.id,
          error: { message: `${command.method} failed` },
        });
        return;
      }
      let result: unknown = {};
      if (command.method === "Target.getTargets") {
        result = {
          targetInfos: this.targets.map((targetId) => ({
            targetId,
            type: "page",
            url: "https://affiliate.example/",
          })),
        };
      } else if (command.method === "Target.attachToTarget") {
        result = {
          sessionId: `session-${String(command.params.targetId)}`,
        };
      } else if (command.method === "Page.getFrameTree") {
        result = { frameTree: { frame: { id: "root-frame" } } };
      }
      this.message({ id: command.id, result });
    });
  }

  networkRequest(sessionId: string): void {
    this.message({
      method: "Network.requestWillBeSent",
      sessionId,
      params: { request: { url: "https://affiliate.example/" } },
    });
  }

  targetCreated(targetId: string): void {
    this.message({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId,
          type: "page",
          url: "https://merchant.example/",
        },
      },
    });
  }

  attached(targetId: string): void {
    this.message({
      method: "Target.attachedToTarget",
      params: {
        sessionId: `event-session-${targetId}`,
        targetInfo: { targetId, type: "page" },
      },
    });
  }

  private message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function runtime(options: {
  targets?: string[];
  failMethod?: string;
} = {}): {
  value: WebViewObserverRuntime;
  socket: FakeSocket;
  commands: string[][];
} {
  const socket = new FakeSocket(
    options.failMethod,
    options.targets ?? ["page-1"],
  );
  const commands: string[][] = [];
  return {
    socket,
    commands,
    value: {
      allocatePort: async () => 9222,
      command: async (_command, args) => {
        commands.push(args);
        return "";
      },
      fetchJson: async (url) => ({
        ok: true,
        status: 200,
        body: url.endsWith("/json/version")
          ? {
              webSocketDebuggerUrl:
                "ws://localhost/devtools/browser/test",
            }
          : [],
      }),
      openSocket: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      wait: async (_ms, signal) => {
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    },
  };
}

function options(recorded: Record<string, unknown>[]) {
  return {
    serial: "emulator-5554",
    socketName: "webview_devtools_remote_123",
    collecting: () => true,
    record: (params: Record<string, unknown>) => {
      recorded.push(params);
    },
    fail: () => {},
  };
}

test("WebView observer is ready only after its page CDP session is enabled", async () => {
  const fixture = runtime();
  const recorded: Record<string, unknown>[] = [];
  const observer = await WebViewPageObserver.connect(
    options(recorded),
    fixture.value,
  );

  assert.deepEqual(
    fixture.socket.sent.map((command) => command.method),
    [
      "Target.setDiscoverTargets",
      "Target.getTargets",
      "Target.attachToTarget",
      "Network.enable",
      "Page.enable",
      "Page.getFrameTree",
      "Runtime.runIfWaitingForDebugger",
    ],
  );

  fixture.socket.networkRequest("session-page-1");
  assert.equal(recorded.length, 1);

  fixture.socket.targetCreated("page-2");
  fixture.socket.attached("page-3");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(
    fixture.socket.sent.some(
      (command) =>
        command.method === "Runtime.runIfWaitingForDebugger" &&
        command.sessionId === "session-page-2",
    ),
  );
  assert.ok(
    fixture.socket.sent.some(
      (command) =>
        command.method === "Runtime.runIfWaitingForDebugger" &&
        command.sessionId === "event-session-page-3",
    ),
  );

  await observer.close();
  assert.ok(
    fixture.commands.some((args) => args.includes("--remove")),
  );
});

test("WebView observer rejects before activation when no page exists", async () => {
  const fixture = runtime({ targets: [] });

  await assert.rejects(
    WebViewPageObserver.connect(options([]), fixture.value),
    (error: unknown) =>
      error instanceof CashbackError &&
      error.code === "WEBVIEW_DEBUG_UNAVAILABLE",
  );
  assert.ok(
    fixture.commands.some((args) => args.includes("--remove")),
  );
});

test("WebView observer rejects before activation when CDP setup fails", async () => {
  const fixture = runtime({ failMethod: "Network.enable" });

  await assert.rejects(
    WebViewPageObserver.connect(options([]), fixture.value),
    (error: unknown) =>
      error instanceof CashbackError &&
      error.code === "CDP_SESSION_FAILED",
  );
  assert.ok(
    fixture.socket.sent.some(
      (command) => command.method === "Target.detachFromTarget",
    ),
  );
});
