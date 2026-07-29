import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRedirectChain,
  type DocumentRequestEvent,
} from "../scripts/core/redirect-core.js";

const events: DocumentRequestEvent[] = [
  {
    requestId: "1",
    url: "https://click.example/activate",
    timestamp: 1,
    wallTime: 10,
    source: "chrome",
  },
  {
    requestId: "1",
    url: "https://network.example/track",
    redirectFrom: {
      url: "https://click.example/activate",
      statusCode: 302,
    },
    timestamp: 2,
    wallTime: 11,
    source: "chrome",
  },
  {
    requestId: "1",
    url: "https://www.nike.com/",
    redirectFrom: {
      url: "https://network.example/track",
      statusCode: 302,
    },
    timestamp: 3,
    wallTime: 12,
    source: "chrome",
  },
];

test("buildRedirectChain records each redirect once and preserves status", () => {
  assert.deepEqual(buildRedirectChain(events), [
    {
      sequence: 1,
      url: "https://click.example/activate",
      source: "chrome",
      timestamp: "1970-01-01T00:00:10.000Z",
      statusCode: 302,
    },
    {
      sequence: 2,
      url: "https://network.example/track",
      source: "chrome",
      timestamp: "1970-01-01T00:00:11.000Z",
      statusCode: 302,
    },
    {
      sequence: 3,
      url: "https://www.nike.com/",
      source: "chrome",
      timestamp: "1970-01-01T00:00:12.000Z",
    },
  ]);
});

test("buildRedirectChain ignores repeated document events", () => {
  assert.equal(buildRedirectChain([...events, events[2]!]).length, 3);
});

test("buildRedirectChain rejects contradictory redirect continuity", () => {
  assert.throws(
    () =>
      buildRedirectChain([
        events[0]!,
        {
          ...events[1]!,
          redirectFrom: {
            url: "https://unexpected.example/",
            statusCode: 302,
          },
        },
      ]),
    /redirect continuity/,
  );
});

test("buildRedirectChain handles empty, duplicate URL, and missing first request", () => {
  assert.deepEqual(buildRedirectChain([]), []);
  assert.equal(
    buildRedirectChain([
      events[0]!,
      {
        ...events[0]!,
        requestId: "different",
        wallTime: 11,
      },
    ]).length,
    1,
  );
  assert.deepEqual(
    buildRedirectChain([
      {
        requestId: "1",
        url: "https://merchant.test/",
        redirectFrom: {
          url: "https://affiliate.test/",
          statusCode: 301,
        },
        timestamp: 1,
        wallTime: 10,
        source: "app-webview",
      },
    ]),
    [
      {
        sequence: 1,
        url: "https://affiliate.test/",
        statusCode: 301,
        source: "app-webview",
        timestamp: "1970-01-01T00:00:10.000Z",
      },
      {
        sequence: 2,
        url: "https://merchant.test/",
        source: "app-webview",
        timestamp: "1970-01-01T00:00:10.000Z",
      },
    ],
  );
});
