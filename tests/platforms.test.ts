import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_SPECS,
  parseInstalledApp,
  resolvePlatformCalibration,
  type PlatformCalibration,
} from "../scripts/platforms.js";
import { CashbackError } from "../scripts/core/errors.js";

test("platform registry pins packages and only known app versions", () => {
  assert.equal(PLATFORM_SPECS.rakuten.packageName, "com.ebates");
  assert.equal(PLATFORM_SPECS.ibotta.packageName, "com.ibotta.android");
  assert.deepEqual(PLATFORM_SPECS.ibotta.versions.map((item) => item.version), [
    "6.346.1",
  ]);
  assert.equal(PLATFORM_SPECS.ibotta.versions[0]?.versionCode, "164977");
});

test("parseInstalledApp reads version metadata from dumpsys", () => {
  assert.deepEqual(
    parseInstalledApp(
      [
        "Packages:",
        "  Package [com.ebates]",
        "    versionCode=123 minSdk=24 targetSdk=35",
        "    versionName=12.3.0",
      ].join("\n"),
      "com.ebates",
    ),
    {
      packageName: "com.ebates",
      versionName: "12.3.0",
      versionCode: "123",
    },
  );
});

test("resolvePlatformCalibration refuses unknown and uncalibrated versions", () => {
  assert.throws(
    () =>
      resolvePlatformCalibration("rakuten", {
        versionName: "999",
        versionCode: "1",
      }),
    (error: unknown) =>
      error instanceof CashbackError &&
      error.code === "APP_VERSION_UNSUPPORTED",
  );
  assert.throws(
    () =>
      resolvePlatformCalibration("ibotta", {
        versionName: "6.346.1",
        versionCode: "164977",
      }),
    (error: unknown) =>
      error instanceof CashbackError &&
      error.code === "PLATFORM_NOT_CALIBRATED",
  );
});

test("resolvePlatformCalibration returns a complete typed profile", () => {
  const calibration: PlatformCalibration = {
    home: [{ resourceId: "home" }],
    loginRequired: [{ text: "Sign in" }],
    searchEntry: [{ contentDescription: "Search" }],
    searchInput: [{ resourceId: "search" }],
    cashbackPattern: /cash back/i,
    activate: [{ text: "Activate" }],
    activationProof: [{ text: "Activated" }],
    activationProofPattern: /Activated/,
    handoff: "chrome",
  };

  assert.equal(
    resolvePlatformCalibration(
      "rakuten",
      { versionName: "1.0", versionCode: "10" },
      {
        rakuten: {
          packageName: "com.ebates",
          versions: [
            { version: "1.0", versionCode: "10", calibration },
          ],
        },
        ibotta: PLATFORM_SPECS.ibotta,
      },
    ),
    calibration,
  );
});
