import { randomUUID } from "node:crypto";

import {
  classifyRunStatus,
  matchesExpectedDomain,
  type CashbackCliOptions,
} from "../core/cashback-core.js";
import {
  CashbackError,
  toCashbackError,
} from "../core/errors.js";
import type { RedirectHop } from "../core/redirect-core.js";
import { PLATFORM_SPECS, type InstalledApp } from "../platforms.js";
import {
  createRunArtifacts,
  type CashbackRunResult,
  type RunArtifacts,
} from "./artifacts.js";

interface Session {
  avdName: string;
  serial: string;
  apiLevel: string;
  abi: string;
  exitInfo: {
    ip: string;
    country: string;
    region?: string;
    city?: string;
  };
  startedResources: string[];
  stop(): Promise<void>;
}

interface Observer {
  start(): Promise<void>;
  attachAppWebView(packageName: string): Promise<void>;
  verifyDeviceExit(exit: Session["exitInfo"]): Promise<Session["exitInfo"]>;
  beginCapture(): void;
  waitForLanding(
    expectedDomain: string,
    signal: AbortSignal,
  ): Promise<{
    redirects: RedirectHop[];
    finalUrl: string;
    handoff: "chrome" | "app-webview";
  }>;
  snapshot?(): {
    redirects: RedirectHop[];
    lastObservedUrl: string | null;
    handoffObserved: boolean;
    handoff: "chrome" | "app-webview" | null;
  };
  close(): Promise<void>;
}

interface Driver {
  packageName: string;
  initialize(): Promise<InstalledApp>;
  selectMerchant(merchant: string): Promise<{
    selectedMerchant: string;
    cashbackText: string;
    handoff: "chrome" | "app-webview";
  }>;
  activate(): Promise<{ kind: "ui"; text: string }>;
}

export interface CashbackRunDependencies {
  runId(): string;
  now(): string;
  createArtifacts(runId: string): Promise<RunArtifacts>;
  startSession(signal: AbortSignal): Promise<Session>;
  createObserver(serial: string): Observer;
  createDriver(serial: string): Driver;
  captureScreenshot(serial: string): Promise<Buffer>;
}

export interface CashbackExecution {
  result: CashbackRunResult;
  artifacts: RunArtifacts;
  keepSession: boolean;
  stop(): Promise<void>;
}

export function defaultRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function errorResult(error: CashbackError): CashbackRunResult["error"] {
  return {
    code: error.code,
    stage: error.stage,
    message: error.message,
    evidencePaths: error.evidencePaths,
  };
}

export async function executeCashback(
  options: CashbackCliOptions,
  dependencies: CashbackRunDependencies,
  signal: AbortSignal,
): Promise<CashbackExecution> {
  const runId = dependencies.runId();
  const artifacts = await dependencies.createArtifacts(runId);
  const result: CashbackRunResult = {
    runId,
    status: "failed",
    failureCode: null,
    platform: options.platform,
    appPackage: PLATFORM_SPECS[options.platform].packageName,
    appVersion: null,
    merchantInput: options.merchant,
    selectedMerchant: null,
    cashbackText: null,
    startedAt: dependencies.now(),
    activatedAt: null,
    completedAt: dependencies.now(),
    proxyExit: null,
    device: null,
    activationEvidence: null,
    handoffEvidence: null,
    redirects: [],
    finalUrl: null,
    lastObservedUrl: null,
    screenshotPaths: [],
    startedResources: [],
    error: null,
  };

  let session: Session | undefined;
  let observer: Observer | undefined;
  let stopped = false;
  let screenshotWritten = false;

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await observer?.close();
    await session?.stop();
  };

  const captureScreenshot = async () => {
    if (!session || screenshotWritten) {
      return;
    }
    const png = await dependencies.captureScreenshot(session.serial);
    await artifacts.writeScreenshot(png);
    screenshotWritten = true;
    result.screenshotPaths = ["landing.png"];
  };

  try {
    session = await dependencies.startSession(signal);
    result.proxyExit = session.exitInfo;
    result.device = {
      serial: session.serial,
      avdName: session.avdName,
      apiLevel: session.apiLevel,
      abi: session.abi,
    };
    result.startedResources = [...session.startedResources];

    observer = dependencies.createObserver(session.serial);
    await observer.start();
    result.startedResources.push(
      "chrome-cdp",
      "activity-observer",
      "adb-forward",
    );
    result.proxyExit = await observer.verifyDeviceExit(session.exitInfo);

    const driver = dependencies.createDriver(session.serial);
    result.appPackage = driver.packageName;
    const app = await driver.initialize();
    result.appVersion = app.versionName;

    const merchant = await driver.selectMerchant(options.merchant);
    result.selectedMerchant = merchant.selectedMerchant;
    result.cashbackText = merchant.cashbackText;
    if (merchant.handoff === "app-webview") {
      await observer.attachAppWebView(driver.packageName);
      result.startedResources.push("app-webview-cdp");
    }

    observer.beginCapture();
    result.activationEvidence = await driver.activate();
    result.activatedAt = dependencies.now();

    const landing = await observer.waitForLanding(
      options.expectedDomain,
      signal,
    );
    if (!matchesExpectedDomain(landing.finalUrl, options.expectedDomain)) {
      throw new CashbackError(
        "FINAL_DOMAIN_MISMATCH",
        "capture",
        `final URL did not match ${options.expectedDomain}`,
      );
    }
    result.redirects = landing.redirects;
    result.finalUrl = landing.finalUrl;
    result.lastObservedUrl = landing.finalUrl;
    result.handoffEvidence = {
      kind: landing.handoff,
      observed: true,
    };

    await captureScreenshot();
    result.status = "success";
    result.completedAt = dependencies.now();
    await artifacts.writeResult(result);
  } catch (unknownError) {
    const error = toCashbackError(unknownError, "runtime");
    const capture = result.activationEvidence
      ? observer?.snapshot?.()
      : undefined;
    if (capture) {
      result.redirects = capture.redirects;
      result.lastObservedUrl = capture.lastObservedUrl;
      result.handoffEvidence = capture.handoffObserved
        ? { kind: capture.handoff ?? "chrome", observed: true }
        : null;
    }
    result.failureCode = error.code;
    result.error = errorResult(error);
    result.status = classifyRunStatus({
      activationProven: result.activationEvidence !== null,
      landingVerified: false,
      failureCode: error.code,
    });
    result.completedAt = dependencies.now();

    try {
      await captureScreenshot();
    } catch (screenshotError) {
      if (!result.activationEvidence) {
        const evidenceError = toCashbackError(screenshotError, "artifact");
        result.failureCode = evidenceError.code;
        result.error = errorResult(evidenceError);
      }
    }

    try {
      await artifacts.writeResult(result);
    } catch (writeError) {
      const artifactError =
        writeError instanceof CashbackError
          ? writeError
          : new CashbackError(
              "ARTIFACT_WRITE_FAILED",
              "artifact",
              writeError instanceof Error
                ? writeError.message
                : String(writeError),
              { cause: writeError },
            );
      result.failureCode = artifactError.code;
      result.error = errorResult(artifactError);
      result.status = result.activationEvidence ? "partial" : "failed";
    }
  }

  const keepSession = result.status !== "failed";
  if (!keepSession) {
    await stop();
  }
  return { result, artifacts, keepSession, stop };
}

export function productionArtifacts(
  runId: string,
): Promise<RunArtifacts> {
  return createRunArtifacts(runId);
}
