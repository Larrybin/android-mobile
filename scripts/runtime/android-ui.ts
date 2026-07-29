import { setTimeout as delay } from "node:timers/promises";

import {
  nodeCenter,
  parseUiHierarchy,
  type UiNode,
} from "../core/android-ui-core.js";
import { CashbackError } from "../core/errors.js";
import {
  runCommand,
  runCommandBuffer,
  type CommandOptions,
} from "./command.js";

const REMOTE_DUMP_PATH = "/sdcard/cashback-ui.xml";

function stableNodeSignature(nodes: UiNode[]): string {
  const editTextBounds = nodes
    .filter((node) => node.className === "android.widget.EditText")
    .map((node) => node.bounds);
  return JSON.stringify(
    nodes.map((node) => {
      if (node.className === "android.widget.EditText") {
        return { ...node, text: undefined };
      }
      const isAnonymousPlaceholderChild =
        !node.clickable &&
        node.resourceId === undefined &&
        node.contentDescription === undefined &&
        editTextBounds.some(
          (bounds) =>
            node.bounds.left >= bounds.left &&
            node.bounds.top >= bounds.top &&
            node.bounds.right <= bounds.right &&
            node.bounds.bottom <= bounds.bottom,
        );
      return isAnonymousPlaceholderChild
        ? {
            ...node,
            text: undefined,
            bounds: {
              ...node.bounds,
              right: node.bounds.left,
            },
          }
        : node;
    }),
  );
}

type TextRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<string>;
type BufferRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<Buffer>;
type Delay = (milliseconds: number) => Promise<void>;

export class AndroidUi {
  constructor(
    private readonly serial: string,
    private readonly textRunner: TextRunner = runCommand,
    private readonly bufferRunner: BufferRunner = runCommandBuffer,
    private readonly wait: Delay = async (milliseconds) => {
      await delay(milliseconds);
    },
  ) {}

  private adbArgs(args: string[]): string[] {
    return ["-s", this.serial, ...args];
  }

  async dump(): Promise<string> {
    await this.textRunner(
      "adb",
      this.adbArgs(["shell", "uiautomator", "dump", REMOTE_DUMP_PATH]),
      { timeoutMs: 15_000, stage: "ui" },
    );
    return this.textRunner(
      "adb",
      this.adbArgs(["exec-out", "cat", REMOTE_DUMP_PATH]),
      {
        timeoutMs: 10_000,
        maxStdoutBytes: 4 * 1024 * 1024,
        stage: "ui",
      },
    );
  }

  async readStableNodes({
    timeoutMs = 15_000,
    intervalMs = 500,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {}): Promise<UiNode[]> {
    const deadline = Date.now() + timeoutMs;
    let previous = "";

    while (Date.now() <= deadline) {
      const xml = (await this.dump()).trim();
      if (xml) {
        const nodes = parseUiHierarchy(xml);
        const signature = stableNodeSignature(nodes);
        if (signature === previous) {
          return nodes;
        }
        previous = signature;
      }
      await this.wait(intervalMs);
    }

    throw new CashbackError(
      "UI_NOT_STABLE",
      "ui",
      `UI hierarchy did not stabilize within ${timeoutMs}ms`,
    );
  }

  async readNodes(): Promise<UiNode[]> {
    return parseUiHierarchy((await this.dump()).trim());
  }

  async tap(node: UiNode): Promise<void> {
    if (!node.clickable) {
      throw new CashbackError(
        "UI_NODE_NOT_CLICKABLE",
        "ui",
        "selected UI node is not clickable",
      );
    }
    const { x, y } = nodeCenter(node);
    await this.textRunner(
      "adb",
      this.adbArgs(["shell", "input", "tap", String(x), String(y)]),
      { stage: "ui" },
    );
  }

  async inputText(value: string): Promise<void> {
    if (!/^[a-zA-Z0-9 ._-]+$/.test(value)) {
      throw new CashbackError(
        "INPUT_UNSUPPORTED",
        "ui",
        "merchant input contains characters unsupported by Android input text",
      );
    }
    const encoded = value.trim().replace(/ /g, "%s");
    if (!encoded) {
      throw new CashbackError(
        "INPUT_UNSUPPORTED",
        "ui",
        "merchant input is empty",
      );
    }
    await this.textRunner(
      "adb",
      this.adbArgs(["shell", "input", "text", encoded]),
      { stage: "ui" },
    );
  }

  async screenshot(): Promise<Buffer> {
    return this.bufferRunner(
      "adb",
      this.adbArgs(["exec-out", "screencap", "-p"]),
      {
        timeoutMs: 15_000,
        maxStdoutBytes: 32 * 1024 * 1024,
        stage: "artifact",
      },
    );
  }
}
