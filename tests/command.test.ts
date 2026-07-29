import assert from "node:assert/strict";
import test from "node:test";

import {
  runCommand,
  runCommandBuffer,
} from "../scripts/runtime/command.js";
import { CashbackError } from "../scripts/core/errors.js";

test("runCommand returns trimmed stdout and enforces the output limit", async () => {
  assert.equal(
    await runCommand(process.execPath, ["-e", "process.stdout.write(' ok ')"]),
    "ok",
  );

  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.stdout.write('12345')"], {
      maxStdoutBytes: 4,
    }),
    (error: unknown) =>
      error instanceof CashbackError && error.code === "COMMAND_OUTPUT_LIMIT",
  );
});

test("runCommand reports exit, timeout, and cancellation with stable codes", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.exit(7)"]),
    (error: unknown) =>
      error instanceof CashbackError && error.code === "COMMAND_FAILED",
  );

  await assert.rejects(
    runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
      timeoutMs: 10,
    }),
    (error: unknown) =>
      error instanceof CashbackError && error.code === "COMMAND_TIMEOUT",
  );

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(
    runCommand(process.execPath, ["-e", ""], {
      signal: abortController.signal,
    }),
    (error: unknown) =>
      error instanceof CashbackError && error.code === "INTERRUPTED",
  );
});

test("runCommandBuffer preserves binary output", async () => {
  const output = await runCommandBuffer(process.execPath, [
    "-e",
    "process.stdout.write(Buffer.from([0, 1, 2, 255]))",
  ]);

  assert.deepEqual(output, Buffer.from([0, 1, 2, 255]));
});
