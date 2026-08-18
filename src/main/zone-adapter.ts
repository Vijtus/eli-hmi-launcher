// Translates a zone document from the config repo into the launcher's native
// `entries:` shape.
//
// The config repo groups HMIs by platform and uses kebab-case keys:
//
//   labview-dev:
//     - ioc-name: Camera Manager
//       host: RMC00-001
//       ioc-type: Camera Manager
//       exe: CMD.exe
//   labview-epics:
//   css:
//   web:
//
// The launcher consumes a flat list of rows with `id`/`name`/`technology`/
// `section`/`platform`/`rmc`/`note` and a typed `target`. This module is the
// adapter between the two, so the config repo keeps the shape its maintainers
// authored and the launcher keeps its existing model (FR6).
//
// SCHEMA CONFIDENCE
//   `labview-dev` is confirmed against real data in eli-eric/eli-hmi-config.
//   `labview-epics`, `css`, and `web` are EMPTY in that repo, so their item keys
//   are an assumption chosen for symmetry with the launcher's existing target
//   types (CONFIG_SCHEMA.md > Targets). They are documented in README.md and
//   flagged for maintainer confirmation. An unknown group is skipped with a
//   warning rather than failing, so a future group cannot stop a control room.

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

function required(item: RawObject, keys: string[], where: string): string {
  for (const key of keys) {
    const value = text(item[key]);
    if (value) {
      return value;
    }
  }
  throw new Error(
    `${where} is missing required key \`${keys[0]}\`. ` +
      `Remedy: add \`${keys[0]}: <value>\` to that list item in the config repo.`,
  );
}

function optional(item: RawObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = text(item[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
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
    id: optional(item, ["id"]) ?? id,
    name,
    technology: optional(item, ["technology"]) ?? EMPTY,
    section: optional(item, ["section"]) ?? EMPTY,
    platform: optional(item, ["platform"]) ?? PLATFORM_BY_GROUP[group],
    rmc: optional(item, ["rmc"]) ?? rmc ?? EMPTY,
    note: optional(item, ["note"]) ?? EMPTY,
  };
}

function adaptLabviewDev(item: RawObject, index: number, filePath: string): RawObject {
  const where = `Zone config '${filePath}' entry ${index + 1} in \`labview-dev\``;
  const iocName = required(item, ["ioc-name", "iocName"], where);
  const hostName = required(item, ["host", "host-name", "hostName"], where);
  const iocType = required(item, ["ioc-type", "iocType"], where);
  const exeName = required(item, ["exe", "exe-name", "exeName"], where);
  // `host` doubles as the RMC identifier in the real data (RMC00-001), so it is
  // surfaced in the launcher's RMC column as well as in the target.
  return {
    ...baseRow("labview-dev", item, makeId("labview-dev", [iocName, hostName]), iocName, hostName),
    target: { kind: "labview-dev", iocName, hostName, iocType, exeName },
  };
}

function adaptLabviewEpics(item: RawObject, index: number, filePath: string): RawObject {
  const where = `Zone config '${filePath}' entry ${index + 1} in \`labview-epics\``;
  const guiName = required(item, ["gui-name", "guiName", "name"], where);
  const guiType = required(item, ["gui-type", "guiType"], where);
  const exeName = required(item, ["exe", "exe-name", "exeName"], where);
  return {
    ...baseRow("labview-epics", item, makeId("labview-epics", [guiName]), guiName, undefined),
    target: { kind: "labview-epics", guiName, guiType, exeName },
  };
}

function adaptCss(item: RawObject, index: number, filePath: string): RawObject {
  const where = `Zone config '${filePath}' entry ${index + 1} in \`css\``;
  const name = required(item, ["name", "gui-name", "guiName"], where);
  const resource = optional(item, ["resource", "file", "bob"]);
  const app = optional(item, ["app", "application"]);
  const layout = item["layout"] === true || text(item["layout"]).toLowerCase() === "true";
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
  if (!resource && !layout) {
    throw new Error(
      `${where} must set \`resource\` or \`layout: true\`. ` +
        `Remedy: give the Phoebus entry something to open — see CONFIG_SCHEMA.md > Targets > phoebus.`,
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
  const name = required(item, ["name", "title"], where);
  const url = required(item, ["url", "href"], where);
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
