// Maps a host document from the config repo onto the launcher's existing
// `local:` machine-settings model (src/shared/types.ts > LocalMachineConfig).
//
// Real host file (eli-eric/eli-hmi-config, launcher/host/TESTZ-Deploy.yaml):
//
//   zone: TESTZ
//   P4-workspace: D:\Workspaces\Perforce\TESTZ_dev_TESTZ-Deploy_8929
//   css-gui: D:\Workspaces\css-gui
//   css-install: C:\CSS Phoebus\product-5.0.2
//   hmi-server: testz-deploy20:8082
//
// Keys are matched case-insensitively because the authored file mixes cases
// (`P4-workspace`). An unrecognised key is a warning, never a failure, so the
// config repo can carry keys a older launcher does not know about yet.

export type RawObject = Record<string, unknown>;

export type HostMappingResult = {
  local: RawObject;
  warnings: string[];
};

// Host key (lowercased) -> path within `local:`.
const DIRECT_MAPPINGS: { key: string; path: string[]; note?: string }[] = [
  { key: "zone", path: ["zoneSymbol"] },
  { key: "p4-workspace", path: ["workspaceRoot"] },
  { key: "css-gui", path: ["cssGuiRoot"] },
  // `css-install` is a Phoebus INSTALL DIRECTORY (C:\CSS Phoebus\product-5.0.2),
  // whereas local.phoebus.executable is a FILE. It therefore maps to the new
  // optional `installRoot` key, and config.ts derives `executable` from it only
  // when no explicit executable is configured.
  { key: "css-install", path: ["phoebus", "installRoot"] },
  // `hmi-server` is deliberately NOT mapped to local.hmiApi.baseUrl. The real
  // value (`testz-deploy20:8082`) carries no scheme, and src/main/hmi-api.ts
  // rejects any non-loopback baseUrl that is not HTTPS and has no authTokenEnv,
  // so auto-wiring it would make every host config fail to load. It is preserved
  // as a named host so config can reference ${local.hosts.hmi-server}.
  { key: "hmi-server", path: ["hosts", "hmi-server"] },
];

const MAPPED_KEYS = new Set(DIRECT_MAPPINGS.map((mapping) => mapping.key));

// A host file may also carry a native `local:` block for launcher settings that
// have no kebab-case alias. It is applied last and wins over the aliases above.
const PASSTHROUGH_KEY = "local";

function isObject(value: unknown): value is RawObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function assign(target: RawObject, keyPath: string[], value: unknown): void {
  let cursor = target;
  for (const segment of keyPath.slice(0, -1)) {
    const next = cursor[segment];
    if (!isObject(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as RawObject;
  }
  cursor[keyPath[keyPath.length - 1] as string] = value;
}

export function mapHostDocumentToLocal(document: RawObject, filePath: string): HostMappingResult {
  const local: RawObject = {};
  const warnings: string[] = [];
  const lowered = new Map<string, unknown>();

  for (const [key, value] of Object.entries(document)) {
    lowered.set(key.toLowerCase(), value);
  }

  for (const mapping of DIRECT_MAPPINGS) {
    if (!lowered.has(mapping.key)) {
      continue;
    }
    const value = text(lowered.get(mapping.key));
    if (!value) {
      warnings.push(
        `Host config '${filePath}' key \`${mapping.key}\` is empty and was ignored. ` +
          `Remedy: give it a value or remove the key.`,
      );
      continue;
    }
    assign(local, mapping.path, value);
  }

  for (const key of Object.keys(document)) {
    const lower = key.toLowerCase();
    if (MAPPED_KEYS.has(lower) || lower === PASSTHROUGH_KEY) {
      continue;
    }
    warnings.push(
      `Host config '${filePath}' contains unknown key \`${key}\`; it was ignored. ` +
        `Known keys: ${[...MAPPED_KEYS].join(", ")}, ${PASSTHROUGH_KEY}.`,
    );
  }

  const passthrough = lowered.get(PASSTHROUGH_KEY);
  if (passthrough !== undefined && passthrough !== null && !isObject(passthrough)) {
    throw new Error(
      `Host config '${filePath}' key \`${PASSTHROUGH_KEY}\` must be a YAML mapping when provided. ` +
        `Remedy: nest launcher settings under it, or remove the key.`,
    );
  }

  return { local, warnings };
}

export function hostPassthrough(document: RawObject): RawObject | undefined {
  for (const [key, value] of Object.entries(document)) {
    if (key.toLowerCase() === PASSTHROUGH_KEY && isObject(value)) {
      return value;
    }
  }
  return undefined;
}
