// Host files live under host/<machine>.yaml and name a zone under
// zone/<zone>.yaml. Hostnames are matched case-insensitively, trying FQDN then
// short name. A missing host is a deployment error; silently selecting another
// machine's configuration would be unsafe. Directory scanning is required so
// mixed-case repository filenames resolve consistently on Windows and Linux.

import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export const HOST_DIR = "host";
export const ZONE_DIR = "zone";
const YAML_EXTENSIONS = [".yaml", ".yml"];

export type RawDocument = Record<string, unknown>;

export type HostnameResolution = {
  raw: string;
  source: "env" | "os";
  candidates: string[];
};

export type ResolvedDocument = {
  name: string;
  fileName: string;
  filePath: string;
  document: RawDocument;
};

export type HostnameOptions = {
  override?: string | undefined;
  hostname?: (() => string) | undefined;
};

export function resolveHostnameCandidates(options: HostnameOptions = {}): HostnameResolution {
  const override = options.override?.trim();
  const raw = override || (options.hostname ?? os.hostname)();
  const normalized = raw.trim().toLowerCase().replace(/\.$/, "");
  const short = normalized.split(".")[0] ?? normalized;
  const candidates = normalized && normalized !== short ? [normalized, short] : [normalized];
  return {
    raw: raw.trim(),
    source: override ? "env" : "os",
    candidates: candidates.filter((candidate) => candidate.length > 0),
  };
}

function isYamlFile(fileName: string): boolean {
  return YAML_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

function stem(fileName: string): string {
  return fileName.slice(0, fileName.length - path.extname(fileName).length);
}

type DirectoryIndex = {
  // lowercased stem -> file names that produced it
  byName: Map<string, string[]>;
  available: string[];
};

function indexDirectory(dir: string, label: string): DirectoryIndex {
  let fileNames: string[];
  try {
    fileNames = readdirSync(dir);
  } catch (error) {
    throw new Error(
      `Config repo directory '${dir}' could not be read, so ${label} configuration cannot be resolved. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}. ` +
        `Remedy: confirm the repo contains '${path.basename(dir)}/' under the configured subpath ` +
        `(ELI_LAUNCHER_CONFIG_REPO_SUBPATH).`,
    );
  }
  const byName = new Map<string, string[]>();
  const available: string[] = [];
  for (const fileName of fileNames) {
    if (!isYamlFile(fileName)) {
      continue;
    }
    const name = stem(fileName);
    available.push(name);
    const key = name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), fileName]);
  }
  available.sort((a, b) => a.localeCompare(b));
  return { byName, available };
}

function parseDocument(filePath: string, label: string): RawDocument {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `${label} file '${filePath}' could not be read. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (error) {
    throw new Error(
      `${label} file '${filePath}' is not valid YAML: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Remedy: fix the YAML syntax in the config repo and re-run.`,
    );
  }
  if (parsed === null || parsed === undefined) {
    throw new Error(
      `${label} file '${filePath}' is empty. ` +
        `Remedy: populate it, or remove it from the config repo.`,
    );
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${label} file '${filePath}' must be a YAML mapping, got ${Array.isArray(parsed) ? "a list" : typeof parsed}. ` +
        `Remedy: use \`key: value\` pairs at the top level.`,
    );
  }
  return parsed as RawDocument;
}

function lookup(index: DirectoryIndex, dir: string, candidate: string, label: string): string | undefined {
  const matches = index.byName.get(candidate.toLowerCase());
  if (!matches || matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(
      `${label} name '${candidate}' matches more than one file in '${dir}': ${matches.join(", ")}. ` +
        `Names are compared case-insensitively so the same config resolves on Windows and Linux. ` +
        `Remedy: remove or rename the duplicates in the config repo so only one file remains.`,
    );
  }
  return matches[0];
}

export function resolveHostDocument(configRoot: string, hostname: HostnameResolution): ResolvedDocument {
  const dir = path.join(configRoot, HOST_DIR);
  const index = indexDirectory(dir, "host");
  for (const candidate of hostname.candidates) {
    const fileName = lookup(index, dir, candidate, "Host");
    if (fileName) {
      const filePath = path.join(dir, fileName);
      return { name: stem(fileName), fileName, filePath, document: parseDocument(filePath, "Host config") };
    }
  }
  throw new Error(
    `No host configuration for machine '${hostname.raw}' in '${dir}'. ` +
      `Tried (case-insensitively): ${hostname.candidates.join(", ")}. ` +
      `Available host files: ${index.available.join(", ") || "(none)"}. ` +
      `Remedy: add '${hostname.candidates[0] ?? "<hostname>"}.yaml' under ${HOST_DIR}/ in the config repo, ` +
      `or set ELI_LAUNCHER_CONFIG_HOSTNAME to the logical machine name.`,
  );
}

export const ZONE_KEY = "zone";

export function readZoneName(host: ResolvedDocument): string {
  const raw = host.document[ZONE_KEY];
  const zone = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!zone) {
    throw new Error(
      `Host config '${host.filePath}' is missing the required \`${ZONE_KEY}\` key. ` +
        `Remedy: add \`${ZONE_KEY}: <ZONE-NAME>\` naming a file that exists under ${ZONE_DIR}/ in the config repo.`,
    );
  }
  return zone;
}

export function resolveZoneDocument(configRoot: string, zone: string, hostFilePath: string): ResolvedDocument {
  const dir = path.join(configRoot, ZONE_DIR);
  const index = indexDirectory(dir, "zone");
  const fileName = lookup(index, dir, zone, "Zone");
  if (!fileName) {
    throw new Error(
      `Host config '${hostFilePath}' names \`${ZONE_KEY}: ${zone}\`, but no matching file exists in '${dir}'. ` +
        `Available zones: ${index.available.join(", ") || "(none)"}. ` +
        `Remedy: add '${zone}.yaml' under ${ZONE_DIR}/ in the config repo, or correct the \`${ZONE_KEY}\` key ` +
        `in the host file.`,
    );
  }
  const filePath = path.join(dir, fileName);
  return { name: stem(fileName), fileName, filePath, document: parseDocument(filePath, "Zone config") };
}
