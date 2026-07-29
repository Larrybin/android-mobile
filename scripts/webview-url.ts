import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

import { CashbackError } from "./core/errors.js";
import { runCommand } from "./runtime/command.js";
import { WEBVIEW_APPS, type WebViewAppName } from "./webview-apps.js";

const COMMAND_TIMEOUT_MS = 10_000;
const DEVTOOLS_TIMEOUT_MS = 5_000;

type AdbRunner = (args: string[]) => Promise<string>;

export interface DevToolsPage {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  visibilityState?: string;
  hasFocus?: boolean;
}

interface ReadUrlOptions {
  serial: string;
  packageName: string;
}

interface CliOptions extends ReadUrlOptions {
  app?: WebViewAppName;
  json: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseAppProcessIds(
  output: string,
  packageName: string,
): number[] {
  const processPrefix = `${packageName}:`;
  const processIds = new Set<number>();

  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const processId = Number(parts[0]);
    const processName = parts.at(-1);

    if (
      Number.isInteger(processId) &&
      processId > 0 &&
      (processName === packageName || processName?.startsWith(processPrefix))
    ) {
      processIds.add(processId);
    }
  }

  return [...processIds].sort((a, b) => a - b);
}

export function parseDevToolsSockets(
  output: string,
  processIds: number[],
): string[] {
  const appProcessIds = new Set(processIds);
  const sockets = new Set<string>();

  for (const match of output.matchAll(/@webview_devtools_remote_(\d+)\b/g)) {
    const processId = Number(match[1]);
    if (appProcessIds.has(processId)) {
      sockets.add(`webview_devtools_remote_${processId}`);
    }
  }

  return [...sockets];
}

export function selectCurrentPage(pages: DevToolsPage[]): DevToolsPage {
  const candidates = pages.filter(
    (page) => page.type === "page" && isHttpUrl(page.url),
  );

  if (candidates.length === 0) {
    throw new CashbackError(
      "NO_HTTP_PAGE",
      "capture",
      "no HTTP(S) page is open in the app WebView",
    );
  }

  const focused = candidates.filter((page) => page.hasFocus === true);
  if (focused.length === 1) {
    return focused[0]!;
  }

  const visible = candidates.filter(
    (page) => page.visibilityState === "visible",
  );
  if (visible.length === 1) {
    return visible[0]!;
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  throw new CashbackError(
    "MULTIPLE_ACTIVE_PAGES",
    "capture",
    `found ${candidates.length} WebView pages and could not identify the active one`,
  );
}

function runAdb(args: string[]): Promise<string> {
  return runCommand("adb", args, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxStdoutBytes: 4 * 1024 * 1024,
    stage: "capture",
  });
}

async function allocateLocalPort(): Promise<number> {
  const server = createServer();

  return new Promise<number>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("failed to allocate a local TCP port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise(port);
        }
      });
    });
  });
}

export async function withAdbForward<T>(
  serial: string,
  localPort: number,
  socket: string,
  adb: AdbRunner,
  task: () => Promise<T>,
): Promise<T> {
  const forwardArgs = [
    "-s",
    serial,
    "forward",
    `tcp:${localPort}`,
    `localabstract:${socket}`,
  ];
  await adb(forwardArgs);

  let result: T | undefined;
  let taskError: unknown;

  try {
    result = await task();
  } catch (error) {
    taskError = error;
  }

  try {
    await adb([
      "-s",
      serial,
      "forward",
      "--remove",
      `tcp:${localPort}`,
    ]);
  } catch (cleanupError) {
    const cleanupFailure = new CashbackError(
      "ADB_FORWARD_FAILED",
      "cleanup",
      `failed to remove adb forward: ${String(cleanupError)}`,
    );
    if (taskError) {
      throw new AggregateError(
        [taskError, cleanupFailure],
        "WebView read and adb forward cleanup both failed",
      );
    }
    throw cleanupFailure;
  }

  if (taskError) {
    throw taskError;
  }

  return result as T;
}

async function fetchDevToolsPages(localPort: number): Promise<DevToolsPage[]> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${localPort}/json/list`, {
      signal: AbortSignal.timeout(DEVTOOLS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CashbackError(
      "DEVTOOLS_UNAVAILABLE",
      "capture",
      `failed to connect to WebView DevTools: ${String(error)}`,
    );
  }

  if (!response.ok) {
    throw new CashbackError(
      "DEVTOOLS_UNAVAILABLE",
      "capture",
      `WebView DevTools returned HTTP ${response.status}`,
    );
  }

  const input: unknown = await response.json();
  if (!Array.isArray(input)) {
    throw new CashbackError(
      "DEVTOOLS_UNAVAILABLE",
      "capture",
      "WebView DevTools returned an invalid target list",
    );
  }

  return input.flatMap((item): DevToolsPage[] => {
    if (!isRecord(item)) {
      return [];
    }

    const id = typeof item.id === "string" ? item.id : "";
    const type = typeof item.type === "string" ? item.type : "";
    const title = typeof item.title === "string" ? item.title : "";
    const url = typeof item.url === "string" ? item.url : "";
    const webSocketDebuggerUrl =
      typeof item.webSocketDebuggerUrl === "string"
        ? item.webSocketDebuggerUrl
        : undefined;

    return id && type
      ? [{ id, type, title, url, webSocketDebuggerUrl }]
      : [];
  });
}

async function inspectPage(page: DevToolsPage): Promise<DevToolsPage> {
  if (!page.webSocketDebuggerUrl) {
    return page;
  }

  return new Promise<DevToolsPage>((resolvePromise, rejectPromise) => {
    const webSocket = new WebSocket(page.webSocketDebuggerUrl!);
    const timeout = setTimeout(() => {
      webSocket.close();
      rejectPromise(
        new CashbackError(
          "DEVTOOLS_UNAVAILABLE",
          "capture",
          `timed out inspecting WebView target ${page.id}`,
        ),
      );
    }, DEVTOOLS_TIMEOUT_MS);

    const finish = (result: DevToolsPage) => {
      clearTimeout(timeout);
      webSocket.close();
      resolvePromise(result);
    };

    webSocket.addEventListener("open", () => {
      webSocket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression:
              "({url: location.href, visibilityState: document.visibilityState, hasFocus: document.hasFocus()})",
            returnByValue: true,
          },
        }),
      );
    });

    webSocket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (!isRecord(message) || message.id !== 1) {
        return;
      }

      const result = isRecord(message.result) ? message.result : null;
      const runtimeResult = isRecord(result?.result) ? result.result : null;
      const value = isRecord(runtimeResult?.value) ? runtimeResult.value : null;
      if (!value) {
        clearTimeout(timeout);
        webSocket.close();
        rejectPromise(
          new CashbackError(
            "DEVTOOLS_UNAVAILABLE",
            "capture",
            `WebView target ${page.id} returned no page state`,
          ),
        );
        return;
      }

      finish({
        ...page,
        url: typeof value.url === "string" ? value.url : page.url,
        visibilityState:
          typeof value.visibilityState === "string"
            ? value.visibilityState
            : undefined,
        hasFocus:
          typeof value.hasFocus === "boolean" ? value.hasFocus : undefined,
      });
    });

    webSocket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectPromise(
        new CashbackError(
          "DEVTOOLS_UNAVAILABLE",
          "capture",
          `failed to inspect WebView target ${page.id}`,
        ),
      );
    });
  });
}

async function readSocketPages(
  serial: string,
  socket: string,
): Promise<DevToolsPage[]> {
  const localPort = await allocateLocalPort();

  return withAdbForward(serial, localPort, socket, runAdb, async () => {
    const pages = await fetchDevToolsPages(localPort);
    return Promise.all(
      pages
        .filter((page) => page.type === "page")
        .map(inspectPage),
    );
  });
}

export async function readCurrentWebViewUrl({
  serial,
  packageName,
}: ReadUrlOptions): Promise<DevToolsPage> {
  let deviceState: string;
  try {
    deviceState = (
      await runAdb(["-s", serial, "get-state"])
    ).trim();
  } catch (error) {
    throw new CashbackError(
      "DEVICE_NOT_FOUND",
      "device",
      `device ${serial} is unavailable: ${String(error)}`,
    );
  }

  if (deviceState !== "device") {
    throw new CashbackError(
      "DEVICE_NOT_FOUND",
      "device",
      `device ${serial} is in state ${deviceState || "unknown"}`,
    );
  }

  const processOutput = await runAdb([
    "-s",
    serial,
    "shell",
    "ps",
    "-A",
    "-o",
    "PID,NAME",
  ]);
  const processIds = parseAppProcessIds(processOutput, packageName);
  if (processIds.length === 0) {
    throw new CashbackError(
      "APP_NOT_RUNNING",
      "app",
      `app ${packageName} is not running on ${serial}`,
    );
  }

  const unixSockets = await runAdb([
    "-s",
    serial,
    "shell",
    "cat",
    "/proc/net/unix",
  ]);
  const sockets = parseDevToolsSockets(unixSockets, processIds);
  if (sockets.length === 0) {
    throw new CashbackError(
      "WEBVIEW_DEBUG_UNAVAILABLE",
      "capture",
      `app ${packageName} exposes no debuggable WebView`,
    );
  }

  const pages = (
    await Promise.all(sockets.map((socket) => readSocketPages(serial, socket)))
  ).flat();

  return selectCurrentPage(pages);
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm webview:url --app rakuten --serial emulator-5554",
      "  pnpm webview:url --package com.example.app --serial emulator-5554",
      "",
      "Options:",
      "  --json    Output URL metadata as JSON",
      "  --help    Show this help",
      "",
    ].join("\n"),
  );
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      `${flag} requires a value`,
    );
  }
  return value;
}

function parseCliOptions(args: string[]): CliOptions | null {
  if (args.includes("--help")) {
    return null;
  }

  let app: WebViewAppName | undefined;
  let packageName = "";
  let serial = "";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--app") {
      const value = takeValue(args, index, "--app");
      if (!(value in WEBVIEW_APPS)) {
        throw new CashbackError(
          "CONFIG_INVALID",
          "config",
          `unknown app ${value}; configured apps: ${Object.keys(WEBVIEW_APPS).join(", ")}`,
        );
      }
      app = value as WebViewAppName;
      index += 1;
    } else if (argument === "--package") {
      packageName = takeValue(args, index, "--package");
      index += 1;
    } else if (argument === "--serial") {
      serial = takeValue(args, index, "--serial");
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new CashbackError(
        "CONFIG_INVALID",
        "config",
        `unknown argument ${argument}`,
      );
    }
  }

  if (app && packageName) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "use either --app or --package, not both",
    );
  }
  if (!app && !packageName) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "--app or --package is required",
    );
  }
  if (!serial) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "--serial is required",
    );
  }

  return {
    app,
    packageName: app ? WEBVIEW_APPS[app].packageName : packageName,
    serial,
    json,
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options) {
    printHelp();
    return;
  }

  const page = await readCurrentWebViewUrl(options);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        app: options.app,
        packageName: options.packageName,
        url: page.url,
        title: page.title,
        capturedAt: new Date().toISOString(),
      })}\n`,
    );
  } else {
    process.stdout.write(`${page.url}\n`);
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    const code =
      error instanceof CashbackError ? error.code : "WEBVIEW_URL_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${code}] ${message}\n`);
    process.exitCode = 1;
  });
}
