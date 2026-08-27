import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function rendererSource(name: string): Promise<string> {
  return await readFile(new URL(`../src/renderer/${name}`, import.meta.url), "utf8");
}

test("navigation table retains the reference information architecture", async () => {
  const html = await rendererSource("index.html");
  const headings = [...html.matchAll(/<th\s+scope="col">([^<]+)<\/th>/g)].map((match) =>
    match[1]?.trim(),
  );

  assert.deepEqual(headings, ["Name", "Technology", "Section", "Platform", "RMC", "State", "Note"]);
  assert.equal((html.match(/class="table-panel"/g) ?? []).length, 1);
  assert.match(html, /id="search-input"/);
  assert.match(html, /id="technology-filter"/);
  assert.match(html, /id="section-filter"/);
  assert.match(html, /id="quick-actions"/);
});

test("runtime-state column is active and wired to main-process observations", async () => {
  const html = await rendererSource("index.html");
  const css = await rendererSource("styles.css");
  const app = await rendererSource("app.ts");
  const preload = await readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../src/shared/ipc.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../src/main/runtime/registry.ts", import.meta.url), "utf8");

  assert.match(html, /data-runtime-state-column="active"/);
  assert.match(html, /<th\s+scope="col">State<\/th>/);
  assert.match(css, /--runtime-state-column-width:\s*8rem/);
  assert.match(app, /getRuntimeStates\(\)/);
  assert.match(app, /onRuntimeStates\(applyRuntimeSnapshot\)/);
  assert.match(app, /runtime\.status === "shared"/);
  assert.match(registry, /individual panel presence is not observable/);
  assert.match(preload, /IPC\.getRuntimeStates/);
  assert.match(preload, /IPC\.runtimeStates/);
  assert.match(ipc, /launcher:get-runtime-states/);
  assert.match(ipc, /launcher:runtime-states/);
});

test("navigation uses native filters, semantic launch buttons, and one scroll region", async () => {
  const html = await rendererSource("index.html");
  const css = await rendererSource("styles.css");
  const app = await rendererSource("app.ts");

  assert.match(html, /<select[^>]+id="technology-filter"/i);
  assert.match(html, /<select[^>]+id="section-filter"/i);
  assert.match(css, /html,\s*body\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.table-panel\s*\{[\s\S]*?overflow:\s*auto/);
  assert.match(css, /\.table-panel thead th\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(app, /createElement\("button"\)/);
  assert.match(app, /launch-button/);
  assert.doesNotMatch(app, /tabIndex\s*=|event\.key\s*===\s*"Enter"/);
});
