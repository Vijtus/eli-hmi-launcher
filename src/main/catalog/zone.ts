// Adapt the config repository's grouped, kebab-case zone schema to the
// launcher's normalized entry/target shape. `labview-dev` matches the deployed
// repository schema; the other supported groups use the canonical keys
// documented in docs/configuration.md. Unknown groups are ignored with a
// warning so adding unrelated repository data cannot prevent launcher startup.

export type RawObject = Record<string, unknown>;

export type ZoneAdaptResult = {
  entries: RawObject[];
  warnings: string[];
};

export const KNOWN_GROUPS = ["labview-dev", "labview-epics", "css", "web"] as const;
export type ZoneGroup = (typeof KNOWN_GROUPS)[number];

const PLATFORM_BY_GROUP: Record<ZoneGroup, string> = {
  "labview-dev": "LabVIEW",
  "labview-epics": "LabVIEW",
  css: "CSS",
  web: "Web",
};

const EMPTY = "--";

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

function required(item: RawObject, key: string, where: string): string {
  const value = text(item[key]);
  if (value) return value;
  throw new Error(
    `${where} is missing required key \`${key}\`. ` +
      `Remedy: add \`${key}: <value>\` to that list item in the config repo.`,
  );
}

function optional(item: RawObject, key: string): string | undefined {
  const value = text(item[key]);
  return value || undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function makeId(group: string, parts: string[]): string {
  const tail = parts.map(slug).filter((part) => part.length > 0).join("-");
  return tail ? `${group}-${tail}` : group;
}

// A zone group may be a list, or `null` when the maintainers left it empty (all
// three non-LabVIEW groups are null in the real repo today).
function readGroup(value: unknown, group: string, filePath: string): RawObject[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Zone config '${filePath}' key \`${group}\` must be a YAML list or empty, got ${typeof value}. ` +
        `Remedy: write \`${group}:\` with nothing after it to leave the group empty.`,
    );
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(
        `Zone config '${filePath}' entry ${index + 1} in \`${group}\` is not a mapping. ` +
          `Remedy: each list item must be \`key: value\` pairs.`,
      );
    }
    return item;
  });
}

function baseRow(group: ZoneGroup, item: RawObject, id: string, name: string, rmc: string | undefined): RawObject {
  return {
    id: optional(item, "id") ?? id,
    name,
    technology: optional(item, "technology") ?? EMPTY,
    section: optional(item, "section") ?? EMPTY,
    platform: optional(item, "platform") ?? PLATFORM_BY_GROUP[group],
    rmc: optional(item, "rmc") ?? rmc ?? EMPTY,
    note: optional(item, "note") ?? EMPTY,
  };
}

function adaptLabviewDev(item: RawObject, index: number, filePath: string): RawObject {
  const where = `Zone config '${filePath}' entry ${index + 1} in \`labview-dev\``;
  const iocName = required(item, "ioc-name", where);
  const hostName = required(item, "host", where);
  const iocType = required(item, "ioc-type", where);
  const exeName = required(item, "exe", where);
  // `host` doubles as the RMC identifier in the real data (RMC00-001), so it is
  // surfaced in the launcher's RMC column as well as in the target.
  return {
    ...baseRow("labview-dev", item, makeId("labview-dev", [iocName, hostName]), iocName, hostName),
    target: { kind: "labview-dev", iocName, hostName, iocType, exeName },
  };
}

function adaptLabviewEpics(item: RawObject, index: number, filePath: string): RawObject {
  const where = `Zone config '${filePath}' entry ${index + 1} in \`labview-epics\``;
  const guiName = required(item, "gui-name", where);
  const guiType = required(item, "gui-type", where);
  const exeName = required(item, "exe", where);
  return {
    ...baseRow("labview-epics", item, makeId("labview-epics", [guiName]), guiName, undefined),
    target: { kind: "labview-epics", guiName, guiType, exeName },
  };
}

function adaptCss(item: RawObject, index: number, filePath: string): RawObject {
  const where = `Zone config '${filePath}' entry ${index + 1} in \`css\``;
  const name = required(item, "name", where);
  const resource = optional(item, "resource");
  const app = optional(item, "app");
  const layout = item["layout"] === true || text(item["layout"]).toLowerCase() === "true";
  // Starting Phoebus with no resource at all is a real, useful entry: it is how a
  // control room checks that the install and the zone .ini work before blaming a
  // panel. `layout: true` is NOT a substitute — it needs `local.phoebus.layoutFile`
  // and is startup-only, so it throws when a Phoebus server is already listening.
  // It has to be opted into by name so that a misspelt `resorce:` still fails loudly
  // instead of silently degrading to a bare launch.
  const bare = item["bare"] === true || text(item["bare"]).toLowerCase() === "true";
  // `app` is an `app` query parameter applied to a resource, not a standalone
  // target, so the launcher rejects it without one. Fail here instead, where the
  // message can name the config repo file and item.
  if (app && !resource) {
    throw new Error(
      `${where} sets \`app\` without \`resource\`. \`app\` selects which Phoebus application opens a ` +
        `resource, so it cannot be used on its own. ` +
        `Remedy: add \`resource:\`, or drop \`app\` and use \`layout: true\`.`,
    );
  }
  if (bare && (resource || layout)) {
    throw new Error(
      `${where} sets \`bare: true\` together with ${resource ? "`resource`" : "`layout`"}. ` +
        "`bare` means start Phoebus with nothing open, so it cannot be combined. " +
        `Remedy: drop \`bare\`, or drop ${resource ? "`resource`" : "`layout`"}.`,
    );
  }
  if (!resource && !layout && !bare) {
    throw new Error(
      `${where} must set \`resource\`, \`layout: true\`, or \`bare: true\`. ` +
        `Remedy: give the Phoebus entry something to open, or say \`bare: true\` to start Phoebus ` +
        `with the zone settings and no panel — see docs/configuration.md#target-phoebus.`,
    );
  }
  return {
    ...baseRow("css", item, makeId("css", [name]), name, undefined),
    target: {
      kind: "phoebus",
      ...(resource ? { resource } : {}),
      ...(app ? { app } : {}),
      ...(layout ? { layout: true } : {}),
    },
  };
}

function adaptWeb(item: RawObject, index: number, filePath: string): RawObject {
  const where = `Zone config '${filePath}' entry ${index + 1} in \`web\``;
  const name = required(item, "name", where);
  const url = required(item, "url", where);
  return {
    ...baseRow("web", item, makeId("web", [name]), name, undefined),
    target: { kind: "web", url },
  };
}

const ADAPTERS: Record<ZoneGroup, (item: RawObject, index: number, filePath: string) => RawObject> = {
  "labview-dev": adaptLabviewDev,
  "labview-epics": adaptLabviewEpics,
  css: adaptCss,
  web: adaptWeb,
};

// Keys that live at the top level of a zone document but are not HMI groups.
const NON_GROUP_KEYS = new Set(["zone", "description", "notes", "local", "launcher"]);

export function adaptZoneDocument(document: RawObject, filePath: string): ZoneAdaptResult {
  const entries: RawObject[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();

  for (const [key, value] of Object.entries(document)) {
    if (NON_GROUP_KEYS.has(key)) {
      continue;
    }
    if (!(KNOWN_GROUPS as readonly string[]).includes(key)) {
      warnings.push(
        `Zone config '${filePath}' contains unknown group \`${key}\`; it was ignored. ` +
          `Known groups: ${KNOWN_GROUPS.join(", ")}.`,
      );
      continue;
    }
    const group = key as ZoneGroup;
    const items = readGroup(value, group, filePath);
    items.forEach((item, index) => {
      const entry = ADAPTERS[group](item, index, filePath);
      const id = String(entry["id"]);
      const previous = seen.get(id);
      if (previous) {
        throw new Error(
          `Zone config '${filePath}' produces duplicate launcher id '${id}' from ${previous} and ` +
            `\`${group}\` entry ${index + 1}. ` +
            `Remedy: give one of them an explicit \`id:\` in the config repo, or make their names unique.`,
        );
      }
      seen.set(id, `\`${group}\` entry ${index + 1}`);
      entries.push(entry);
    });
  }

  return { entries, warnings };
}
