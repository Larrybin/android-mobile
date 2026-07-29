import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseCashbackCliOptions,
  sanitizeConsoleUrl,
  type CashbackPlatform,
} from "./core/cashback-core.js";
import { CashbackError } from "./core/errors.js";
import { startPhase0Session } from "./proxy-phase0.js";
import { AndroidUi } from "./runtime/android-ui.js";
import { CashbackPlatformDriver } from "./runtime/platform-driver.js";
import { RedirectObserver } from "./runtime/redirect-observer.js";
import {
  defaultRunId,
  executeCashback,
  productionArtifacts,
  type CashbackRunDependencies,
} from "./runtime/run-cashback.js";

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm cashback:run -- --platform rakuten --merchant \"Nike\" --expected-domain nike.com",
      "",
      "Platforms:",
      "  rakuten",
      "  ibotta",
      "",
      "The run keeps a successful or partial shopping session open until Ctrl+C.",
      "Full redirect URLs are written only to artifacts/runs/<run-id>/result.json.",
      "",
    ].join("\n"),
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    signal.addEventListener("abort", () => resolvePromise(), { once: true });
  });
}

export function normalizeScriptArgs(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

function createDependencies(
  platform: CashbackPlatform,
): CashbackRunDependencies {
  return {
    runId: defaultRunId,
    now: () => new Date().toISOString(),
    createArtifacts: productionArtifacts,
    startSession: (signal) => startPhase0Session(process.env, signal),
    createObserver: (serial) => new RedirectObserver(serial),
    createDriver: (serial) =>
      new CashbackPlatformDriver(
        platform,
        serial,
        new AndroidUi(serial),
      ),
    captureScreenshot: (serial) => new AndroidUi(serial).screenshot(),
  };
}

async function main(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const args = normalizeScriptArgs(process.argv.slice(2));
  if (args.includes("--help")) {
    printHelp();
    return;
  }
  const options = parseCashbackCliOptions(args);
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const dependencies = createDependencies(options.platform);
  let execution:
    | Awaited<ReturnType<typeof executeCashback>>
    | undefined;
  try {
    execution = await executeCashback(
      options,
      dependencies,
      abortController.signal,
    );
    const { result, artifacts } = execution;
    process.stdout.write(
      [
        `status=${result.status}`,
        `platform=${result.platform}`,
        `merchant=${result.selectedMerchant ?? result.merchantInput}`,
        `cashback=${result.cashbackText ?? "unavailable"}`,
        `exit=${result.proxyExit?.ip ?? "unavailable"}`,
        `device=${result.device?.serial ?? "unavailable"}`,
        `url=${result.finalUrl ? sanitizeConsoleUrl(result.finalUrl) : "unavailable"}`,
        `result=${artifacts.resultPath}`,
        `screenshot=${result.screenshotPaths.length ? artifacts.screenshotPath : "unavailable"}`,
        result.failureCode ? `error=${result.failureCode}` : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );

    if (execution.keepSession) {
      process.stdout.write(
        "Shopping session is being kept open; press Ctrl+C to clean up.\n",
      );
      await waitForAbort(abortController.signal);
    }
    process.exitCode =
      result.status === "success" ? 0 : result.status === "partial" ? 2 : 1;
  } finally {
    await execution?.stop();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";

if (import.meta.url === entryPath) {
  main().catch((error: unknown) => {
    const code =
      error instanceof CashbackError ? error.code : "CASHBACK_RUN_FAILED";
    process.stderr.write(`[${code}] cashback run could not start\n`);
    process.exitCode = 1;
  });
}
