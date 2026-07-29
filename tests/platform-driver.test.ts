import assert from "node:assert/strict";
import test from "node:test";

import {
  CashbackPlatformDriver,
  type UiController,
} from "../scripts/runtime/platform-driver.js";
import type { UiNode } from "../scripts/core/android-ui-core.js";
import type { PlatformSpecs } from "../scripts/platforms.js";

function node(
  text: string,
  resourceId: string,
): UiNode {
  return {
    text,
    resourceId,
    clickable: true,
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
  };
}

const specs: PlatformSpecs = {
  rakuten: {
    packageName: "com.ebates",
    versions: [
      {
        version: "1.0",
        versionCode: "10",
        calibration: {
          home: [{ resourceId: "home" }],
          loginRequired: [{ resourceId: "login" }],
          searchEntry: [{ resourceId: "search-entry" }],
          searchInput: [{ resourceId: "search-input" }],
          cashbackPattern: /\d+% Cash Back/,
          activate: [{ resourceId: "activate" }],
          activationProof: [{ resourceId: "proof" }],
          activationProofPattern: /Cash Back Activated/,
          handoff: "chrome",
        },
      },
    ],
  },
  ibotta: {
    packageName: "com.ibotta.android",
    versions: [],
  },
};

test("platform driver follows accessibility nodes through activation proof", async () => {
  const screens = [
    [node("Home", "home"), node("Search", "search-entry")],
    [node("Home", "home"), node("Search", "search-entry")],
    [node("", "search-input")],
    [
      node("Nike", "merchant"),
      node("8% Cash Back", "cashback"),
      node("Activate", "activate"),
    ],
    [
      node("8% Cash Back", "cashback"),
      node("Activate", "activate"),
    ],
    [node("", "proof")],
    [node("8% Cash Back Activated", "proof")],
  ];
  const tapped: string[] = [];
  const entered: string[] = [];
  const ui: UiController = {
    readNodes: async () => screens.shift() ?? [],
    readStableNodes: async () => screens.shift() ?? [],
    tap: async (selected) => {
      tapped.push(selected.resourceId ?? "");
    },
    inputText: async (value) => {
      entered.push(value);
    },
  };
  const adb = async (_command: string, args: string[]) => {
    if (args.includes("dumpsys")) {
      return [
        "Package [com.ebates]",
        "versionCode=10 minSdk=24",
        "versionName=1.0",
      ].join("\n");
    }
    if (args.includes("resolve-activity")) {
      return "com.ebates/.activity.MainActivity";
    }
    return "";
  };
  const driver = new CashbackPlatformDriver(
    "rakuten",
    "emulator-5554",
    ui,
    adb,
    specs,
  );

  const app = await driver.initialize();
  const merchant = await driver.selectMerchant("Nike");
  const activation = await driver.activate();

  assert.equal(app.versionName, "1.0");
  assert.deepEqual(merchant, {
    selectedMerchant: "Nike",
    cashbackText: "8% Cash Back",
    handoff: "chrome",
  });
  assert.deepEqual(activation, {
    kind: "ui",
    text: "8% Cash Back Activated",
  });
  assert.deepEqual(tapped, [
    "search-entry",
    "search-input",
    "activate",
  ]);
  assert.deepEqual(entered, ["Nike"]);
});
