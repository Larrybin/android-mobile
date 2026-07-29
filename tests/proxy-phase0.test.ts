import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  assertPortAvailable,
  assertUsExit,
  buildAndroidProxyArgs,
  buildEmulatorArgs,
  buildGostConfig,
  isAndroidBootReady,
  parseProxyResponse,
  prepareAndroidDevice,
  redactSecrets,
} from "../scripts/proxy-phase0.js";

const validResponse = {
  code: "10001",
  msg: "ok",
  data: {
    count: 1,
    total: 1,
    proxy_list: [
      {
        ip: "192.0.2.10",
        port: "1080",
        username: "proxy-user",
        password: "proxy-pass",
      },
    ],
  },
};

test("parseProxyResponse returns the first complete proxy", () => {
  assert.deepEqual(parseProxyResponse(validResponse), {
    ip: "192.0.2.10",
    port: 1080,
    username: "proxy-user",
    password: "proxy-pass",
  });
});

test("parseProxyResponse rejects API failures and incomplete proxies", () => {
  assert.throws(
    () => parseProxyResponse({ ...validResponse, code: "10002" }),
    /proxy API returned code 10002/,
  );
  assert.throws(
    () =>
      parseProxyResponse({
        ...validResponse,
        data: { count: 0, total: 0, proxy_list: [] },
      }),
    /proxy API returned no proxies/,
  );
  assert.throws(
    () =>
      parseProxyResponse({
        ...validResponse,
        data: {
          count: 1,
          total: 1,
          proxy_list: [{ ip: "192.0.2.10", port: 1080 }],
        },
      }),
    /proxy API returned an incomplete proxy/,
  );
});

test("buildGostConfig binds locally and authenticates to SOCKS5 upstream", () => {
  const config = buildGostConfig(
    {
      ip: "192.0.2.10",
      port: 1080,
      username: "proxy-user",
      password: "proxy-pass",
    },
    18080,
  );

  assert.equal(config.services[0]?.addr, "127.0.0.1:18080");
  assert.equal(config.services[0]?.handler.type, "http");
  assert.equal(
    config.chains[0]?.hops[0]?.nodes[0]?.connector.type,
    "socks5",
  );
  assert.deepEqual(config.chains[0]?.hops[0]?.nodes[0]?.connector.auth, {
    username: "proxy-user",
    password: "proxy-pass",
  });
  assert.equal(
    config.chains[0]?.hops[0]?.nodes[0]?.connector.metadata.notls,
    true,
  );
});

test("Emulator uses the Android system proxy so domains resolve upstream", () => {
  assert.deepEqual(buildEmulatorArgs("cashback-phase0"), [
    "-avd",
    "cashback-phase0",
    "-no-metrics",
    "-no-snapshot",
  ]);
  assert.deepEqual(buildAndroidProxyArgs("emulator-5554", 18080), [
    "-s",
    "emulator-5554",
    "shell",
    "settings",
    "put",
    "global",
    "http_proxy",
    "10.0.2.2:18080",
  ]);
});

test("assertUsExit rejects missing and non-US exit data", () => {
  assert.deepEqual(
    assertUsExit({
      ip: "203.0.113.5",
      country: "US",
      region: "California",
      city: "San Jose",
    }),
    {
      ip: "203.0.113.5",
      country: "US",
      region: "California",
      city: "San Jose",
    },
  );
  assert.throws(
    () => assertUsExit({ ip: "203.0.113.5", country: "CA" }),
    /proxy exit country must be US/,
  );
  assert.throws(() => assertUsExit(null), /invalid proxy exit response/);
});

test("redactSecrets removes credentials and API keys from logs", () => {
  const message =
    "api-secret proxy-user proxy-pass https://example.test?api_key=api-secret";
  const redacted = redactSecrets(message, [
    "api-secret",
    "proxy-user",
    "proxy-pass",
  ]);

  assert.equal(redacted.includes("api-secret"), false);
  assert.equal(redacted.includes("proxy-user"), false);
  assert.equal(redacted.includes("proxy-pass"), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test("assertPortAvailable rejects a port that is already bound", async () => {
  const server = createServer();
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }

    await assert.rejects(
      assertPortAvailable(address.port),
      /is already in use/,
    );
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise();
        }
      });
    });
  }
});

test("Android boot completes before the global proxy is configured", async () => {
  const calls: string[] = [];
  await prepareAndroidDevice(
    "emulator-5554",
    18080,
    new AbortController().signal,
    {
      waitForBoot: async () => {
        calls.push("boot");
      },
      configureProxy: async () => {
        calls.push("proxy");
      },
    },
  );

  assert.deepEqual(calls, ["boot", "proxy"]);
});

test("Android readiness waits for framework services and boot animation", () => {
  assert.equal(
    isAndroidBootReady({
      sysBootCompleted: "1",
      devBootCompleted: "1",
      bootAnimation: "stopped",
      packageService: "Service package: found",
    }),
    true,
  );
  assert.equal(
    isAndroidBootReady({
      sysBootCompleted: "1",
      devBootCompleted: "1",
      bootAnimation: "running",
      packageService: "Service package: found",
    }),
    false,
  );
});
