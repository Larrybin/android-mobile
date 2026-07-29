import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRunStatus,
  matchesExpectedDomain,
  parseCashbackCliOptions,
  sanitizeConsoleUrl,
} from "../scripts/core/cashback-core.js";

test("parseCashbackCliOptions requires platform, merchant, and domain", () => {
  assert.deepEqual(
    parseCashbackCliOptions([
      "--platform",
      "rakuten",
      "--merchant",
      "Nike",
      "--expected-domain",
      "nike.com",
    ]),
    {
      platform: "rakuten",
      merchant: "Nike",
      expectedDomain: "nike.com",
    },
  );

  assert.throws(
    () => parseCashbackCliOptions(["--platform", "rakuten"]),
    /--merchant is required/,
  );
  assert.throws(
    () =>
      parseCashbackCliOptions([
        "--platform",
        "unknown",
        "--merchant",
        "Nike",
        "--expected-domain",
        "nike.com",
      ]),
    /unknown platform/,
  );
});

test("parseCashbackCliOptions rejects every malformed CLI boundary", () => {
  assert.throws(() => parseCashbackCliOptions([]), /--platform is required/);
  assert.throws(
    () => parseCashbackCliOptions(["--platform"]),
    /--platform requires a value/,
  );
  assert.throws(
    () => parseCashbackCliOptions(["--unknown"]),
    /unknown argument/,
  );
  assert.throws(
    () =>
      parseCashbackCliOptions([
        "--platform",
        "rakuten",
        "--merchant",
        "Nike",
      ]),
    /--expected-domain is required/,
  );

  for (const domain of [
    "/nike.com",
    "nike.com/path",
    "nike.com:443",
    "nike com",
    "localhost",
  ]) {
    assert.throws(
      () =>
        parseCashbackCliOptions([
          "--platform",
          "rakuten",
          "--merchant",
          "Nike",
          "--expected-domain",
          domain,
        ]),
      /must be a hostname/,
    );
  }

  assert.equal(
    parseCashbackCliOptions([
      "--platform",
      "ibotta",
      "--merchant",
      "Nike",
      "--expected-domain",
      "NIKE.COM.",
    ]).expectedDomain,
    "nike.com",
  );
});

test("matchesExpectedDomain accepts exact hosts and real subdomains only", () => {
  assert.equal(matchesExpectedDomain("https://nike.com/shop", "nike.com"), true);
  assert.equal(
    matchesExpectedDomain("https://www.nike.com/shop", "NIKE.COM."),
    true,
  );
  assert.equal(
    matchesExpectedDomain("https://nike.com.example.test", "nike.com"),
    false,
  );
  assert.equal(matchesExpectedDomain("not a URL", "nike.com"), false);
});

test("sanitizeConsoleUrl removes attribution parameters and fragments", () => {
  assert.equal(
    sanitizeConsoleUrl(
      "https://www.nike.com/shop?click_id=secret#checkout",
    ),
    "https://www.nike.com/shop",
  );
  assert.equal(sanitizeConsoleUrl("not a URL"), "[invalid URL]");
});

test("classifyRunStatus distinguishes failures before and after activation", () => {
  assert.equal(
    classifyRunStatus({
      activationProven: false,
      landingVerified: false,
      failureCode: "LOGIN_REQUIRED",
    }),
    "failed",
  );
  assert.equal(
    classifyRunStatus({
      activationProven: true,
      landingVerified: false,
      failureCode: "REDIRECT_CHAIN_INCOMPLETE",
    }),
    "partial",
  );
  assert.equal(
    classifyRunStatus({
      activationProven: true,
      landingVerified: true,
      failureCode: null,
    }),
    "success",
  );
  assert.equal(
    classifyRunStatus({
      activationProven: true,
      landingVerified: false,
      failureCode: null,
    }),
    "partial",
  );
});
