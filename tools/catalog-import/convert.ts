// Deterministic conversion of the catalog intake CSV into launcher YAML.
//
// Strictness is the point: the converter never invents or "repairs" values.
// Incomplete or invalid rows produce row-numbered errors so the sheet owner can
// fix the source data; only rows explicitly marked Enabled=yes are converted.
// Pure module (no Node APIs) so it is unit-testable and reusable.

export type IntakeSkip = { row: number; reason: string };
export type IntakeError = { row: number; message: string };

export type IntakeConversion = {
  yaml: string;
  includedIds: string[];
  skipped: IntakeSkip[];
  errors: IntakeError[];
};

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180 subset: quoted fields, doubled quotes, CR/LF/CRLF).
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Header mapping (tolerant to capitalisation and the parenthesised hints).
// ---------------------------------------------------------------------------

type ColumnKey =
  | "entryId"
  | "name"
  | "technology"
  | "section"
  | "platform"
  | "rmc"
  | "note"
  | "kind"
  | "targetValue"
  | "args"
  | "cwd"
  | "env"
  | "owner"
  | "enabled"
  | "testedOn"
  | "testResult"
  | "comments"
  | "iocName"
  | "hostName"
  | "iocType"
  | "guiName"
  | "guiType"
  | "exeName"
  | "phoebusResource"
  | "phoebusApp"
  | "phoebusLayout";

const HEADER_PATTERNS: [RegExp, ColumnKey][] = [
  [/^entry id/, "entryId"],
  [/^name/, "name"],
  [/^technology/, "technology"],
  [/^section/, "section"],
  [/^platform/, "platform"],
  [/^rmc/, "rmc"],
  [/^note/, "note"],
  [/^target kind/, "kind"],
  [/^command/, "targetValue"],
  [/^arguments/, "args"],
  [/^working directory/, "cwd"],
  [/^environment/, "env"],
  [/^owner/, "owner"],
  [/^enabled/, "enabled"],
  [/^tested on host/, "testedOn"],
  [/^test result/, "testResult"],
  [/^comments/, "comments"],
  [/^ioc name/, "iocName"],
  [/^host name/, "hostName"],
  [/^ioc type/, "iocType"],
  [/^gui name/, "guiName"],
  [/^gui type/, "guiType"],
  [/^exe name/, "exeName"],
  [/^phoebus resource/, "phoebusResource"],
  [/^phoebus app/, "phoebusApp"],
  [/^phoebus (?:layout|use configured layout)/, "phoebusLayout"],
];

function mapHeader(headerRow: string[]): Map<ColumnKey, number> | undefined {
  const map = new Map<ColumnKey, number>();
  headerRow.forEach((cell, index) => {
    const normalized = cell.trim().toLowerCase();
    for (const [pattern, key] of HEADER_PATTERNS) {
      if (pattern.test(normalized) && !map.has(key)) {
        map.set(key, index);
      }
    }
  });
  const required: ColumnKey[] = ["entryId", "name", "kind", "targetValue", "enabled"];
  return required.every((key) => map.has(key)) ? map : undefined;
}

// ---------------------------------------------------------------------------
// YAML scalar emission.
// ---------------------------------------------------------------------------

const PLAIN_SAFE = /^[A-Za-z0-9/][A-Za-z0-9 ._/-]*$/;
const BOOLEAN_LIKE = /^(true|false|yes|no|on|off|null|~)$/i;
const NUMBER_LIKE = /^[+-]?\d/;

export function yamlScalar(value: string): string {
  if (value === "--") {
    return "--";
  }
  if (
    PLAIN_SAFE.test(value) &&
    !BOOLEAN_LIKE.test(value) &&
    !NUMBER_LIKE.test(value) &&
    value === value.trim()
  ) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function yamlComment(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Field-level conversions.
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toMultiValue(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== "--");
}

function parseArgsCell(raw: string, row: number, errors: IntakeError[]): string[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error("not an array");
      }
      return parsed.map((item) => String(item));
    } catch {
      errors.push({ row, message: `Arguments cell is not a valid JSON array: ${text}` });
      return [];
    }
  }
  return text
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseEnvCell(raw: string, row: number, errors: IntakeError[]): [string, string][] {
  const text = raw.trim();
  if (!text) {
    return [];
  }
  const pairs: [string, string][] = [];
  for (const part of text.split(";")) {
    const item = part.trim();
    if (!item) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(item);
    if (!match) {
      errors.push({
        row,
        message: `Environment requirements must be semicolon-separated NAME=value pairs, got: ${item}`,
      });
      continue;
    }
    pairs.push([match[1], match[2].trim()]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Conversion.
// ---------------------------------------------------------------------------

const KNOWN_KINDS = new Set([
  "process",
  "web",
  "folder",
  "labview-dev",
  "labview-epics",
  "phoebus",
]);
const ENABLED_TRUE = new Set(["yes", "true", "1", "y"]);
const ENABLED_FALSE = new Set(["no", "false", "0", "n"]);

export function convertIntakeCsv(csvText: string): IntakeConversion {
  const rows = parseCsv(csvText);
  const errors: IntakeError[] = [];
  const skipped: IntakeSkip[] = [];
  const includedIds: string[] = [];
  const blocks: string[] = [];

  if (rows.length === 0) {
    return { yaml: "", includedIds, skipped, errors: [{ row: 1, message: "The CSV file is empty." }] };
  }

  const columns = mapHeader(rows[0]);
  if (!columns) {
    return {
      yaml: "",
      includedIds,
      skipped,
      errors: [
        {
          row: 1,
          message:
            "Header row not recognised. Keep the columns of the supplied intake sheet " +
            "(Entry ID, Name, …, Target kind, Command/URL/folder path, …, Enabled).",
        },
      ],
    };
  }

  const cell = (row: string[], key: ColumnKey): string => {
    const index = columns.get(key);
    return index === undefined || index >= row.length ? "" : row[index].trim();
  };

  const seenIds = new Set<string>();

  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i];
    const rowNumber = i + 1; // 1-based, matching spreadsheet views (header = row 1).
    if (raw.every((value) => !value.trim())) {
      continue;
    }

    const dataKeys: ColumnKey[] = [
      "name",
      "technology",
      "section",
      "platform",
      "rmc",
      "note",
      "kind",
      "targetValue",
      "args",
      "cwd",
      "env",
      "owner",
      "enabled",
      "iocName",
      "hostName",
      "iocType",
      "guiName",
      "guiType",
      "exeName",
      "phoebusResource",
      "phoebusApp",
      "phoebusLayout",
    ];
    const hasData = dataKeys.some((key) => cell(raw, key) !== "");
    if (!hasData) {
      continue; // Template padding row: only Entry ID (and maybe comments) filled.
    }

    const enabledRaw = cell(raw, "enabled").toLowerCase();
    if (ENABLED_FALSE.has(enabledRaw)) {
      skipped.push({ row: rowNumber, reason: "Enabled is 'no'" });
      continue;
    }
    if (!ENABLED_TRUE.has(enabledRaw)) {
      errors.push({ row: rowNumber, message: "Set Enabled to yes or no (row has data but no decision)." });
      continue;
    }

    const name = cell(raw, "name");
    if (!name) {
      errors.push({ row: rowNumber, message: "Name is required." });
      continue;
    }

    const kind = cell(raw, "kind").toLowerCase();
    if (!KNOWN_KINDS.has(kind)) {
      errors.push({
        row: rowNumber,
        message:
          "Target kind must be process, web, folder, labview-dev, labview-epics, or phoebus " +
          `(got '${cell(raw, "kind") || "<empty>"}').`,
      });
      continue;
    }

    const targetValue = cell(raw, "targetValue");
    if (["process", "web", "folder"].includes(kind) && !targetValue) {
      errors.push({ row: rowNumber, message: "Command, URL, or folder path is required." });
      continue;
    }

    if (kind === "labview-dev") {
      const requiredFields: [ColumnKey, string][] = [
        ["iocName", "IOC name"],
        ["hostName", "host name"],
        ["iocType", "IOC type"],
        ["exeName", "EXE name"],
      ];
      const missingFields = requiredFields
        .filter(([key]) => !cell(raw, key))
        .map(([, label]) => label);
      if (missingFields.length > 0) {
        errors.push({
          row: rowNumber,
          message: `labview-dev requires ${missingFields.join(", ")}.`,
        });
        continue;
      }
    }

    if (kind === "labview-epics") {
      const requiredFields: [ColumnKey, string][] = [
        ["guiName", "GUI name"],
        ["guiType", "GUI type"],
        ["exeName", "EXE name"],
      ];
      const missingFields = requiredFields
        .filter(([key]) => !cell(raw, key))
        .map(([, label]) => label);
      if (missingFields.length > 0) {
        errors.push({
          row: rowNumber,
          message: `labview-epics requires ${missingFields.join(", ")}.`,
        });
        continue;
      }
    }

    if (kind === "phoebus") {
      const resource = cell(raw, "phoebusResource");
      const app = cell(raw, "phoebusApp");
      const layout = cell(raw, "phoebusLayout").toLowerCase();
      if (app && !resource) {
        errors.push({ row: rowNumber, message: "Phoebus app name requires a Phoebus resource." });
        continue;
      }
      if (
        layout &&
        !["yes", "true", "on", "1", "no", "false", "off", "0"].includes(layout)
      ) {
        errors.push({
          row: rowNumber,
          message:
            "Phoebus layout column must be yes or no. Configure the memento path once in " +
            "local.phoebus.layoutFile; do not put a path in the catalog.",
        });
        continue;
      }
    }

    if (kind === "web") {
      let ok = false;
      try {
        ok = ["http:", "https:"].includes(new URL(targetValue).protocol);
      } catch {
        ok = false;
      }
      if (!ok) {
        errors.push({ row: rowNumber, message: `Web target must be a valid http(s) URL, got: ${targetValue}` });
        continue;
      }
    }

    const id = slugify(cell(raw, "entryId")) || slugify(name);
    if (!id) {
      errors.push({ row: rowNumber, message: "Entry ID (or Name) must contain letters or digits to form an id." });
      continue;
    }
    if (seenIds.has(id)) {
      errors.push({ row: rowNumber, message: `Duplicate id '${id}' (Entry ID / Name must be unique).` });
      continue;
    }
    seenIds.add(id);

    const args = parseArgsCell(cell(raw, "args"), rowNumber, errors);
    const env = parseEnvCell(cell(raw, "env"), rowNumber, errors);
    const cwd = cell(raw, "cwd");

    const technology = toMultiValue(cell(raw, "technology"));
    const section = toMultiValue(cell(raw, "section"));

    const lines: string[] = [];
    const metaBits = [
      cell(raw, "owner") && `owner: ${yamlComment(cell(raw, "owner"))}`,
      cell(raw, "testedOn") && `tested on: ${yamlComment(cell(raw, "testedOn"))}`,
      cell(raw, "testResult") && `result: ${yamlComment(cell(raw, "testResult"))}`,
    ].filter(Boolean);
    if (metaBits.length > 0) {
      lines.push(`  # ${metaBits.join(" | ")}`);
    }
    if (cell(raw, "comments")) {
      lines.push(`  # ${yamlComment(cell(raw, "comments"))}`);
    }

    lines.push(`  - id: ${yamlScalar(id)}`);
    lines.push(`    name: ${yamlScalar(name)}`);
    lines.push(`    technology: [${technology.map(yamlScalar).join(", ")}]`);
    lines.push(`    section: [${section.map(yamlScalar).join(", ")}]`);
    lines.push(`    platform: ${cell(raw, "platform") ? yamlScalar(cell(raw, "platform")) : "--"}`);
    lines.push(`    rmc: ${cell(raw, "rmc") ? yamlScalar(cell(raw, "rmc")) : "--"}`);
    lines.push(`    note: ${cell(raw, "note") ? yamlScalar(cell(raw, "note")) : "--"}`);
    lines.push("    target:");
    lines.push(`      kind: ${kind}`);
    if (kind === "process") {
      lines.push(`      command: ${yamlScalar(targetValue)}`);
      if (args.length > 0) {
        lines.push("      args:");
        for (const arg of args) {
          lines.push(`        - ${yamlScalar(arg)}`);
        }
      }
      if (cwd) {
        lines.push(`      cwd: ${yamlScalar(cwd)}`);
      }
      if (env.length > 0) {
        lines.push("      env:");
        for (const [key, value] of env) {
          lines.push(`        ${key}: ${yamlScalar(value)}`);
        }
      }
    } else if (kind === "web") {
      lines.push(`      url: ${yamlScalar(targetValue)}`);
    } else if (kind === "folder") {
      lines.push(`      path: ${yamlScalar(targetValue)}`);
    } else if (kind === "labview-dev") {
      lines.push(`      iocName: ${yamlScalar(cell(raw, "iocName"))}`);
      lines.push(`      hostName: ${yamlScalar(cell(raw, "hostName"))}`);
      lines.push(`      iocType: ${yamlScalar(cell(raw, "iocType"))}`);
      lines.push(`      exeName: ${yamlScalar(cell(raw, "exeName"))}`);
    } else if (kind === "labview-epics") {
      lines.push(`      guiName: ${yamlScalar(cell(raw, "guiName"))}`);
      lines.push(`      guiType: ${yamlScalar(cell(raw, "guiType"))}`);
      lines.push(`      exeName: ${yamlScalar(cell(raw, "exeName"))}`);
    } else if (kind === "phoebus") {
      const resource = cell(raw, "phoebusResource");
      const app = cell(raw, "phoebusApp");
      const layout = cell(raw, "phoebusLayout").toLowerCase();
      if (resource) {
        lines.push(`      resource: ${yamlScalar(resource)}`);
      }
      if (app) {
        lines.push(`      app: ${yamlScalar(app)}`);
      }
      if (["yes", "true", "on", "1"].includes(layout)) {
        lines.push("      layout: true");
      }
    }

    blocks.push(lines.join("\n"));
  }

  if (errors.length > 0) {
    return { yaml: "", includedIds: [], skipped, errors };
  }

  const header = [
    "# Generated from the catalog intake sheet by tools/catalog-import/intake-to-yaml.ts.",
    "# Review it, then merge the `entries:` items into the deployed launcher.yaml",
    "# (keep that file's security block, quickActions, and moreActions).",
    "# Validate before deploying:  npm run validate-config -- <this-file>",
    "",
    "siteName: Imported catalog",
    "",
    "entries:",
  ].join("\n");

  const yaml = blocks.length > 0 ? `${header}\n${blocks.join("\n\n")}\n` : "";
  return { yaml, includedIds: [...seenIds], skipped, errors };
}
