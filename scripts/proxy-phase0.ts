import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { CashbackError } from "./core/errors.js";
import {
  redactSecrets,
  runCommand,
  startManagedCommand,
  type ManagedCommand,
} from "./runtime/command.js";

const PROXY_API_URL = "https://rubylinkto.com/api/get_proxy.php";
const EXIT_CHECK_URL = "https://ipinfo.io/json";
const MAX_PROXY_ATTEMPTS = 2;
const API_TIMEOUT_MS = 10_000;
const AVD_TIMEOUT_MS = 180_000;

export interface ProxyCredentials {
  ip: string;
  port: number;
  username: string;
  password: string;
}

export interface ExitInfo {
  ip: string;
  country: string;
  region?: string;
  city?: string;
}

interface Settings {
  apiKey: string;
  region: string;
  avdName: string;
  bridgePort: number;
}

interface Bridge {
  process: ManagedCommand;
  tempDir: string;
  secrets: string[];
  exitInfo: ExitInfo;
}

interface Runtime {
  bridge?: Bridge;
  emulator?: ManagedCommand;
  emulatorSerial?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseProxyResponse(input: unknown): ProxyCredentials {
  if (!isRecord(input)) {
    throw new Error("invalid proxy API response");
  }

  const code = String(input.code ?? "");
  if (code !== "10001") {
    throw new Error(`proxy API returned code ${code || "unknown"}`);
  }

  const data = isRecord(input.data) ? input.data : null;
  const proxyList = data?.proxy_list;
  if (!Array.isArray(proxyList) || proxyList.length === 0) {
    throw new Error("proxy API returned no proxies");
  }

  const proxy = isRecord(proxyList[0]) ? proxyList[0] : null;
  const ip = requiredString(proxy?.ip);
  const username = requiredString(proxy?.username);
  const password = requiredString(proxy?.password);
  const port = Number(proxy?.port);

  if (
    !ip ||
    !username ||
    !password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("proxy API returned an incomplete proxy");
  }

  return { ip, port, username, password };
}

export function assertUsExit(input: unknown): ExitInfo {
  if (!isRecord(input)) {
    throw new Error("invalid proxy exit response");
  }

  const ip = requiredString(input.ip);
  const country = requiredString(input.country);
  if (!ip || !country) {
    throw new Error("invalid proxy exit response");
  }
  if (country.toUpperCase() !== "US") {
    throw new Error(`proxy exit country must be US, got ${country}`);
  }

  const region = requiredString(input.region) ?? undefined;
  const city = requiredString(input.city) ?? undefined;
  return { ip, country: country.toUpperCase(), region, city };
}

export { redactSecrets };

export function buildGostConfig(proxy: ProxyCredentials, bridgePort: number) {
  return {
    services: [
      {
        name: "phase0-http-bridge",
        addr: `127.0.0.1:${bridgePort}`,
        handler: {
          type: "http",
          chain: "rubylink",
        },
        listener: {
          type: "tcp",
        },
      },
    ],
    chains: [
      {
        name: "rubylink",
        hops: [
          {
            name: "rubylink-upstream",
            nodes: [
              {
                name: "rubylink-proxy",
                addr: `${proxy.ip}:${proxy.port}`,
                connector: {
                  type: "socks5",
                  auth: {
                    username: proxy.username,
                    password: proxy.password,
                  },
                  metadata: {
                    notls: true,
                  },
                },
                dialer: {
                  type: "tcp",
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function buildEmulatorArgs(avdName: string): string[] {
  return ["-avd", avdName, "-no-metrics", "-no-snapshot"];
}

export function buildAndroidProxyArgs(
  serial: string,
  bridgePort: number,
): string[] {
  return [
    "-s",
    serial,
    "shell",
    "settings",
    "put",
    "global",
    "http_proxy",
    `10.0.2.2:${bridgePort}`,
  ];
}

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const apiKey = env.RUBYLINK_API_KEY?.trim();
  if (!apiKey) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "RUBYLINK_API_KEY is required",
    );
  }

  const region = env.RUBYLINK_REGION?.trim() || "us-west-1";
  const avdName = env.AVD_NAME?.trim() || "cashback-phase0";
  const bridgePort = Number(env.PROXY_BRIDGE_PORT || "18080");

  if (!/^[a-z0-9-]+$/i.test(region)) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "RUBYLINK_REGION is invalid",
    );
  }
  if (!/^[a-z0-9._-]+$/i.test(avdName)) {
    throw new CashbackError("CONFIG_INVALID", "config", "AVD_NAME is invalid");
  }
  if (
    !Number.isInteger(bridgePort) ||
    bridgePort < 1_024 ||
    bridgePort > 65_535
  ) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "PROXY_BRIDGE_PORT must be between 1024 and 65535",
    );
  }

  return { apiKey, region, avdName, bridgePort };
}

function ensureCommand(command: string): void {
  const result = spawnSync("/usr/bin/env", ["which", command], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new CashbackError(
      "ENVIRONMENT_INVALID",
      "config",
      `${command} is not installed or not in PATH`,
    );
  }
}

export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      rejectPromise(
        new CashbackError(
          "PROXY_PORT_UNAVAILABLE",
          "proxy",
          `127.0.0.1:${port} is already in use`,
        ),
      );
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise();
        }
      });
    });
  });
}

async function fetchProxy(
  apiKey: string,
  region: string,
  signal: AbortSignal,
): Promise<ProxyCredentials> {
  const url = new URL(PROXY_API_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("region", region);

  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: combinedSignal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown error";
    throw new Error(`proxy API request failed (${reason})`);
  }

  if (!response.ok) {
    throw new Error(`proxy API request failed with HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("proxy API returned invalid JSON");
  }

  return parseProxyResponse(body);
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port,
      timeout: 500,
    });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolvePromise(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(
  port: number,
  process: ManagedCommand,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new CashbackError("INTERRUPTED", "proxy", "startup interrupted");
    }
    if (process.child.exitCode !== null) {
      throw new Error(
        `GOST exited before listening: ${process.errorOutput() || "unknown error"}`,
      );
    }
    if (await canConnect(port)) {
      return;
    }
    await delay(200);
  }

  throw new Error("GOST did not open the local proxy port");
}

async function validateBridge(port: number): Promise<ExitInfo> {
  const response = await runCommand("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    "20",
    "--proxy",
    `http://127.0.0.1:${port}`,
    EXIT_CHECK_URL,
  ]);

  let body: unknown;
  try {
    body = JSON.parse(response);
  } catch {
    throw new Error("proxy exit check returned invalid JSON");
  }

  return assertUsExit(body);
}

async function createBridgeConfig(
  proxy: ProxyCredentials,
  port: number,
): Promise<{ tempDir: string; configPath: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "cashback-proxy-"));
  await chmod(tempDir, 0o700);
  const configPath = join(tempDir, "gost.json");
  await writeFile(configPath, JSON.stringify(buildGostConfig(proxy, port)), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
  return { tempDir, configPath };
}

async function disposeBridge(bridge: Bridge | undefined): Promise<void> {
  if (!bridge) {
    return;
  }
  await bridge.process.stop();
  await rm(bridge.tempDir, { recursive: true, force: true });
}

async function acquireBridge(
  settings: Settings,
  signal: AbortSignal,
  runtime: Runtime,
): Promise<Bridge> {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= MAX_PROXY_ATTEMPTS; attempt += 1) {
    if (signal.aborted) {
      throw new CashbackError("INTERRUPTED", "proxy", "startup interrupted");
    }

    let bridge: Bridge | undefined;
    let secrets = [settings.apiKey];
    try {
      console.log(`[proxy] acquiring ${settings.region} proxy (${attempt}/2)`);
      const proxy = await fetchProxy(settings.apiKey, settings.region, signal);
      secrets = [
        settings.apiKey,
        proxy.username,
        proxy.password,
        `${proxy.ip}:${proxy.port}`,
      ];
      const { tempDir, configPath } = await createBridgeConfig(
        proxy,
        settings.bridgePort,
      );
      const process = startManagedCommand("gost", ["-C", configPath], {
        env: {
          ...globalThis.process.env,
          GOST_LOGGER_LEVEL: "error",
        },
        stage: "proxy",
        secrets,
      });
      bridge = {
        process,
        tempDir,
        secrets,
        exitInfo: { ip: "", country: "" },
      };
      runtime.bridge = bridge;

      await waitForPort(settings.bridgePort, process, signal);
      bridge.exitInfo = await validateBridge(settings.bridgePort);
      console.log(
        `[proxy] verified ${[
          bridge.exitInfo.country,
          bridge.exitInfo.region,
          bridge.exitInfo.city,
        ]
          .filter(Boolean)
          .join(" / ")}`,
      );
      return bridge;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = redactSecrets(message, secrets);
      console.error(`[proxy] attempt ${attempt} failed: ${lastError}`);
      await disposeBridge(bridge);
      if (runtime.bridge === bridge) {
        runtime.bridge = undefined;
      }
    }
  }

  throw new CashbackError("PROXY_UNAVAILABLE", "proxy", lastError);
}

async function listEmulatorSerials(): Promise<string[]> {
  const output = await runCommand("adb", ["devices"]);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0]?.startsWith("emulator-") && parts[1] === "device")
    .map((parts) => parts[0] as string);
}

async function findAvdSerial(avdName: string): Promise<string | null> {
  for (const serial of await listEmulatorSerials()) {
    try {
      const output = await runCommand("adb", [
        "-s",
        serial,
        "emu",
        "avd",
        "name",
      ]);
      if (output.split(/\r?\n/)[0]?.trim() === avdName) {
        return serial;
      }
    } catch {
      // The emulator may still be starting.
    }
  }
  return null;
}

async function waitForAvd(
  avdName: string,
  emulator: ManagedCommand,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + AVD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new CashbackError("INTERRUPTED", "device", "startup interrupted");
    }
    if (emulator.child.exitCode !== null) {
      throw new CashbackError(
        "AVD_START_FAILED",
        "device",
        `Emulator exited early: ${emulator.errorOutput() || "unknown error"}`,
      );
    }
    try {
      const serial = await findAvdSerial(avdName);
      if (serial) {
        return serial;
      }
    } catch {
      // ADB is expected to be transiently unavailable during startup.
    }
    await delay(1_000);
  }

  throw new CashbackError(
    "AVD_START_TIMEOUT",
    "device",
    `${avdName} did not come online`,
  );
}

export function isAndroidBootReady(input: {
  sysBootCompleted: string;
  devBootCompleted: string;
  bootAnimation: string;
  packageService: string;
}): boolean {
  return (
    input.sysBootCompleted === "1" &&
    input.devBootCompleted === "1" &&
    input.bootAnimation === "stopped" &&
    input.packageService.includes("found")
  );
}

async function waitForAndroidBoot(
  serial: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + AVD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new CashbackError("INTERRUPTED", "device", "startup interrupted");
    }
    try {
      const [sysBootCompleted, devBootCompleted, bootAnimation, packageService] =
        await Promise.all([
          runCommand("adb", [
            "-s",
            serial,
            "shell",
            "getprop",
            "sys.boot_completed",
          ]),
          runCommand("adb", [
            "-s",
            serial,
            "shell",
            "getprop",
            "dev.bootcomplete",
          ]),
          runCommand("adb", [
            "-s",
            serial,
            "shell",
            "getprop",
            "init.svc.bootanim",
          ]),
          runCommand("adb", [
            "-s",
            serial,
            "shell",
            "service",
            "check",
            "package",
          ]),
        ]);
      if (
        isAndroidBootReady({
          sysBootCompleted,
          devBootCompleted,
          bootAnimation,
          packageService,
        })
      ) {
        return;
      }
    } catch {
      // ADB is expected to be transiently unavailable during startup.
    }
    await delay(1_000);
  }

  throw new CashbackError(
    "AVD_START_TIMEOUT",
    "device",
    `${serial} did not finish booting`,
  );
}

async function configureAndroidProxy(
  serial: string,
  bridgePort: number,
): Promise<void> {
  const expected = `10.0.2.2:${bridgePort}`;
  await runCommand("adb", buildAndroidProxyArgs(serial, bridgePort));
  const actual = await runCommand("adb", [
    "-s",
    serial,
    "shell",
    "settings",
    "get",
    "global",
    "http_proxy",
  ]);
  if (actual !== expected) {
    throw new CashbackError(
      "PROXY_CONFIG_FAILED",
      "device",
      `Android proxy setting mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

interface AndroidStartupDependencies {
  waitForBoot(serial: string, signal: AbortSignal): Promise<void>;
  configureProxy(serial: string, bridgePort: number): Promise<void>;
}

export async function prepareAndroidDevice(
  serial: string,
  bridgePort: number,
  signal: AbortSignal,
  dependencies: AndroidStartupDependencies = {
    waitForBoot: waitForAndroidBoot,
    configureProxy: configureAndroidProxy,
  },
): Promise<void> {
  await dependencies.waitForBoot(serial, signal);
  await dependencies.configureProxy(serial, bridgePort);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    signal.addEventListener("abort", () => resolvePromise(), { once: true });
  });
}

async function stopEmulator(runtime: Runtime): Promise<void> {
  if (runtime.emulatorSerial) {
    try {
      await runCommand("adb", ["-s", runtime.emulatorSerial, "emu", "kill"], {
        timeoutMs: 10_000,
        stage: "cleanup",
      });
    } catch {
      // Fall back to terminating only the Emulator process started here.
    }
  }
  await runtime.emulator?.stop(10_000);
  runtime.emulator = undefined;
  runtime.emulatorSerial = undefined;
}

async function cleanup(runtime: Runtime): Promise<void> {
  await stopEmulator(runtime);
  await disposeBridge(runtime.bridge);
  runtime.bridge = undefined;
}

export interface Phase0Session {
  avdName: string;
  serial: string;
  apiLevel: string;
  abi: string;
  exitInfo: ExitInfo;
  startedResources: string[];
  wait(): Promise<number | null>;
  stop(): Promise<void>;
}

export async function startPhase0Session(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<Phase0Session> {
  const settings = readSettings(env);
  const runtime: Runtime = {};

  try {
    for (const command of ["gost", "emulator", "adb", "curl"]) {
      ensureCommand(command);
    }
    await assertPortAvailable(settings.bridgePort);

    const avds = (await runCommand("emulator", ["-list-avds"]))
      .split(/\r?\n/)
      .filter(Boolean);
    if (!avds.includes(settings.avdName)) {
      throw new CashbackError(
        "AVD_NOT_FOUND",
        "device",
        `AVD ${settings.avdName} does not exist`,
      );
    }
    const bridge = await acquireBridge(settings, signal, runtime);
    let serial = await findAvdSerial(settings.avdName);
    if (!serial) {
      runtime.emulator = startManagedCommand(
        "emulator",
        buildEmulatorArgs(settings.avdName),
        { env, stage: "device" },
      );
      runtime.emulatorSerial = await waitForAvd(
        settings.avdName,
        runtime.emulator,
        signal,
      );
      serial = runtime.emulatorSerial;
    }
    await prepareAndroidDevice(
      serial,
      settings.bridgePort,
      signal,
    );

    const [apiLevel, abi] = await Promise.all([
      runCommand("adb", [
        "-s",
        serial,
        "shell",
        "getprop",
        "ro.build.version.sdk",
      ]),
      runCommand("adb", [
        "-s",
        serial,
        "shell",
        "getprop",
        "ro.product.cpu.abi",
      ]),
    ]);
    if (apiLevel !== "35" || abi !== "arm64-v8a") {
      throw new CashbackError(
        "ENVIRONMENT_INVALID",
        "device",
        `expected API 35 arm64-v8a, got API ${apiLevel} ${abi}`,
      );
    }

    const emulator = runtime.emulator;
    let stopped = false;
    return {
      avdName: settings.avdName,
      serial,
      apiLevel,
      abi,
      exitInfo: bridge.exitInfo,
      startedResources: emulator ? ["gost", "emulator"] : ["gost"],
      wait: () =>
        emulator
          ? emulator.wait()
          : waitForAbort(signal).then(() => null),
      stop: async () => {
        if (stopped) {
          return;
        }
        stopped = true;
        await cleanup(runtime);
      },
    };
  } catch (error) {
    await cleanup(runtime);
    throw error;
  }
}

async function main(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const abortController = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    receivedSignal = signal;
    abortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let session: Phase0Session | undefined;
  try {
    session = await startPhase0Session(process.env, abortController.signal);
    console.log(
      `[ready] ${session.avdName} (${session.serial}) via ${session.exitInfo.country} proxy`,
    );
    console.log("[ready] press Ctrl+C to stop Emulator and proxy");
    await Promise.race([
      session.wait(),
      waitForAbort(abortController.signal),
    ]);
  } finally {
    await session?.stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (receivedSignal) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";

if (import.meta.url === entryPath) {
  main().catch((error) => {
    const code =
      error instanceof CashbackError ? error.code : "UNKNOWN_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const secrets = [process.env.RUBYLINK_API_KEY || ""];
    console.error(`[${code}] ${redactSecrets(message, secrets)}`);
    process.exitCode = 1;
  });
}
