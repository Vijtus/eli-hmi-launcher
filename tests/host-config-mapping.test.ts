import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { hostPassthrough, mapHostDocumentToLocal } from "../src/main/catalog/host.ts";

// Representative deployed host document; keep field spelling/casing intact.
const REAL_HOST = `zone: TESTZ
P4-workspace: D:\\Workspaces\\Perforce\\TESTZ_dev_TESTZ-Deploy_8929
css-gui: D:\\Workspaces\\css-gui
css-install: C:\\CSS Phoebus\\product-5.0.2
hmi-server: testz-deploy20:8082
`;

function map(text: string) {
  return mapHostDocumentToLocal(
    YAML.parse(text) as Record<string, unknown>,
    "/repo/launcher/host/TESTZ-Deploy.yaml",
  );
}

test("the real host file maps onto the launcher's local machine settings", () => {
  const { local, warnings } = map(REAL_HOST);
  assert.deepEqual(local, {
    zoneSymbol: "TESTZ",
    workspaceRoot: "D:\\Workspaces\\Perforce\\TESTZ_dev_TESTZ-Deploy_8929",
    cssGuiRoot: "D:\\Workspaces\\css-gui",
    phoebus: { installRoot: "C:\\CSS Phoebus\\product-5.0.2" },
    hosts: { "hmi-server": "testz-deploy20:8082" },
  });
  assert.deepEqual(warnings, []);
});

test("hmi-server remains a named host without inferring an API contract", () => {
  const { local } = map(REAL_HOST);
  assert.equal((local["hosts"] as Record<string, string>)["hmi-server"], "testz-deploy20:8082");
});

test("host keys are matched case-insensitively", () => {
  const { local, warnings } = map("ZONE: TESTZ\np4-WORKSPACE: D:\\ws\nCSS-Gui: D:\\css\n");
  assert.equal(local["zoneSymbol"], "TESTZ");
  assert.equal(local["workspaceRoot"], "D:\\ws");
  assert.equal(local["cssGuiRoot"], "D:\\css");
  assert.deepEqual(warnings, []);
});

test("an unknown host key is a warning, never a failure", () => {
  const { local, warnings } = map("zone: TESTZ\nfuture-setting: x\n");
  assert.equal(local["zoneSymbol"], "TESTZ");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /unknown key `future-setting`; it was ignored/);
});

test("an empty value is ignored with a warning rather than clearing the setting", () => {
  const { local, warnings } = map("zone: TESTZ\ncss-gui: ''\n");
  assert.equal(local["cssGuiRoot"], undefined);
  assert.match(warnings[0] ?? "", /key `css-gui` is empty and was ignored/);
});

test("a native `local:` block passes through for settings with no kebab alias", () => {
  const document = YAML.parse(
    "zone: TESTZ\nlocal:\n  phoebus:\n    serverPort: 4918\n  monitoring:\n    reconcileIntervalMs: 7000\n",
  ) as Record<string, unknown>;
  assert.deepEqual(hostPassthrough(document), {
    phoebus: { serverPort: 4918 },
    monitoring: { reconcileIntervalMs: 7000 },
  });
  assert.deepEqual(mapHostDocumentToLocal(document, "h.yaml").warnings, []);
});

test("a non-mapping `local:` block is rejected with a remedy", () => {
  assert.throws(() => map("zone: TESTZ\nlocal: nonsense\n"), /must be a YAML mapping when provided/);
});

test("hostPassthrough returns undefined when no block is present", () => {
  assert.equal(hostPassthrough(YAML.parse(REAL_HOST) as Record<string, unknown>), undefined);
});
