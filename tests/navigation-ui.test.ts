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

  assert.deepEqual(headings, ["Name", "Technology", "Section", "Platform", "RMC", "Note"]);
  assert.equal((html.match(/class="table-panel"/g) ?? []).length, 1);
  assert.match(html, /id="search-input"/);
  assert.match(html, /id="technology-filter"/);
  assert.match(html, /id="section-filter"/);
  assert.match(html, /id="quick-actions"/);
});

// The table shows only what the catalog describes: name, technology, section,
// platform, RMC and note. Runtime state was a seventh column reporting what the
// launcher had observed this session, which is useful to the launch policy in
// the main process and noise to an operator scanning for a name.
//
// The observation itself is unchanged. It still decides whether a second
// instance may start; it simply no longer occupies a column.
test("the table shows the catalog columns and no runtime state column", async () => {
  const html = await rendererSource("index.html");
  const css = await rendererSource("styles.css");

  for (const column of ["Name", "Technology", "Section", "Platform", "RMC", "Note"]) {
    assert.match(html, new RegExp(`<th\\s+scope="col">${column}</th>`), `missing column ${column}`);
  }
  assert.doesNotMatch(html, /<th\s+scope="col">State<\/th>/);
  assert.doesNotMatch(html, /data-runtime-state-column/);
  assert.doesNotMatch(css, /runtime-state/);
});

test("runtime observation stays wired to the main process", async () => {
  const preload = await readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../src/shared/ipc.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../src/main/runtime/registry.ts", import.meta.url), "utf8");

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
