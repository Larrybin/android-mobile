import {
  chmod,
  mkdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";

import type {
  CashbackPlatform,
  CashbackRunStatus,
} from "../core/cashback-core.js";
import type { RedirectHop } from "../core/redirect-core.js";

export interface CashbackRunResult {
  runId: string;
  status: CashbackRunStatus;
  failureCode: string | null;
  platform: CashbackPlatform;
  appPackage: string;
  appVersion: string | null;
  merchantInput: string;
  selectedMerchant: string | null;
  cashbackText: string | null;
  startedAt: string;
  activatedAt: string | null;
  completedAt: string;
  proxyExit: {
    ip: string;
    country: string;
    region?: string;
    city?: string;
  } | null;
  device: {
    serial: string;
    avdName: string;
    apiLevel: string;
    abi: string;
  } | null;
  activationEvidence: {
    kind: "ui";
    text: string;
  } | null;
  handoffEvidence: {
    kind: "chrome" | "app-webview";
    observed: boolean;
  } | null;
  redirects: RedirectHop[];
  finalUrl: string | null;
  lastObservedUrl: string | null;
  screenshotPaths: string[];
  startedResources: string[];
  error: {
    code: string;
    stage: string;
    message: string;
    evidencePaths: string[];
  } | null;
}

export interface RunArtifacts {
  directory: string;
  resultPath: string;
  screenshotPath: string;
  writeResult(result: CashbackRunResult): Promise<void>;
  writeScreenshot(png: Buffer): Promise<void>;
}

async function atomicPrivateWrite(
  path: string,
  data: string | Buffer,
): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, data, { flag: "wx", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await chmod(path, 0o600);
}

export async function createRunArtifacts(
  runId: string,
  root = resolve("artifacts/runs"),
): Promise<RunArtifacts> {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error("run id contains unsafe characters");
  }
  const directory = join(root, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const resultPath = join(directory, "result.json");
  const screenshotPath = join(directory, "landing.png");
  return {
    directory,
    resultPath,
    screenshotPath,
    writeResult: async (result) => {
      await atomicPrivateWrite(
        resultPath,
        `${JSON.stringify(result, null, 2)}\n`,
      );
    },
    writeScreenshot: async (png) => {
      await atomicPrivateWrite(screenshotPath, png);
    },
  };
}
