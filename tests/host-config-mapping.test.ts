import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { hostPassthrough, mapHostDocumentToLocal } from "../src/main/host-config-mapping.ts";

// Verbatim copy of launcher/host/TESTZ-Deploy.yaml from eli-eric/eli-hmi-config@ad98e4b.
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
    hmiApi: {
      baseUrl: "http://testz-deploy20:8082/api/lifecycle/v1",
      allowInsecureTransport: true,
    },
  });
  assert.deepEqual(warnings, []);
});

test("a scheme-less `hmi-server` becomes an HTTP base URL with the insecure opt-in", () => {
  // A bare host:port reads as a trusted site LAN. Without the opt-in, hmi-api.ts
  // would refuse a non-loopback URL that is not HTTPS and the config would not load.
  const { local } = map(REAL_HOST);
  assert.deepEqual(local["hmiApi"], {
    baseUrl: "http://testz-deploy20:8082/api/lifecycle/v1",
    allowInsecureTransport: true,
  });
  // The raw value is still available for ${local.hosts.hmi-server}.
  assert.equal((local["hosts"] as Record<string, string>)["hmi-server"], "testz-deploy20:8082");
});

test("an explicit https `hmi-server` keeps the strict transport rules", () => {
  const { local } = map("zone: TESTZ\nhmi-server: https://hmi.example.org\n");
  assert.deepEqual(local["hmiApi"], { baseUrl: "https://hmi.example.org/api/lifecycle/v1" });
});

test("an `hmi-server` that already carries a path is used verbatim", () => {
  const { local } = map("zone: TESTZ\nhmi-server: https://hmi.example.org/lifecycle/v2\n");
  assert.deepEqual(local["hmiApi"], { baseUrl: "https://hmi.example.org/lifecycle/v2" });
});

test("a trailing slash on `hmi-server` does not produce a doubled path", () => {
  const { local } = map("zone: TESTZ\nhmi-server: https://hmi.example.org/\n");
  assert.deepEqual(local["hmiApi"], { baseUrl: "https://hmi.example.org/api/lifecycle/v1" });
});

test("an unusable `hmi-server` value is rejected with a remedy", () => {
  assert.throws(
    () => map("zone: TESTZ\nhmi-server: 'ftp://hmi.example.org'\n"),
    /must use HTTP or HTTPS/,
  );
});

test("a host `local:` block can force the strict transport rule back on", () => {
  const document = YAML.parse(
    `${REAL_HOST}local:\n  hmiApi:\n    allowInsecureTransport: false\n`,
  ) as Record<string, unknown>;
  // The alias still derives the insecure default...
  assert.equal(
    (mapHostDocumentToLocal(document, "h.yaml").local["hmiApi"] as Record<string, unknown>)[
      "allowInsecureTransport"
    ],
    true,
  );
  // ...and the passthrough block, applied later, overrides it.
  assert.deepEqual(hostPassthrough(document), { hmiApi: { allowInsecureTransport: false } });
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
