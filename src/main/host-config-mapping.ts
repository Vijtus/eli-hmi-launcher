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
  // `hmi-server` is also preserved verbatim as a named host, so existing config
  // can keep referencing ${local.hosts.hmi-server}. Its URL form is derived
  // separately by `mapHmiServer` below.
  { key: "hmi-server", path: ["hosts", "hmi-server"] },
];

const MAPPED_KEYS = new Set(DIRECT_MAPPINGS.map((mapping) => mapping.key));

// The lifecycle service's versioned prefix, from services/hmi-lifecycle-api.
export const LIFECYCLE_API_PREFIX = "/api/lifecycle/v1";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export type HmiServerMapping = {
  baseUrl: string;
  allowInsecureTransport: boolean;
};

// Turns the config repo's `hmi-server` value into a lifecycle API base URL.
//
//   testz-deploy20:8082            -> http://testz-deploy20:8082/api/lifecycle/v1  (insecure opt-in)
//   https://hmi.example.org        -> https://hmi.example.org/api/lifecycle/v1     (strict)
//   https://hmi.example.org/v2/api -> used verbatim                                (strict)
//
// A bare `host:port` carries no scheme, which reads as the author asserting a
// trusted site LAN. Rather than refusing to load — which is what the strict
// non-loopback-must-be-HTTPS rule would do — the launcher accepts plain HTTP for
// that case and records the opt-in explicitly, so it is visible in the effective
// config dump and logged at startup. hmi-api.ts still refuses plain HTTP whenever
// a token would be sent over it.
export function mapHmiServer(value: string): HmiServerMapping {
  const trimmed = value.trim().replace(/\/+$/, "");
  const hasScheme = SCHEME.test(trimmed);
  const absolute = hasScheme ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    throw new Error(
      `\`hmi-server\` value '${value}' is not a usable address. ` +
        `Remedy: write it as \`host:port\` or as a full \`https://host/path\` URL.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `\`hmi-server\` value '${value}' must use HTTP or HTTPS. ` +
        `Remedy: write it as \`host:port\` or as a full \`https://host/path\` URL.`,
    );
  }
  // No path of its own means "the service root", so add the versioned prefix.
  const path = url.pathname.replace(/\/+$/, "");
  const baseUrl = `${url.origin}${path || LIFECYCLE_API_PREFIX}`;
  return { baseUrl, allowInsecureTransport: url.protocol === "http:" };
}

// A host file may also carry a native `local:` block for launcher settings that
// have no kebab-case alias. It is applied last and wins over the aliases above.
const PASSTHROUGH_KEY = "local";

// Launcher-level settings (appName, quickActions, moreActions) that a zone or a
// host may own, so a workstation no longer hand-maintains them locally.
export const LAUNCHER_BLOCK_KEY = "launcher";

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
    if (mapping.key === "hmi-server") {
      const mapped = mapHmiServer(value);
      assign(local, ["hmiApi", "baseUrl"], mapped.baseUrl);
      if (mapped.allowInsecureTransport) {
        assign(local, ["hmiApi", "allowInsecureTransport"], true);
      }
    }
  }

  for (const key of Object.keys(document)) {
    const lower = key.toLowerCase();
    if (MAPPED_KEYS.has(lower) || lower === PASSTHROUGH_KEY || lower === LAUNCHER_BLOCK_KEY) {
      continue;
    }
    warnings.push(
      `Host config '${filePath}' contains unknown key \`${key}\`; it was ignored. ` +
        `Known keys: ${[...MAPPED_KEYS].join(", ")}, ${PASSTHROUGH_KEY}, ${LAUNCHER_BLOCK_KEY}.`,
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

function blockNamed(document: RawObject, name: string): RawObject | undefined {
  for (const [key, value] of Object.entries(document)) {
    if (key.toLowerCase() === name && isObject(value)) {
      return value;
    }
  }
  return undefined;
}

export function hostPassthrough(document: RawObject): RawObject | undefined {
  return blockNamed(document, PASSTHROUGH_KEY);
}

// The `launcher:` block of a host or zone document.
export function launcherBlock(document: RawObject): RawObject | undefined {
  return blockNamed(document, LAUNCHER_BLOCK_KEY);
}
