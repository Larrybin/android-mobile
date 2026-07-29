import assert from "node:assert/strict";
import test from "node:test";

import { AndroidUi } from "../scripts/runtime/android-ui.js";
import { CashbackError } from "../scripts/core/errors.js";

const xml =
  '<hierarchy><node text="Nike" resource-id="merchant" clickable="true" bounds="[0,0][20,10]" /></hierarchy>';

test("AndroidUi waits for two identical dumps before returning nodes", async () => {
  const outputs = ["", xml, "", `${xml}\n`, "", xml];
  const calls: string[][] = [];
  const ui = new AndroidUi(
    "emulator-5554",
    async (_command, args) => {
      calls.push(args);
      return outputs.shift() ?? "";
    },
    async () => Buffer.from("png"),
    async () => {},
  );

  const nodes = await ui.readStableNodes({ timeoutMs: 100, intervalMs: 0 });
  assert.equal(nodes[0]?.text, "Nike");
  assert.equal(calls.length, 4);
});

test("AndroidUi ignores rotating EditText placeholder text", async () => {
  const first =
    '<hierarchy><node text="" class="android.widget.EditText" clickable="true" bounds="[0,0][100,20]"><node text="" class="androidx.compose.ui.viewinterop.ViewFactoryHolder" bounds="[20,2][60,18]"><node text="Try searching Expedia" class="android.widget.TextView" bounds="[20,2][60,18]" /></node></node></hierarchy>';
  const second =
    '<hierarchy><node text="" class="android.widget.EditText" clickable="true" bounds="[0,0][100,20]"><node text="" class="androidx.compose.ui.viewinterop.ViewFactoryHolder" bounds="[20,2][80,18]"><node text="Try searching Nike" class="android.widget.TextView" bounds="[20,2][80,18]" /></node></node></hierarchy>';
  const outputs = ["", first, "", second];
  const ui = new AndroidUi(
    "emulator-5554",
    async () => outputs.shift() ?? "",
    async () => Buffer.from("png"),
    async () => {},
  );

  const nodes = await ui.readStableNodes({
    timeoutMs: 100,
    intervalMs: 0,
  });

  assert.equal(nodes[2]?.text, "Try searching Nike");
});

test("AndroidUi derives taps from bounds and rejects unsafe text input", async () => {
  const calls: string[][] = [];
  const ui = new AndroidUi(
    "emulator-5554",
    async (_command, args) => {
      calls.push(args);
      return "";
    },
    async () => Buffer.alloc(0),
    async () => {},
  );

  await ui.tap({
    text: "Nike",
    clickable: true,
    bounds: { left: 0, top: 2, right: 20, bottom: 12 },
  });
  assert.deepEqual(calls[0]?.slice(-4), ["input", "tap", "10", "7"]);

  await assert.rejects(
    ui.inputText("Nike; reboot"),
    (error: unknown) =>
      error instanceof CashbackError && error.code === "INPUT_UNSUPPORTED",
  );
});
