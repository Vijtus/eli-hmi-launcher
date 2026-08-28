// Host-repository keys are matched case-insensitively because deployed files
// contain mixed-case keys such as `P4-workspace`. Unknown keys warn rather than
// fail so an older launcher can read repositories that have gained unrelated keys.

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
  // optional `installRoot` key, and configuration loading derives `executable` from it only
  // when no explicit executable is configured.
  { key: "css-install", path: ["phoebus", "installRoot"] },
  // Preserve the site-provided HMI host as an ordinary named host. The launcher
  // does not infer an API contract from this address.
  { key: "hmi-server", path: ["hosts", "hmi-server"] },
];

const MAPPED_KEYS = new Set(DIRECT_MAPPINGS.map((mapping) => mapping.key));

// A host file may also carry a native `local:` block for launcher settings that
// have no kebab-case alias. It is applied last and wins over the aliases above.
const PASSTHROUGH_KEY = "local";

// Launcher-level settings (siteName, quickActions, moreActions) that a zone or a
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
