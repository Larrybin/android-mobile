import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import {
  parseActivitySnapshot,
  parseDocumentRequest,
} from "../core/capture-core.js";
import { matchesExpectedDomain } from "../core/cashback-core.js";
import { CashbackError } from "../core/errors.js";
import {
  buildRedirectChain,
  type DocumentRequestEvent,
  type RedirectHop,
} from "../core/redirect-core.js";
import { assertUsExit, type ExitInfo } from "../proxy-phase0.js";
import { launchAndroidApp } from "./android-app.js";
import { runCommand } from "./command.js";

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
  params?: Record<string, unknown>;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface CdpSocket {
  readonly readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
  close(): void;
  send(data: string): void;
}

export interface WebViewObserverRuntime {
  allocatePort(): Promise<number>;
  command(
    command: string,
    args: string[],
    options?: Parameters<typeof runCommand>[2],
  ): Promise<string>;
  fetchJson(
    url: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number; body: unknown }>;
  openSocket(url: string): CdpSocket;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

interface SessionState {
  targetId: string;
  rootFrameId?: string;
  pendingDocuments: Record<string, unknown>[];
}

interface LandingResult {
  redirects: RedirectHop[];
  finalUrl: string;
  handoff: "chrome" | "app-webview";
}

export interface CaptureSnapshot {
  redirects: RedirectHop[];
  lastObservedUrl: string | null;
  handoffObserved: boolean;
  handoff: "chrome" | "app-webview" | null;
}

async function allocateLocalPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("failed to allocate local CDP port"));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise(address.port);
        }
      });
    });
  });
}

const WEBVIEW_RUNTIME: WebViewObserverRuntime = {
  allocatePort: allocateLocalPort,
  command: runCommand,
  fetchJson: async (url, timeoutMs) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json(),
    };
  },
  openSocket: (url) => new WebSocket(url),
  wait: async (ms, signal) => {
    await delay(ms, undefined, signal ? { signal } : undefined);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpNavigationUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function rootFrameId(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.frameTree)) {
    return undefined;
  }
  const frame = result.frameTree.frame;
  return isRecord(frame) && typeof frame.id === "string"
    ? frame.id
    : undefined;
}

function rewriteWebSocketUrl(value: string, port: number): string {
  const url = new URL(value);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.toString();
}

export class WebViewPageObserver {
  private webSocket?: CdpSocket;
  private localPort?: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly targetSessions = new Map<string, string>();
  private readonly attachingTargets = new Set<string>();
  private readonly enablingSessions = new Map<string, Promise<void>>();
  private readonly recoveringSessions = new Set<string>();
  private observedUrl?: string;
  private urlPollAbort?: AbortController;
  private urlPoll?: Promise<void>;

  private constructor(
    private readonly serial: string,
    private readonly collecting: () => boolean,
    private readonly record: (
      params: Record<string, unknown>,
      rootFrameId: string,
    ) => void,
    private readonly fail: (error: CashbackError) => void,
    private readonly runtime: WebViewObserverRuntime,
  ) {}

  static async connect(options: {
    serial: string;
    socketName: string;
    collecting(): boolean;
    record(
      params: Record<string, unknown>,
      rootFrameId: string,
    ): void;
    fail(error: CashbackError): void;
  }, runtime: WebViewObserverRuntime = WEBVIEW_RUNTIME): Promise<WebViewPageObserver> {
    const observer = new WebViewPageObserver(
      options.serial,
      options.collecting,
      options.record,
      options.fail,
      runtime,
    );
    try {
      observer.localPort = await runtime.allocatePort();
      await runtime.command(
        "adb",
        [
          "-s",
          options.serial,
          "forward",
          `tcp:${observer.localPort}`,
          `localabstract:${options.socketName}`,
        ],
        { stage: "capture" },
      );
      const version = await observer.fetchVersion();
      const browserUrl =
        isRecord(version) &&
        typeof version.webSocketDebuggerUrl === "string"
          ? version.webSocketDebuggerUrl
          : null;
      if (!browserUrl) {
        throw new CashbackError(
          "WEBVIEW_DEBUG_UNAVAILABLE",
          "capture",
          "debuggable WebView exposed no browser target",
        );
      }
      await observer.open(
        rewriteWebSocketUrl(browserUrl, observer.localPort),
      );
      await observer.send("Target.setDiscoverTargets", { discover: true });
      const attachedPages = await observer.attachExistingPages();
      if (attachedPages === 0) {
        throw new CashbackError(
          "WEBVIEW_DEBUG_UNAVAILABLE",
          "capture",
          "WebView exposed no page target before activation",
        );
      }
      observer.startUrlPoll();
      return observer;
    } catch (error) {
      await observer.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.urlPollAbort?.abort();
    await this.urlPoll?.catch(() => {});
    this.urlPollAbort = undefined;
    this.urlPoll = undefined;
    this.webSocket?.close();
    this.webSocket = undefined;
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(new Error("WebView observer closed"));
    }
    this.pending.clear();
    this.sessions.clear();
    this.targetSessions.clear();
    this.attachingTargets.clear();
    this.enablingSessions.clear();
    this.recoveringSessions.clear();
    if (this.localPort !== undefined) {
      const port = this.localPort;
      this.localPort = undefined;
      await this.runtime.command(
        "adb",
        ["-s", this.serial, "forward", "--remove", `tcp:${port}`],
        { stage: "cleanup" },
      ).catch(() => {});
    }
  }

  currentUrl(): string | null {
    return this.observedUrl ?? null;
  }

  private startUrlPoll(): void {
    const abortController = new AbortController();
    this.urlPollAbort = abortController;
    this.urlPoll = (async () => {
      while (!abortController.signal.aborted) {
        try {
          const response = await this.runtime.fetchJson(
            `http://127.0.0.1:${this.localPort}/json/list`,
            2_000,
          );
          if (response.ok) {
            const targets = response.body;
            if (Array.isArray(targets)) {
              const page = targets.find(
                (target) =>
                  isRecord(target) &&
                  target.type === "page" &&
                  isHttpNavigationUrl(target.url),
              );
              if (isRecord(page) && isHttpNavigationUrl(page.url)) {
                this.observedUrl = page.url;
              }
            }
          }
        } catch {
          // URL polling is evidence-only; CDP reports capture failures.
        }
        await this.runtime.wait(250, abortController.signal).catch(
          () => {},
        );
      }
    })();
  }

  private async fetchVersion(): Promise<unknown> {
    const response = await this.runtime.fetchJson(
      `http://127.0.0.1:${this.localPort}/json/version`,
      5_000,
    );
    if (!response.ok) {
      throw new Error(`WebView discovery returned HTTP ${response.status}`);
    }
    return response.body;
  }

  private async open(url: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const webSocket = this.runtime.openSocket(url);
      const timer = setTimeout(() => {
        webSocket.close();
        rejectPromise(new Error("WebView CDP WebSocket timed out"));
      }, 5_000);
      webSocket.addEventListener("open", () => {
        clearTimeout(timer);
        this.webSocket = webSocket;
        resolvePromise();
      });
      webSocket.addEventListener("message", (event) => {
        this.onMessage(String(event.data));
      });
      webSocket.addEventListener("close", () => {
        if (this.collecting()) {
          this.fail(
            new CashbackError(
              "CDP_DISCONNECTED",
              "capture",
              "WebView CDP disconnected after activation",
            ),
          );
        }
      });
      webSocket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectPromise(new Error("WebView CDP WebSocket failed"));
      });
    });
  }

  private async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const webSocket = this.webSocket;
    if (!webSocket || webSocket.readyState !== 1) {
      throw new Error("WebView CDP is not connected");
    }
    const id = this.nextId++;
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out`));
      }, 5_000);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      webSocket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private onMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "unknown CDP command error"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "Target.targetCreated" && message.params) {
      const targetInfo = message.params.targetInfo;
      if (
        isRecord(targetInfo) &&
        typeof targetInfo.targetId === "string" &&
        targetInfo.type === "page"
      ) {
        if (isHttpNavigationUrl(targetInfo.url)) {
          this.observedUrl = targetInfo.url;
        }
        void this.attachTarget(targetInfo.targetId).catch(() => {});
      }
      return;
    }
    if (
      message.method === "Target.targetInfoChanged" &&
      message.params &&
      isRecord(message.params.targetInfo) &&
      isHttpNavigationUrl(message.params.targetInfo.url)
    ) {
      this.observedUrl = message.params.targetInfo.url;
      return;
    }
    if (message.method === "Target.attachedToTarget" && message.params) {
      const sessionId = message.params.sessionId;
      const targetInfo = message.params.targetInfo;
      if (
        typeof sessionId === "string" &&
        isRecord(targetInfo) &&
        typeof targetInfo.targetId === "string" &&
        targetInfo.type === "page"
      ) {
        this.attachingTargets.delete(targetInfo.targetId);
        void this.enableSession(sessionId, targetInfo.targetId).catch(
          () => {},
        );
      }
      return;
    }
    if (
      message.method === "Target.detachedFromTarget" &&
      message.params &&
      typeof message.params.sessionId === "string"
    ) {
      const state = this.sessions.get(message.params.sessionId);
      this.sessions.delete(message.params.sessionId);
      if (state) {
        this.targetSessions.delete(state.targetId);
        const recovering = this.recoveringSessions.delete(
          message.params.sessionId,
        );
        if (this.collecting() && !recovering) {
          this.fail(
            new CashbackError(
              "CDP_TARGET_DETACHED",
              "capture",
              "WebView target detached during redirect capture",
            ),
          );
        }
      }
      return;
    }
    if (
      message.method === "Network.requestWillBeSent" &&
      message.sessionId &&
      message.params &&
      this.collecting()
    ) {
      const session = this.sessions.get(message.sessionId);
      if (!session) {
        return;
      }
      if (!session.rootFrameId) {
        session.pendingDocuments.push(message.params);
        return;
      }
      this.record(message.params, session.rootFrameId);
    }
  }

  private enableSession(
    sessionId: string,
    targetId: string,
  ): Promise<void> {
    if (this.sessions.get(sessionId)?.rootFrameId) {
      return Promise.resolve();
    }
    const pending = this.enablingSessions.get(sessionId);
    if (pending) {
      return pending;
    }
    const ready = this.initializeSession(sessionId, targetId).finally(() => {
      this.enablingSessions.delete(sessionId);
    });
    this.enablingSessions.set(sessionId, ready);
    return ready;
  }

  private async initializeSession(
    sessionId: string,
    targetId: string,
  ): Promise<void> {
    const state: SessionState = {
      targetId,
      pendingDocuments: [],
    };
    this.sessions.set(sessionId, state);
    this.targetSessions.set(targetId, sessionId);
    try {
      await Promise.all([
        this.send("Network.enable", {}, sessionId),
        this.send("Page.enable", {}, sessionId),
      ]);
      state.rootFrameId = rootFrameId(
        await this.send("Page.getFrameTree", {}, sessionId),
      );
      if (!state.rootFrameId) {
        throw new Error("WebView target has no root frame");
      }
      for (const params of state.pendingDocuments) {
        this.record(params, state.rootFrameId);
      }
      state.pendingDocuments.length = 0;
      await this.send(
        "Runtime.runIfWaitingForDebugger",
        {},
        sessionId,
      );
    } catch (error) {
      this.sessions.delete(sessionId);
      this.targetSessions.delete(targetId);
      this.recoveringSessions.add(sessionId);
      await this.send("Target.detachFromTarget", { sessionId }).catch(
        () => {},
      );
      this.recoveringSessions.delete(sessionId);
      const failure = new CashbackError(
        "CDP_SESSION_FAILED",
        "capture",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
      if (this.collecting()) {
        this.fail(failure);
      }
      throw failure;
    }
  }

  private async attachExistingPages(): Promise<number> {
    const result = await this.send("Target.getTargets");
    if (!isRecord(result) || !Array.isArray(result.targetInfos)) {
      throw new Error("WebView returned an invalid target list");
    }
    let attached = 0;
    for (const target of result.targetInfos) {
      if (
        !isRecord(target) ||
        target.type !== "page" ||
        typeof target.targetId !== "string" ||
        this.targetSessions.has(target.targetId)
      ) {
        continue;
      }
      await this.attachTarget(target.targetId);
      attached += 1;
    }
    return attached;
  }

  private async attachTarget(targetId: string): Promise<void> {
    if (
      this.targetSessions.has(targetId) ||
      this.attachingTargets.has(targetId)
    ) {
      return;
    }
    this.attachingTargets.add(targetId);
    try {
      const result = await this.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId =
        isRecord(result) && typeof result.sessionId === "string"
          ? result.sessionId
          : this.targetSessions.get(targetId);
      if (!sessionId) {
        throw new Error("WebView target did not return a CDP session");
      }
      await this.enableSession(sessionId, targetId);
    } catch (error) {
      if (this.collecting()) {
        this.fail(
          new CashbackError(
            "CDP_SESSION_FAILED",
            "capture",
            error instanceof Error ? error.message : String(error),
            { cause: error },
          ),
        );
      }
      throw error;
    } finally {
      this.attachingTargets.delete(targetId);
    }
  }
}

export class RedirectObserver {
  private localPort?: number;
  private webSocket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly targetSessions = new Map<string, string>();
  private readonly documentEvents: DocumentRequestEvent[] = [];
  private readonly activityPackages: string[] = [];
  private collecting = false;
  private disconnected = false;
  private captureError?: CashbackError;
  private activityLoop?: Promise<void>;
  private activityAbort?: AbortController;
  private webViewObserver?: WebViewPageObserver;

  constructor(private readonly serial: string) {}

  async start(): Promise<void> {
    await launchAndroidApp(
      this.serial,
      "com.android.chrome",
      runCommand,
      "capture",
    );

    this.localPort = await allocateLocalPort();
    await runCommand(
      "adb",
      [
        "-s",
        this.serial,
        "forward",
        `tcp:${this.localPort}`,
        "localabstract:chrome_devtools_remote",
      ],
      { stage: "capture" },
    );

    try {
      const version = await this.fetchVersion();
      const debuggerUrl =
        isRecord(version) && typeof version.webSocketDebuggerUrl === "string"
          ? version.webSocketDebuggerUrl
          : null;
      if (!debuggerUrl) {
        throw new CashbackError(
          "CHROME_CDP_UNAVAILABLE",
          "capture",
          "Chrome did not expose a browser WebSocket target",
        );
      }
      await this.connect(rewriteWebSocketUrl(debuggerUrl, this.localPort));
      await this.send("Target.setDiscoverTargets", { discover: true });
      await this.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      await this.attachExistingPages();
      await this.startActivityObserver();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  beginCapture(): void {
    this.documentEvents.length = 0;
    this.activityPackages.length = 0;
    this.captureError = undefined;
    this.collecting = true;
  }

  async attachAppWebView(packageName: string): Promise<void> {
    const pid = (
      await runCommand(
        "adb",
        ["-s", this.serial, "shell", "pidof", packageName],
        { stage: "capture" },
      )
    ).split(/\s+/)[0];
    if (!pid || !/^\d+$/.test(pid)) {
      throw new CashbackError(
        "WEBVIEW_DEBUG_UNAVAILABLE",
        "capture",
        `${packageName} process was not running`,
      );
    }
    const sockets = await runCommand(
      "adb",
      ["-s", this.serial, "shell", "cat", "/proc/net/unix"],
      { stage: "capture", maxStdoutBytes: 4 * 1024 * 1024 },
    );
    const socketName = `webview_devtools_remote_${pid}`;
    if (!sockets.includes(`@${socketName}`)) {
      throw new CashbackError(
        "WEBVIEW_DEBUG_UNAVAILABLE",
        "capture",
        `${packageName} did not expose a debuggable WebView before activation`,
      );
    }

    this.webViewObserver = await WebViewPageObserver.connect({
      serial: this.serial,
      socketName,
      collecting: () => this.collecting,
      record: (params, rootFrameId) => {
        const event = parseDocumentRequest(
          params,
          rootFrameId,
          "app-webview",
        );
        if (event) {
          this.documentEvents.push(event);
        }
      },
      fail: (error) => {
        this.captureError = error;
      },
    });
  }

  snapshot(): CaptureSnapshot {
    let redirects: RedirectHop[] = [];
    try {
      redirects = buildRedirectChain(this.documentEvents);
    } catch {
      // The run error still reports the broken chain; raw URLs stay in memory only.
    }
    return {
      redirects,
      lastObservedUrl:
        this.documentEvents.at(-1)?.url ??
        this.webViewObserver?.currentUrl() ??
        null,
      handoffObserved:
        this.documentEvents.length > 0 ||
        this.webViewObserver?.currentUrl() !== null ||
        this.activityPackages.includes("com.android.chrome"),
      handoff:
        this.documentEvents.at(-1)?.source === "app-webview"
          ? "app-webview"
          : this.webViewObserver?.currentUrl()
            ? "app-webview"
          : this.documentEvents.length > 0 ||
              this.activityPackages.includes("com.android.chrome")
            ? "chrome"
            : null,
    };
  }

  async verifyDeviceExit(hostExit: ExitInfo): Promise<ExitInfo> {
    const body = await this.openJsonTarget("https://ipinfo.io/json");
    const deviceExit = assertUsExit(body);
    if (deviceExit.ip !== hostExit.ip) {
      throw new CashbackError(
        "DEVICE_EXIT_MISMATCH",
        "proxy",
        `host exit ${hostExit.ip} differs from Android Chrome exit ${deviceExit.ip}`,
      );
    }
    return deviceExit;
  }

  async waitForLanding(
    expectedDomain: string,
    signal: AbortSignal,
  ): Promise<LandingResult> {
    const startedAt = Date.now();
    const handoffDeadline = startedAt + 30_000;
    const landingDeadline = startedAt + 60_000;
    let stableUrl = "";
    let stableSince = 0;

    while (Date.now() <= landingDeadline) {
      if (signal.aborted) {
        throw new CashbackError("INTERRUPTED", "capture", "capture cancelled");
      }
      if (this.disconnected) {
        throw new CashbackError(
          "CDP_DISCONNECTED",
          "capture",
          "Chrome CDP disconnected after activation",
        );
      }
      if (this.captureError) {
        throw this.captureError;
      }
      if (this.documentEvents.length > 100) {
        throw new CashbackError(
          "REDIRECT_LIMIT_EXCEEDED",
          "capture",
          "more than 100 document navigations were observed",
        );
      }

      const latest = this.documentEvents.at(-1)?.url ?? "";
      const handoffObserved =
        this.documentEvents.length > 0 ||
        this.activityPackages.includes("com.android.chrome");
      if (!handoffObserved && Date.now() > handoffDeadline) {
        throw new CashbackError(
          "HANDOFF_TIMEOUT",
          "capture",
          "browser handoff was not observed within 30 seconds",
        );
      }

      if (latest && matchesExpectedDomain(latest, expectedDomain)) {
        if (latest !== stableUrl) {
          stableUrl = latest;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 5_000) {
          return {
            redirects: buildRedirectChain(this.documentEvents),
            finalUrl: latest,
            handoff:
              this.documentEvents.at(-1)?.source === "app-webview"
                ? "app-webview"
                : "chrome",
          };
        }
      } else {
        stableUrl = "";
        stableSince = 0;
      }
      await delay(250);
    }

    const latest = this.documentEvents.at(-1)?.url;
    throw new CashbackError(
      latest ? "FINAL_DOMAIN_MISMATCH" : "LANDING_TIMEOUT",
      "capture",
      latest
        ? `final URL did not match ${expectedDomain}`
        : "no final browser landing URL was observed",
    );
  }

  async close(): Promise<void> {
    this.collecting = false;
    await this.webViewObserver?.close();
    this.webViewObserver = undefined;
    this.activityAbort?.abort();
    await this.activityLoop?.catch(() => {});
    this.activityLoop = undefined;
    this.activityAbort = undefined;

    this.webSocket?.close();
    this.webSocket = undefined;
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(new Error("CDP observer closed"));
    }
    this.pending.clear();

    if (this.localPort !== undefined) {
      const port = this.localPort;
      this.localPort = undefined;
      await runCommand(
        "adb",
        [
          "-s",
          this.serial,
          "forward",
          "--remove",
          `tcp:${port}`,
        ],
        { stage: "cleanup" },
      ).catch(() => {});
    }
  }

  private async fetchVersion(): Promise<unknown> {
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${this.localPort}/json/version`,
          { signal: AbortSignal.timeout(2_000) },
        );
        if (response.ok) {
          return await response.json();
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    throw new CashbackError(
      "CHROME_CDP_UNAVAILABLE",
      "capture",
      `Chrome CDP did not become ready: ${String(lastError)}`,
    );
  }

  private async connect(url: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const webSocket = new WebSocket(url);
      const timer = setTimeout(() => {
        webSocket.close();
        rejectPromise(new Error("Chrome CDP WebSocket timed out"));
      }, 5_000);
      webSocket.addEventListener("open", () => {
        clearTimeout(timer);
        this.webSocket = webSocket;
        resolvePromise();
      });
      webSocket.addEventListener("message", (event) => {
        this.onMessage(String(event.data));
      });
      webSocket.addEventListener("close", () => {
        this.disconnected = true;
      });
      webSocket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectPromise(new Error("Chrome CDP WebSocket failed"));
      });
    });
  }

  private async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const webSocket = this.webSocket;
    if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
      throw new CashbackError(
        "CDP_DISCONNECTED",
        "capture",
        "Chrome CDP is not connected",
      );
    }
    const id = this.nextId++;
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out`));
      }, 5_000);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      webSocket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private onMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "unknown CDP command error"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "Target.attachedToTarget" && message.params) {
      const sessionId = message.params.sessionId;
      const targetInfo = message.params.targetInfo;
      if (
        typeof sessionId === "string" &&
        isRecord(targetInfo) &&
        typeof targetInfo.targetId === "string" &&
        targetInfo.type === "page"
      ) {
        void this.enableSession(sessionId, targetInfo.targetId);
      }
      return;
    }

    if (
      message.method === "Target.detachedFromTarget" &&
      message.params &&
      typeof message.params.sessionId === "string"
    ) {
      const state = this.sessions.get(message.params.sessionId);
      this.sessions.delete(message.params.sessionId);
      if (state) {
        this.targetSessions.delete(state.targetId);
        if (this.collecting) {
          this.captureError = new CashbackError(
            "CDP_TARGET_DETACHED",
            "capture",
            "Chrome target detached during redirect capture",
          );
        }
      }
      return;
    }

    if (
      message.method === "Network.requestWillBeSent" &&
      message.sessionId &&
      message.params
    ) {
      const session = this.sessions.get(message.sessionId);
      if (!session || !this.collecting) {
        return;
      }
      if (!session.rootFrameId) {
        session.pendingDocuments.push(message.params);
        return;
      }
      this.recordDocument(message.params, session.rootFrameId);
    }
  }

  private async enableSession(
    sessionId: string,
    targetId: string,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) {
      return;
    }
    const state: SessionState = {
      targetId,
      pendingDocuments: [],
    };
    this.sessions.set(sessionId, state);
    this.targetSessions.set(targetId, sessionId);
    try {
      await Promise.all([
        this.send("Network.enable", {}, sessionId),
        this.send("Page.enable", {}, sessionId),
      ]);
      state.rootFrameId = rootFrameId(
        await this.send("Page.getFrameTree", {}, sessionId),
      );
      if (!state.rootFrameId) {
        throw new Error("Chrome target has no root frame");
      }
      for (const params of state.pendingDocuments) {
        this.recordDocument(params, state.rootFrameId);
      }
      state.pendingDocuments.length = 0;
      await this.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    } catch (error) {
      this.sessions.delete(sessionId);
      this.targetSessions.delete(targetId);
      if (this.collecting) {
        this.captureError = new CashbackError(
          "CDP_SESSION_FAILED",
          "capture",
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
    }
  }

  private recordDocument(
    params: Record<string, unknown>,
    rootId: string,
  ): void {
    const event = parseDocumentRequest(params, rootId, "chrome");
    if (event) {
      this.documentEvents.push(event);
    }
  }

  private async attachExistingPages(): Promise<void> {
    const result = await this.send("Target.getTargets");
    if (!isRecord(result) || !Array.isArray(result.targetInfos)) {
      throw new Error("Chrome returned an invalid target list");
    }
    const targets = result.targetInfos.filter(
      (item) =>
        isRecord(item) &&
        item.type === "page" &&
        typeof item.targetId === "string",
    );
    for (const target of targets) {
      if (!isRecord(target) || typeof target.targetId !== "string") {
        continue;
      }
      if (this.targetSessions.has(target.targetId)) {
        continue;
      }
      await this.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
    }
  }

  private async readActivity(): Promise<string> {
    return runCommand(
      "adb",
      [
        "-s",
        this.serial,
        "shell",
        "dumpsys",
        "activity",
        "activities",
      ],
      {
        timeoutMs: 5_000,
        maxStdoutBytes: 4 * 1024 * 1024,
        stage: "capture",
      },
    );
  }

  private async startActivityObserver(): Promise<void> {
    await this.readActivity();
    const abortController = new AbortController();
    this.activityAbort = abortController;
    this.activityLoop = (async () => {
      while (!abortController.signal.aborted) {
        try {
          const output = await this.readActivity();
          if (this.collecting) {
            const snapshot = parseActivitySnapshot(output);
            if (
              snapshot.packageName &&
              this.activityPackages.at(-1) !== snapshot.packageName
            ) {
              this.activityPackages.push(snapshot.packageName);
            }
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            this.disconnected = true;
          }
        }
        await delay(250, undefined, {
          signal: abortController.signal,
        }).catch(() => {});
      }
    })();
  }

  private async openJsonTarget(url: string): Promise<unknown> {
    const created = await this.send("Target.createTarget", {
      url: "about:blank",
    });
    const targetId =
      isRecord(created) && typeof created.targetId === "string"
        ? created.targetId
        : null;
    if (!targetId) {
      throw new Error("Chrome did not create the diagnostic target");
    }

    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() <= deadline) {
        const sessionId = this.targetSessions.get(targetId);
        if (sessionId && this.sessions.get(sessionId)?.rootFrameId) {
          const evaluated = await this.send(
            "Runtime.evaluate",
            {
              expression: [
                `fetch(${JSON.stringify(url)})`,
                ".then(response => {",
                "if (!response.ok) throw new Error(`HTTP ${response.status}`);",
                "return response.json();",
                "})",
              ].join(""),
              awaitPromise: true,
              returnByValue: true,
            },
            sessionId,
          );
          if (isRecord(evaluated) && isRecord(evaluated.result)) {
            const value = evaluated.result.value;
            if (isRecord(value)) {
              return value;
            }
          }
        }
        await delay(250);
      }
      throw new Error("Chrome diagnostic target did not finish loading");
    } finally {
      await this.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }
}
