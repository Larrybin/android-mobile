import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
  defaultRunId,
  executeCashback,
  productionArtifacts,
  type CashbackRunDependencies,
} from "../scripts/runtime/run-cashback.js";
import { CashbackError } from "../scripts/core/errors.js";
import type { CashbackRunResult } from "../scripts/runtime/artifacts.js";

function dependencies(
  overrides: Partial<CashbackRunDependencies> = {},
): {
  dependencies: CashbackRunDependencies;
  calls: string[];
  written: CashbackRunResult[];
} {
  const calls: string[] = [];
  const written: CashbackRunResult[] = [];
  let tick = 0;
  const base: CashbackRunDependencies = {
    runId: () => "run-1",
    now: () => new Date(1_000 + tick++ * 1_000).toISOString(),
    createArtifacts: async () => ({
      directory: "/tmp/run-1",
      resultPath: "/tmp/run-1/result.json",
      screenshotPath: "/tmp/run-1/landing.png",
      writeResult: async (result) => {
        written.push(structuredClone(result));
      },
      writeScreenshot: async () => {
        calls.push("screenshot");
      },
    }),
    startSession: async () => ({
      avdName: "cashback-phase0",
      serial: "emulator-5554",
      apiLevel: "35",
      abi: "arm64-v8a",
      exitInfo: { ip: "203.0.113.1", country: "US" },
      startedResources: ["gost", "emulator"],
      stop: async () => {
        calls.push("session.stop");
      },
    }),
    createObserver: () => ({
      start: async () => {
        calls.push("observer.start");
      },
      attachAppWebView: async () => {
        calls.push("observer.attach-webview");
      },
      verifyDeviceExit: async (exit) => exit,
      beginCapture: () => {
        calls.push("observer.begin");
      },
      waitForLanding: async () => {
        calls.push("observer.wait");
        return {
          redirects: [],
          finalUrl: "https://nike.com/",
          handoff: "chrome",
        };
      },
      snapshot: () => ({
        redirects: [],
        lastObservedUrl: "https://nike.com/",
        handoffObserved: true,
        handoff: "chrome",
      }),
      close: async () => {
        calls.push("observer.close");
      },
    }),
    createDriver: () => ({
      packageName: "com.ebates",
      initialize: async () => ({
        packageName: "com.ebates",
        versionName: "1.0",
        versionCode: "10",
      }),
      selectMerchant: async () => ({
        selectedMerchant: "Nike",
        cashbackText: "8% Cash Back",
        handoff: "chrome",
      }),
      activate: async () => {
        calls.push("driver.activate");
        return { kind: "ui", text: "Activated" };
      },
    }),
    captureScreenshot: async () => Buffer.from("png"),
  };
  return {
    dependencies: { ...base, ...overrides },
    calls,
    written,
  };
}

const options = {
  platform: "rakuten" as const,
  merchant: "Nike",
  expectedDomain: "nike.com",
};

test("successful run arms capture before activation and keeps the session", async () => {
  const fixture = dependencies();
  const execution = await executeCashback(
    options,
    fixture.dependencies,
    new AbortController().signal,
  );

  assert.equal(execution.result.status, "success");
  assert.equal(execution.keepSession, true);
  assert.ok(
    fixture.calls.indexOf("observer.begin") <
      fixture.calls.indexOf("driver.activate"),
  );
  assert.equal(fixture.written.at(-1)?.finalUrl, "https://nike.com/");
  await execution.stop();
  assert.ok(fixture.calls.includes("observer.close"));
  assert.ok(fixture.calls.includes("session.stop"));
});

test("pre-activation failures clean resources and return failed evidence", async () => {
  const fixture = dependencies({
    createDriver: () => ({
      packageName: "com.ebates",
      initialize: async () => {
        throw new CashbackError("LOGIN_REQUIRED", "app", "not logged in");
      },
      selectMerchant: async () => {
        throw new Error("unreachable");
      },
      activate: async () => {
        throw new Error("unreachable");
      },
    }),
  });
  const execution = await executeCashback(
    options,
    fixture.dependencies,
    new AbortController().signal,
  );

  assert.equal(execution.result.status, "failed");
  assert.equal(execution.result.failureCode, "LOGIN_REQUIRED");
  assert.equal(execution.keepSession, false);
  assert.ok(fixture.calls.includes("observer.close"));
  assert.ok(fixture.calls.includes("session.stop"));
});

test("post-activation capture failures are partial and keep the session", async () => {
  const fixture = dependencies({
    createObserver: () => ({
      start: async () => {},
      attachAppWebView: async () => {},
      verifyDeviceExit: async (exit) => exit,
      beginCapture: () => {},
      waitForLanding: async () => {
        throw new CashbackError(
          "LANDING_TIMEOUT",
          "capture",
          "landing timed out",
        );
      },
      snapshot: () => ({
        redirects: [
          {
            sequence: 1,
            url: "https://affiliate.example/",
            source: "chrome",
            timestamp: "2026-07-29T00:00:00.000Z",
          },
        ],
        lastObservedUrl: "https://affiliate.example/",
        handoffObserved: true,
        handoff: null,
      }),
      close: async () => {
        fixture.calls.push("observer.close");
      },
    }),
  });
  const execution = await executeCashback(
    options,
    fixture.dependencies,
    new AbortController().signal,
  );

  assert.equal(execution.result.status, "partial");
  assert.equal(execution.result.failureCode, "LANDING_TIMEOUT");
  assert.equal(execution.keepSession, true);
  assert.equal(execution.result.finalUrl, null);
  assert.equal(
    execution.result.lastObservedUrl,
    "https://affiliate.example/",
  );
  assert.deepEqual(execution.result.handoffEvidence, {
    kind: "chrome",
    observed: true,
  });
  assert.equal(fixture.calls.includes("session.stop"), false);
  await execution.stop();
});

test("WebView handoff attaches its observer before activation", async () => {
  const fixture = dependencies({
    createDriver: () => ({
      packageName: "com.ebates",
      initialize: async () => ({
        packageName: "com.ebates",
        versionName: "1.0",
        versionCode: "10",
      }),
      selectMerchant: async () => ({
        selectedMerchant: "Nike",
        cashbackText: "8% Cash Back",
        handoff: "app-webview",
      }),
      activate: async () => ({ kind: "ui", text: "Activated" }),
    }),
  });
  const execution = await executeCashback(
    options,
    fixture.dependencies,
    new AbortController().signal,
  );

  assert.equal(execution.result.status, "success");
  assert.ok(
    fixture.calls.indexOf("observer.attach-webview") <
      fixture.calls.indexOf("observer.begin"),
  );
});

test("WebView readiness failure prevents activation", async () => {
  const fixture = dependencies({
    createObserver: () => ({
      start: async () => {},
      attachAppWebView: async () => {
        throw new CashbackError(
          "WEBVIEW_DEBUG_UNAVAILABLE",
          "capture",
          "WebView page target was not ready before activation",
        );
      },
      verifyDeviceExit: async (exit) => exit,
      beginCapture: () => {
        fixture.calls.push("observer.begin");
      },
      waitForLanding: async () => {
        throw new Error("unreachable");
      },
      close: async () => {},
    }),
    createDriver: () => ({
      packageName: "com.ebates",
      initialize: async () => ({
        packageName: "com.ebates",
        versionName: "1.0",
        versionCode: "10",
      }),
      selectMerchant: async () => ({
        selectedMerchant: "Nike",
        cashbackText: "8% Cash Back",
        handoff: "app-webview",
      }),
      activate: async () => {
        fixture.calls.push("driver.activate");
        return { kind: "ui", text: "Activated" };
      },
    }),
  });

  const execution = await executeCashback(
    options,
    fixture.dependencies,
    new AbortController().signal,
  );

  assert.equal(execution.result.status, "failed");
  assert.equal(
    execution.result.failureCode,
    "WEBVIEW_DEBUG_UNAVAILABLE",
  );
  assert.equal(fixture.calls.includes("observer.begin"), false);
  assert.equal(fixture.calls.includes("driver.activate"), false);
});

test("a wrong final domain becomes partial after activation", async () => {
  const fixture = dependencies({
    createObserver: () => ({
      start: async () => {},
      attachAppWebView: async () => {},
      verifyDeviceExit: async (exit) => exit,
      beginCapture: () => {},
      waitForLanding: async () => ({
        redirects: [],
        finalUrl: "https://wrong.example/",
        handoff: "chrome",
      }),
      snapshot: () => ({
        redirects: [],
        lastObservedUrl: "https://wrong.example/",
        handoffObserved: false,
        handoff: null,
      }),
      close: async () => {},
    }),
  });
  const execution = await executeCashback(
    options,
    fixture.dependencies,
    new AbortController().signal,
  );

  assert.equal(execution.result.status, "partial");
  assert.equal(execution.result.failureCode, "FINAL_DOMAIN_MISMATCH");
  assert.equal(execution.result.finalUrl, null);
  assert.equal(
    execution.result.lastObservedUrl,
    "https://wrong.example/",
  );
  await execution.stop();
});

test("startup and screenshot failures cover evidence cleanup boundaries", async () => {
  const startup = dependencies({
    startSession: async () => {
      throw new CashbackError(
        "PROXY_UNAVAILABLE",
        "proxy",
        "no proxy",
      );
    },
  });
  const failed = await executeCashback(
    options,
    startup.dependencies,
    new AbortController().signal,
  );
  assert.equal(failed.result.failureCode, "PROXY_UNAVAILABLE");
  await failed.stop();

  const screenshot = dependencies({
    captureScreenshot: async () => {
      throw new Error("screenshot failed");
    },
  });
  const partial = await executeCashback(
    options,
    screenshot.dependencies,
    new AbortController().signal,
  );
  assert.equal(partial.result.status, "partial");
  assert.equal(partial.result.failureCode, "UNEXPECTED_ERROR");
  await partial.stop();

  const preActivationScreenshot = dependencies({
    createDriver: () => ({
      packageName: "com.ebates",
      initialize: async () => {
        throw new CashbackError("LOGIN_REQUIRED", "app", "not logged in");
      },
      selectMerchant: async () => {
        throw new Error("unreachable");
      },
      activate: async () => {
        throw new Error("unreachable");
      },
    }),
    captureScreenshot: async () => {
      throw new Error("screenshot failed");
    },
  });
  const evidenceFailed = await executeCashback(
    options,
    preActivationScreenshot.dependencies,
    new AbortController().signal,
  );
  assert.equal(evidenceFailed.result.failureCode, "UNEXPECTED_ERROR");
});

test("artifact write failures are explicit for known and unknown errors", async () => {
  for (const failure of [
    new CashbackError(
      "DISK_FULL",
      "artifact",
      "disk is full",
    ),
    new Error("write failed"),
    "write failed",
  ]) {
    const fixture = dependencies({
      createArtifacts: async () => ({
        directory: "/tmp/run-1",
        resultPath: "/tmp/run-1/result.json",
        screenshotPath: "/tmp/run-1/landing.png",
        writeResult: async () => {
          throw failure;
        },
        writeScreenshot: async () => {},
      }),
    });
    const execution = await executeCashback(
      options,
      fixture.dependencies,
      new AbortController().signal,
    );
    assert.equal(execution.result.status, "partial");
    assert.ok(
      ["DISK_FULL", "ARTIFACT_WRITE_FAILED"].includes(
        execution.result.failureCode ?? "",
      ),
    );
    await execution.stop();
  }

  const beforeActivation = dependencies({
    createArtifacts: async () => ({
      directory: "/tmp/run-1",
      resultPath: "/tmp/run-1/result.json",
      screenshotPath: "/tmp/run-1/landing.png",
      writeResult: async () => {
        throw new Error("write failed");
      },
      writeScreenshot: async () => {},
    }),
    createDriver: () => ({
      packageName: "com.ebates",
      initialize: async () => {
        throw new CashbackError("LOGIN_REQUIRED", "app", "not logged in");
      },
      selectMerchant: async () => {
        throw new Error("unreachable");
      },
      activate: async () => {
        throw new Error("unreachable");
      },
    }),
  });
  const failed = await executeCashback(
    options,
    beforeActivation.dependencies,
    new AbortController().signal,
  );
  assert.equal(failed.result.status, "failed");
});

test("run id and production artifact helpers provide valid local paths", async () => {
  assert.match(
    defaultRunId(),
    /^\d{4}-\d{2}-\d{2}T.+Z-[a-f0-9]{8}$/,
  );
  const artifacts = await productionArtifacts(`test-${Date.now()}`);
  try {
    assert.match(
      artifacts.resultPath,
      /artifacts\/runs\/test-.+\/result\.json$/,
    );
  } finally {
    await rm(artifacts.directory, { recursive: true, force: true });
  }
});
