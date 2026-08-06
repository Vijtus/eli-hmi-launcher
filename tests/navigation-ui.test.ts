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
  const registry = await readFile(new URL("../src/main/runtime-registry.ts", import.meta.url), "utf8");

  assert.match(html, /data-runtime-state-column="active"/);
  assert.match(html, /<th\s+scope="col">State<\/th>/);
  assert.match(css, /--runtime-state-column-width:\s*8rem/);
  assert.match(app, /getRuntimeStates\(\)/);
  assert.match(app, /onRuntimeStates\(applyRuntimeSnapshot\)/);
  assert.match(app, /runtime\.status === "shared"/);
  assert.match(registry, /individual panel presence is not observable/);
  assert.match(preload, /launcher:get-runtime-states/);
  assert.match(preload, /launcher:runtime-states/);
});

test("navigation keeps one scroll region, sticky headings, and accessible custom comboboxes", async () => {
  const html = await rendererSource("index.html");
  const css = await rendererSource("styles.css");
  const combobox = await rendererSource("combobox.ts");

  assert.doesNotMatch(html, /<select\b/i);
  assert.match(css, /html\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /body\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.table-panel\s*\{[\s\S]*?overflow:\s*auto/);
  assert.match(css, /\.table-panel thead th\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(combobox, /setAttribute\("role",\s*"combobox"\)/);
  assert.match(combobox, /setAttribute\("aria-expanded"/);
  assert.match(combobox, /setAttribute\("aria-activedescendant"/);
  assert.match(combobox, /setAttribute\("aria-selected"/);
});
