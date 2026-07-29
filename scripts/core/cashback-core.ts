import { CashbackError } from "./errors.js";

export const CASHBACK_PLATFORMS = ["rakuten", "ibotta"] as const;

export type CashbackPlatform = (typeof CASHBACK_PLATFORMS)[number];
export type CashbackRunStatus = "success" | "partial" | "failed";

export interface CashbackCliOptions {
  platform: CashbackPlatform;
  merchant: string;
  expectedDomain: string;
}

interface RunStatusInput {
  activationProven: boolean;
  landingVerified: boolean;
  failureCode: string | null;
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      `${flag} requires a value`,
    );
  }
  return value;
}

function normalizeExpectedDomain(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !candidate ||
    candidate.includes("/") ||
    candidate.includes(":") ||
    candidate.includes(" ")
  ) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "--expected-domain must be a hostname",
    );
  }

  try {
    const url = new URL(`https://${candidate}`);
    if (url.hostname !== candidate || !candidate.includes(".")) {
      throw new Error("invalid hostname");
    }
  } catch {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "--expected-domain must be a hostname",
    );
  }

  return candidate;
}

export function parseCashbackCliOptions(args: string[]): CashbackCliOptions {
  let platform = "";
  let merchant = "";
  let expectedDomain = "";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--platform") {
      platform = takeValue(args, index, "--platform");
      index += 1;
    } else if (argument === "--merchant") {
      merchant = takeValue(args, index, "--merchant");
      index += 1;
    } else if (argument === "--expected-domain") {
      expectedDomain = takeValue(args, index, "--expected-domain");
      index += 1;
    } else {
      throw new CashbackError(
        "CONFIG_INVALID",
        "config",
        `unknown argument ${argument}`,
      );
    }
  }

  if (!platform) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "--platform is required",
    );
  }
  if (!CASHBACK_PLATFORMS.includes(platform as CashbackPlatform)) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      `unknown platform ${platform}`,
    );
  }
  if (!merchant) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "--merchant is required",
    );
  }
  if (!expectedDomain) {
    throw new CashbackError(
      "CONFIG_INVALID",
      "config",
      "--expected-domain is required",
    );
  }

  return {
    platform: platform as CashbackPlatform,
    merchant,
    expectedDomain: normalizeExpectedDomain(expectedDomain),
  };
}

export function matchesExpectedDomain(
  value: string,
  expectedDomain: string,
): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    const expected = expectedDomain.toLowerCase().replace(/\.$/, "");
    return hostname === expected || hostname.endsWith(`.${expected}`);
  } catch {
    return false;
  }
}

export function sanitizeConsoleUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

export function classifyRunStatus({
  activationProven,
  landingVerified,
  failureCode,
}: RunStatusInput): CashbackRunStatus {
  if (activationProven && landingVerified && !failureCode) {
    return "success";
  }
  return activationProven ? "partial" : "failed";
}
