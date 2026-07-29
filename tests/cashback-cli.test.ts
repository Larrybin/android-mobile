import assert from "node:assert/strict";
import test from "node:test";

import { normalizeScriptArgs } from "../scripts/cashback-run.js";

test("cashback CLI accepts pnpm's leading argument separator", () => {
  assert.deepEqual(
    normalizeScriptArgs(["--", "--platform", "rakuten"]),
    ["--platform", "rakuten"],
  );
  assert.deepEqual(
    normalizeScriptArgs(["--platform", "rakuten"]),
    ["--platform", "rakuten"],
  );
});
