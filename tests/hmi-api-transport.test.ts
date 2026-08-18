// Transport rules for the lifecycle API base URL.
//
// The config repo's `hmi-server` key gives a bare `host:port`, which the host
// mapping turns into a plain-HTTP base URL plus an explicit opt-in. These tests
// pin what that opt-in does and does not permit.

import assert from "node:assert/strict";
import test from "node:test";
import { HttpHmiApiAdapter } from "../src/main/hmi-api.ts";
import { mapHmiServer } from "../src/main/host-config-mapping.ts";

function adapter(config: Record<string, unknown>): HttpHmiApiAdapter {
  return new HttpHmiApiAdapter(config as never, { env: { TOKEN_VAR: "s3cret" } });
}

test("a plain-HTTP site service is accepted with the insecure opt-in", () => {
  assert.doesNotThrow(() =>
    adapter({ baseUrl: "http://testz-deploy20:8082/api/lifecycle/v1", allowInsecureTransport: true }),
  );
});

test("the same URL is refused without the opt-in, naming the remedy", () => {
  assert.throws(
    () => adapter({ baseUrl: "http://testz-deploy20:8082/api/lifecycle/v1" }),
    (error: Error) => {
      assert.match(error.message, /must use HTTPS, or set/);
      assert.match(error.message, /allowInsecureTransport: true/);
      assert.match(error.message, /Remedy: give `hmi-server` a full `https:\/\/…` URL/);
      return true;
    },
  );
});

test("the opt-in explicitly disabled restores the strict rule", () => {
  assert.throws(
    () =>
      adapter({
        baseUrl: "http://testz-deploy20:8082/api/lifecycle/v1",
        allowInsecureTransport: false,
      }),
    /must use HTTPS/,
  );
});

// The hard rule: the opt-in exists for a service with no credential to protect,
// never as a way to weaken one that has.
test("a token is REFUSED over plain HTTP even with the opt-in", () => {
  assert.throws(
    () =>
      adapter({
        baseUrl: "http://testz-deploy20:8082/api/lifecycle/v1",
        allowInsecureTransport: true,
        authTokenEnv: "TOKEN_VAR",
      }),
    (error: Error) => {
      assert.match(error.message, /cannot be used with a plain-HTTP, non-loopback/);
      assert.match(error.message, /sent in cleartext/);
      return true;
    },
  );
});

test("a token over HTTPS is unaffected", () => {
  assert.doesNotThrow(() =>
    adapter({ baseUrl: "https://hmi.example.org/api/lifecycle/v1", authTokenEnv: "TOKEN_VAR" }),
  );
});

test("a loopback token stays allowed over plain HTTP", () => {
  assert.doesNotThrow(() =>
    adapter({ baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1", authTokenEnv: "TOKEN_VAR" }),
  );
});

test("a remote API without a token still requires the opt-in", () => {
  assert.throws(
    () => adapter({ baseUrl: "https://hmi.example.org/api/lifecycle/v1" }),
    /A remote lifecycle API requires `local\.hmiApi\.authTokenEnv`/,
  );
  assert.doesNotThrow(() =>
    adapter({ baseUrl: "https://hmi.example.org/api/lifecycle/v1", allowInsecureTransport: true }),
  );
});

test("mapHmiServer derives the URL forms the launcher then validates", () => {
  assert.deepEqual(mapHmiServer("testz-deploy20:8082"), {
    baseUrl: "http://testz-deploy20:8082/api/lifecycle/v1",
    allowInsecureTransport: true,
  });
  assert.deepEqual(mapHmiServer("https://hmi.example.org"), {
    baseUrl: "https://hmi.example.org/api/lifecycle/v1",
    allowInsecureTransport: false,
  });
  assert.deepEqual(mapHmiServer("http://127.0.0.1:8765"), {
    baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1",
    allowInsecureTransport: true,
  });
});

// End to end: the real host file's value must survive mapping AND validation.
test("the real config repo's hmi-server value loads without error", () => {
  const mapped = mapHmiServer("testz-deploy20:8082");
  assert.doesNotThrow(() =>
    adapter({ baseUrl: mapped.baseUrl, allowInsecureTransport: mapped.allowInsecureTransport }),
  );
});
