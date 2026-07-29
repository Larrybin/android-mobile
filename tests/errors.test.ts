import assert from "node:assert/strict";
import test from "node:test";

import {
  CashbackError,
  toCashbackError,
} from "../scripts/core/errors.js";

test("CashbackError keeps stable code, stage, cause, and evidence paths", () => {
  const cause = new Error("adb failed");
  const error = new CashbackError(
    "DEVICE_NOT_FOUND",
    "device",
    "emulator is unavailable",
    {
      cause,
      evidencePaths: ["/tmp/device.png"],
    },
  );

  assert.equal(error.code, "DEVICE_NOT_FOUND");
  assert.equal(error.stage, "device");
  assert.equal(error.cause, cause);
  assert.deepEqual(error.evidencePaths, ["/tmp/device.png"]);
});

test("toCashbackError preserves known errors and wraps unknown failures", () => {
  const known = new CashbackError("LOGIN_REQUIRED", "app", "login first");
  assert.deepEqual(known.evidencePaths, []);
  assert.equal(known.cause, undefined);
  assert.equal(toCashbackError(known, "runtime"), known);

  const wrapped = toCashbackError(new Error("boom"), "capture");
  assert.equal(wrapped.code, "UNEXPECTED_ERROR");
  assert.equal(wrapped.stage, "capture");
  assert.match(wrapped.message, /boom/);
  assert.equal(toCashbackError("plain failure", "runtime").message, "plain failure");
});
