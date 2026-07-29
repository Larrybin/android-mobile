import assert from "node:assert/strict";
import test from "node:test";

import {
  parseActivitySnapshot,
  parseDocumentRequest,
} from "../scripts/core/capture-core.js";

test("parseDocumentRequest keeps only top-level HTTP document navigation", () => {
  const event = parseDocumentRequest(
    {
      requestId: "42",
      frameId: "root",
      type: "Document",
      timestamp: 12,
      wallTime: 100,
      request: { url: "https://merchant.test/" },
      redirectResponse: {
        url: "https://affiliate.test/click",
        status: 302,
      },
    },
    "root",
    "chrome",
  );

  assert.deepEqual(event, {
    requestId: "42",
    url: "https://merchant.test/",
    timestamp: 12,
    wallTime: 100,
    source: "chrome",
    redirectFrom: {
      url: "https://affiliate.test/click",
      statusCode: 302,
    },
  });
  assert.equal(
    parseDocumentRequest(
      {
        requestId: "asset",
        frameId: "root",
        type: "Image",
        timestamp: 1,
        wallTime: 1,
        request: { url: "https://merchant.test/logo.png" },
      },
      "root",
      "chrome",
    ),
    null,
  );
});

test("parseDocumentRequest rejects incomplete and non-HTTP events", () => {
  const base = {
    requestId: "42",
    frameId: "root",
    type: "Document",
    timestamp: 12,
    wallTime: 100,
    request: { url: "https://merchant.test/" },
  };
  const invalid = [
    { ...base, type: "Image" },
    { ...base, frameId: "child" },
    { ...base, requestId: 42 },
    { ...base, timestamp: "12" },
    { ...base, wallTime: "100" },
    { ...base, request: undefined },
    { ...base, request: { url: 42 } },
    { ...base, request: { url: "not a URL" } },
    { ...base, request: { url: "ftp://merchant.test/" } },
  ];
  for (const event of invalid) {
    assert.equal(parseDocumentRequest(event, "root", "chrome"), null);
  }
});

test("parseDocumentRequest ignores incomplete redirect metadata", () => {
  const base = {
    requestId: "42",
    frameId: "root",
    type: "Document",
    timestamp: 12,
    wallTime: 100,
    request: { url: "https://merchant.test/" },
  };
  assert.equal(
    parseDocumentRequest(
      {
        ...base,
        redirectResponse: {
          url: "not a URL",
          status: 302,
        },
      },
      "root",
      "app-webview",
    )?.redirectFrom,
    undefined,
  );
  assert.equal(
    parseDocumentRequest(
      {
        ...base,
        redirectResponse: {
          url: "https://affiliate.test/",
          status: "302",
        },
      },
      "root",
      "chrome",
    )?.redirectFrom,
    undefined,
  );
});

test("parseActivitySnapshot extracts resumed package and VIEW URL", () => {
  assert.deepEqual(
    parseActivitySnapshot(
      [
        "mResumedActivity: ActivityRecord{123 com.android.chrome/com.google.android.apps.chrome.Main}",
        "intent={act=android.intent.action.VIEW dat=https://nike.com/shop?tag=abc flg=0x0}",
      ].join("\n"),
    ),
    {
      packageName: "com.android.chrome",
      viewUrls: ["https://nike.com/shop?tag=abc"],
    },
  );
  assert.deepEqual(
    parseActivitySnapshot(
      "dat=https://nike.com/ dat=https://nike.com/",
    ),
    {
      packageName: null,
      viewUrls: ["https://nike.com/"],
    },
  );
});
