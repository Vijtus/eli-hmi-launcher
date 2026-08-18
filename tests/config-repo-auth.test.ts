import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthCallback,
  redactError,
  redactSecret,
  REDACTED,
  TOKEN_PASSWORD,
} from "../src/main/config-repo-auth.ts";

const TOKEN = "ghp_SUPERSECRETTOKEN123456789";

test("a configured token becomes in-memory basic credentials, never argv", () => {
  const onAuth = createAuthCallback(TOKEN);
  assert.ok(onAuth);
  assert.deepEqual(onAuth(), { username: TOKEN, password: TOKEN_PASSWORD });
  // The token is reachable only by calling the closure; it is never serialized
  // into an option object that git could persist or a command line could carry.
  assert.equal(JSON.stringify({ onAuth }), "{}");
});

test("an absent or blank token yields no callback, so the clone is anonymous", () => {
  assert.equal(createAuthCallback(undefined), undefined);
  assert.equal(createAuthCallback(""), undefined);
  assert.equal(createAuthCallback("   "), undefined);
});

test("the raw token is redacted anywhere in a string", () => {
  const redacted = redactSecret(`fatal: authentication failed for ${TOKEN} at origin`, TOKEN);
  assert.ok(!redacted.includes(TOKEN));
  assert.match(redacted, /authentication failed for \[REDACTED\] at origin/);
});

test("the base64 Authorization form of the token is redacted", () => {
  const header = Buffer.from(`${TOKEN}:${TOKEN_PASSWORD}`, "utf8").toString("base64");
  const redacted = redactSecret(`sent header Authorization: Basic ${header}`, TOKEN);
  assert.ok(!redacted.includes(header));
  assert.ok(!redacted.includes(TOKEN));
});

test("a bare base64 token and a percent-encoded token are both redacted", () => {
  const base64 = Buffer.from(TOKEN, "utf8").toString("base64");
  const redacted = redactSecret(`a=${base64} b=${encodeURIComponent(TOKEN)}`, TOKEN);
  assert.ok(!redacted.includes(base64));
  assert.ok(!redacted.includes(TOKEN));
});

test("credentials embedded in a URL are stripped even when they are not the token", () => {
  const redacted = redactSecret("clone failed: https://someone:hunter2@git.example.org/x.git", undefined);
  assert.ok(!redacted.includes("hunter2"));
  assert.match(redacted, /https:\/\/\[REDACTED\]@git\.example\.org/);
});

test("an Authorization header is redacted with no token configured", () => {
  const redacted = redactSecret("Authorization: Bearer abcdef123456", undefined);
  assert.ok(!redacted.includes("abcdef123456"));
});

test("redaction leaves ordinary text untouched", () => {
  assert.equal(redactSecret("Could not find ref 'nope'.", TOKEN), "Could not find ref 'nope'.");
});

test("a very short token is not used as a redaction pattern", () => {
  // Guards against redacting every occurrence of a common substring.
  assert.equal(redactSecret("the abc of it", "abc"), "the abc of it");
});

test("redactError handles Errors and non-Errors alike", () => {
  assert.match(redactError(new Error(`bad ${TOKEN}`), TOKEN), /bad \[REDACTED\]/);
  assert.match(redactError(`plain ${TOKEN}`, TOKEN), /plain \[REDACTED\]/);
  assert.equal(REDACTED, "[REDACTED]");
});
