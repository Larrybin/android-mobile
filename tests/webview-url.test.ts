import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAppProcessIds,
  parseDevToolsSockets,
  selectCurrentPage,
  withAdbForward,
} from "../scripts/webview-url.js";
import { CashbackError } from "../scripts/core/errors.js";

test("parseAppProcessIds includes the app process and its subprocesses", () => {
  const output = [
    "PID NAME",
    "812 com.android.systemui",
    "1201 com.ebates",
    "1210 com.ebates:sandboxed_process0",
    "1300 com.other.app",
  ].join("\n");

  assert.deepEqual(parseAppProcessIds(output, "com.ebates"), [1201, 1210]);
});

test("parseDevToolsSockets returns only sockets owned by app process ids", () => {
  const output = [
    "Num RefCount Protocol Flags Type St Inode Path",
    "000: 2 0 00010000 1 01 100 @webview_devtools_remote_1201",
    "001: 2 0 00010000 1 01 101 @webview_devtools_remote_1210",
    "002: 2 0 00010000 1 01 102 @webview_devtools_remote_1300",
    "003: 2 0 00010000 1 01 103 @chrome_devtools_remote",
  ].join("\n");

  assert.deepEqual(parseDevToolsSockets(output, [1201, 1210]), [
    "webview_devtools_remote_1201",
    "webview_devtools_remote_1210",
  ]);
});

test("selectCurrentPage ignores non-http targets and returns one page", () => {
  assert.deepEqual(
    selectCurrentPage([
      {
        id: "blank",
        type: "page",
        title: "",
        url: "about:blank",
      },
      {
        id: "merchant",
        type: "page",
        title: "Macy's",
        url: "https://www.macys.com/shop",
      },
    ]),
    {
      id: "merchant",
      type: "page",
      title: "Macy's",
      url: "https://www.macys.com/shop",
    },
  );
});

test("selectCurrentPage prefers the focused visible page", () => {
  assert.deepEqual(
    selectCurrentPage([
      {
        id: "old",
        type: "page",
        title: "Old",
        url: "https://example.com/old",
        visibilityState: "visible",
        hasFocus: false,
      },
      {
        id: "current",
        type: "page",
        title: "Current",
        url: "https://example.com/current",
        visibilityState: "visible",
        hasFocus: true,
      },
    ]).id,
    "current",
  );
});

test("selectCurrentPage rejects missing and ambiguous active pages", () => {
  assert.throws(
    () =>
      selectCurrentPage([
        { id: "blank", type: "page", title: "", url: "about:blank" },
      ]),
    (error: unknown) =>
      error instanceof CashbackError && error.code === "NO_HTTP_PAGE",
  );

  assert.throws(
    () =>
      selectCurrentPage([
        {
          id: "one",
          type: "page",
          title: "One",
          url: "https://example.com/one",
          visibilityState: "visible",
          hasFocus: false,
        },
        {
          id: "two",
          type: "page",
          title: "Two",
          url: "https://example.com/two",
          visibilityState: "visible",
          hasFocus: false,
        },
      ]),
    (error: unknown) =>
      error instanceof CashbackError &&
      error.code === "MULTIPLE_ACTIVE_PAGES",
  );
});

test("withAdbForward always removes the temporary forward", async () => {
  const calls: string[][] = [];
  const runAdb = async (args: string[]) => {
    calls.push(args);
    return "";
  };

  await assert.rejects(
    withAdbForward(
      "emulator-5554",
      19223,
      "webview_devtools_remote_1201",
      runAdb,
      async () => {
        throw new Error("target fetch failed");
      },
    ),
    /target fetch failed/,
  );

  assert.deepEqual(calls, [
    [
      "-s",
      "emulator-5554",
      "forward",
      "tcp:19223",
      "localabstract:webview_devtools_remote_1201",
    ],
    ["-s", "emulator-5554", "forward", "--remove", "tcp:19223"],
  ]);
});
