import { setTimeout as delay } from "node:timers/promises";

import {
  findNearestMatchingText,
  findUniqueExactText,
  selectFirstNode,
  type UiNode,
  type UiSelector,
} from "../core/android-ui-core.js";
import type { CashbackPlatform } from "../core/cashback-core.js";
import { CashbackError } from "../core/errors.js";
import {
  PLATFORM_SPECS,
  parseInstalledApp,
  resolvePlatformCalibration,
  type InstalledApp,
  type PlatformCalibration,
  type PlatformSpecs,
} from "../platforms.js";
import { runCommand, type CommandOptions } from "./command.js";
import { launchAndroidApp } from "./android-app.js";
import type { AndroidUi } from "./android-ui.js";

type TextRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<string>;

export interface UiController {
  readNodes(): Promise<UiNode[]>;
  readStableNodes(options?: {
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<UiNode[]>;
  tap(node: UiNode): Promise<void>;
  inputText(value: string): Promise<void>;
}

export interface MerchantSelection {
  selectedMerchant: string;
  cashbackText: string;
  handoff: "chrome" | "app-webview";
}

function requireNode(
  nodes: UiNode[],
  selectors: readonly UiSelector[],
  code: string,
  message: string,
): UiNode {
  const selected = selectFirstNode(nodes, selectors);
  if (!selected) {
    throw new CashbackError(code, "ui", message);
  }
  return selected;
}

function evidenceText(node: UiNode): string {
  return node.text ?? node.contentDescription ?? node.resourceId ?? "visible";
}

export class CashbackPlatformDriver {
  private calibration?: PlatformCalibration;

  constructor(
    readonly platform: CashbackPlatform,
    private readonly serial: string,
    private readonly ui: UiController | AndroidUi,
    private readonly textRunner: TextRunner = runCommand,
    private readonly specs: PlatformSpecs = PLATFORM_SPECS,
  ) {}

  get packageName(): string {
    return this.specs[this.platform].packageName;
  }

  private adbArgs(args: string[]): string[] {
    return ["-s", this.serial, ...args];
  }

  async initialize(): Promise<InstalledApp> {
    const dumpsys = await this.textRunner(
      "adb",
      this.adbArgs(["shell", "dumpsys", "package", this.packageName]),
      { stage: "app", maxStdoutBytes: 4 * 1024 * 1024 },
    );
    const installed = parseInstalledApp(dumpsys, this.packageName);
    this.calibration = resolvePlatformCalibration(
      this.platform,
      installed,
      this.specs,
    );

    await launchAndroidApp(
      this.serial,
      this.packageName,
      this.textRunner,
      "app",
    );

    const nodes = await this.ui.readStableNodes();
    if (selectFirstNode(nodes, this.calibration.loginRequired)) {
      throw new CashbackError(
        "LOGIN_REQUIRED",
        "app",
        `${this.platform} is not logged in`,
      );
    }
    requireNode(
      nodes,
      this.calibration.home,
      "APP_HOME_NOT_FOUND",
      `${this.platform} logged-in home was not found`,
    );
    return installed;
  }

  async selectMerchant(merchant: string): Promise<MerchantSelection> {
    const calibration = this.requireCalibration();
    const home = await this.ui.readStableNodes();
    await this.ui.tap(
      requireNode(
        home,
        calibration.searchEntry,
        "SEARCH_NOT_FOUND",
        `${this.platform} search entry was not found`,
      ),
    );

    const search = await this.ui.readStableNodes();
    await this.ui.tap(
      requireNode(
        search,
        calibration.searchInput,
        "SEARCH_INPUT_NOT_FOUND",
        `${this.platform} search input was not found`,
      ),
    );
    await this.ui.inputText(merchant);

    const results = await this.ui.readStableNodes();
    const merchantNode = findUniqueExactText(results, merchant);
    const cashbackNode = findNearestMatchingText(
      results,
      merchantNode,
      calibration.cashbackPattern,
    );
    const cashbackText = evidenceText(cashbackNode);
    if (!calibration.cashbackPattern.test(cashbackText)) {
      throw new CashbackError(
        "CASHBACK_TEXT_INVALID",
        "ui",
        `cashback text did not match the calibrated format: ${cashbackText}`,
      );
    }

    return {
      selectedMerchant: evidenceText(merchantNode),
      cashbackText,
      handoff: calibration.handoff,
    };
  }

  async activate(): Promise<{ kind: "ui"; text: string }> {
    const calibration = this.requireCalibration();
    const detail = await this.ui.readStableNodes();
    await this.ui.tap(
      requireNode(
        detail,
        calibration.activate,
        "ACTIVATE_NOT_FOUND",
        `${this.platform} activation control was not found`,
      ),
    );

    const deadline = Date.now() + 15_000;
    while (Date.now() <= deadline) {
      const nodes = await this.ui.readNodes();
      const proof = selectFirstNode(nodes, calibration.activationProof);
      if (proof) {
        const text = proof.text ?? proof.contentDescription ?? "";
        if (calibration.activationProofPattern.test(text)) {
          return { kind: "ui", text };
        }
      }
      await delay(250);
    }
    throw new CashbackError(
      "ACTIVATION_NOT_PROVEN",
      "ui",
      `${this.platform} activation proof did not appear`,
    );
  }

  private requireCalibration(): PlatformCalibration {
    if (!this.calibration) {
      throw new CashbackError(
        "DRIVER_NOT_INITIALIZED",
        "app",
        `${this.platform} driver is not initialized`,
      );
    }
    return this.calibration;
  }
}
