import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRunArtifacts,
  type CashbackRunResult,
} from "../scripts/runtime/artifacts.js";

function result(runId: string): CashbackRunResult {
  return {
    runId,
    status: "success",
    failureCode: null,
    platform: "rakuten",
    appPackage: "com.ebates",
    appVersion: "1.2.3",
    merchantInput: "Nike",
    selectedMerchant: "Nike",
    cashbackText: "8% Cash Back",
    startedAt: "2026-07-29T00:00:00.000Z",
    activatedAt: "2026-07-29T00:00:01.000Z",
    completedAt: "2026-07-29T00:00:02.000Z",
    proxyExit: { ip: "203.0.113.1", country: "US" },
    device: {
      serial: "emulator-5554",
      avdName: "cashback-phase0",
      apiLevel: "35",
      abi: "arm64-v8a",
    },
    activationEvidence: { kind: "ui", text: "Activated" },
    handoffEvidence: { kind: "chrome", observed: true },
    redirects: [
      {
        sequence: 1,
        url: "https://click.example/?token=secret",
        source: "chrome",
        timestamp: "2026-07-29T00:00:01.000Z",
      },
    ],
    finalUrl: "https://nike.com/?token=secret",
    lastObservedUrl: "https://nike.com/?token=secret",
    screenshotPaths: ["landing.png"],
    startedResources: ["gost", "emulator", "cdp"],
    error: null,
  };
}

test("run artifacts use private permissions and preserve full URLs locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "cashback-artifacts-test-"));
  const artifacts = await createRunArtifacts("run-1", root);
  await artifacts.writeResult(result("run-1"));
  await artifacts.writeScreenshot(Buffer.from("png"));

  assert.equal((await stat(artifacts.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(artifacts.resultPath)).mode & 0o777, 0o600);
  assert.equal((await stat(artifacts.screenshotPath)).mode & 0o777, 0o600);
  assert.match(await readFile(artifacts.resultPath, "utf8"), /token=secret/);
});

test("run artifacts reject unsafe run ids and support the default root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cashback-artifacts-test-"));
  await assert.rejects(
    createRunArtifacts("../escape", root),
    /unsafe characters/,
  );

  const runId = `test-${Date.now()}`;
  const artifacts = await createRunArtifacts(runId);
  try {
    assert.match(artifacts.directory, /artifacts\/runs\/test-/);
  } finally {
    await rm(artifacts.directory, { recursive: true, force: true });
  }
});
