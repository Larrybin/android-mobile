import type {
  CashbackPlatform,
} from "./core/cashback-core.js";
import { CashbackError } from "./core/errors.js";
import type { UiSelector } from "./core/android-ui-core.js";

export interface PlatformCalibration {
  home: readonly UiSelector[];
  loginRequired: readonly UiSelector[];
  searchEntry: readonly UiSelector[];
  searchInput: readonly UiSelector[];
  cashbackPattern: RegExp;
  activate: readonly UiSelector[];
  activationProof: readonly UiSelector[];
  activationProofPattern: RegExp;
  handoff: "chrome" | "app-webview";
}

export interface PlatformVersion {
  version: string;
  versionCode: string;
  calibration: PlatformCalibration | null;
}

export interface PlatformSpec {
  packageName: string;
  versions: readonly PlatformVersion[];
}

export type PlatformSpecs = Record<CashbackPlatform, PlatformSpec>;

export interface InstalledApp {
  packageName: string;
  versionName: string;
  versionCode: string;
}

export const PLATFORM_SPECS: PlatformSpecs = {
  rakuten: {
    packageName: "com.ebates",
    versions: [
      {
        version: "13.13.1",
        versionCode: "13130101",
        calibration: {
          home: [
            {
              resourceId:
                "com.ebates:id/navigation_bar_item_large_label_view",
              text: "Home",
            },
          ],
          loginRequired: [],
          searchEntry: [
            {
              className: "android.widget.EditText",
              clickable: true,
            },
          ],
          searchInput: [
            {
              className: "android.widget.EditText",
              clickable: true,
            },
          ],
          cashbackPattern: /\b(?:up to )?\d+(?:\.\d+)?% Cash Back\b/i,
          activate: [
            {
              className: "android.widget.Button",
              text: "Shop Now",
              clickable: true,
            },
          ],
          activationProof: [
            {
              resourceId: "com.ebates:id/cashBackTextView",
            },
          ],
          activationProofPattern:
            /\b\d+(?:\.\d+)?% Cash Back Activated\b/i,
          handoff: "app-webview",
        },
      },
    ],
  },
  ibotta: {
    packageName: "com.ibotta.android",
    versions: [
      {
        version: "6.346.1",
        versionCode: "164977",
        calibration: null,
      },
    ],
  },
};

export function parseInstalledApp(
  dumpsys: string,
  packageName: string,
): InstalledApp {
  const versionName = dumpsys.match(/^\s*versionName=(\S+)\s*$/m)?.[1];
  const versionCode = dumpsys.match(/^\s*versionCode=(\d+)\b/m)?.[1];
  if (!dumpsys.includes(`Package [${packageName}]`) || !versionName || !versionCode) {
    throw new CashbackError(
      "APP_METADATA_INVALID",
      "app",
      `could not read version metadata for ${packageName}`,
    );
  }
  return { packageName, versionName, versionCode };
}

export function resolvePlatformCalibration(
  platform: CashbackPlatform,
  installed: Pick<InstalledApp, "versionName" | "versionCode">,
  specs: PlatformSpecs = PLATFORM_SPECS,
): PlatformCalibration {
  const profile = specs[platform].versions.find(
    (candidate) =>
      candidate.version === installed.versionName &&
      candidate.versionCode === installed.versionCode,
  );
  if (!profile) {
    throw new CashbackError(
      "APP_VERSION_UNSUPPORTED",
      "app",
      `${platform} ${installed.versionName} (${installed.versionCode}) is not a calibrated app version`,
    );
  }
  if (!profile.calibration) {
    throw new CashbackError(
      "PLATFORM_NOT_CALIBRATED",
      "app",
      `${platform} ${installed.versionName} (${installed.versionCode}) has no verified accessibility calibration`,
    );
  }
  return profile.calibration;
}
