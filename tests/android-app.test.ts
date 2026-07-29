import assert from "node:assert/strict";
import test from "node:test";

import {
  launchAndroidApp,
  parseLauncherActivity,
} from "../scripts/runtime/android-app.js";

test("parseLauncherActivity returns the resolved package component", () => {
  assert.equal(
    parseLauncherActivity(
      "priority=0\ncom.ebates/.activity.MainActivity\n",
      "com.ebates",
    ),
    "com.ebates/.activity.MainActivity",
  );
  assert.throws(
    () => parseLauncherActivity("No activity found", "com.ebates"),
    /launcher activity was not resolved/,
  );
});

test("launchAndroidApp resolves and starts the launcher activity", async () => {
  const calls: string[][] = [];
  await launchAndroidApp(
    "emulator-5554",
    "com.ebates",
    async (_command, args) => {
      calls.push(args);
      return args.includes("resolve-activity")
        ? "com.ebates/.activity.MainActivity"
        : "Status: ok";
    },
  );

  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.includes("resolve-activity"));
  assert.deepEqual(calls[1]?.slice(-4), [
    "start",
    "-W",
    "-n",
    "com.ebates/.activity.MainActivity",
  ]);
});
