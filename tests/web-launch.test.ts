import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseConfig } from "../src/main/config.ts";
import { launchWebTarget } from "../src/main/web-launcher.ts";

const BASE = { appRoot: "/tmp/app", configDir: "/tmp/cfg" };

test("web launch delegates the expanded HTTP(S) URL to Electron openExternal", async () => {
  const parsed = parseConfig(
    `
local:
  hosts:
    dashboard: example.invalid
entries:
  - id: dashboard
    name: Dashboard
    target:
      kind: web
      url: 'https://${"${local.hosts.dashboard}"}/status?mode=operator&view=main'
`,
    BASE,
  );
  const opened: string[] = [];
  const resolved = await launchWebTarget(
    "https://${local.hosts.dashboard}/status?mode=operator&view=main",
    parsed.context,
    async (url) => {
      opened.push(url);
    },
  );

  assert.equal(resolved, "https://example.invalid/status?mode=operator&view=main");
  assert.deepEqual(opened, [resolved]);

  const mainSource = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  assert.match(mainSource, /shell\.openExternal\(url\)/);
  assert.doesNotMatch(mainSource, /BrowserView|WebContentsView/);
});

test("javascript, file, data, and protocol-relative web targets are rejected at load", () => {
  const disallowed = [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<h1>control</h1>",
    "//example.invalid/control",
  ];

  for (const url of disallowed) {
    assert.throws(
      () =>
        parseConfig(
          `
entries:
  - id: bad-web
    name: Bad web
    target:
      kind: web
      url: ${JSON.stringify(url)}
`,
          BASE,
        ),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /Only HTTP\(S\) URLs are allowed|malformed URL/);
        return true;
      },
      url,
    );
  }
});

test("web launch revalidates a URL before invoking openExternal", async () => {
  const parsed = parseConfig("entries: []\n", BASE);
  let calls = 0;
  await assert.rejects(
    launchWebTarget("javascript:alert(1)", parsed.context, async () => {
      calls += 1;
    }),
    /Only HTTP\(S\) URLs are allowed/,
  );
  assert.equal(calls, 0);
});
