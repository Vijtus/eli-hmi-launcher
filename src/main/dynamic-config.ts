// Orchestrates the git-backed configuration path (FR1-FR7).
//
//   env -> ensureConfigRepo (clone/fetch/cache/offline)
//       -> resolve host file by hostname
//       -> read `zone:` from the host file, resolve the zone file
//       -> adapt the zone's grouped HMI lists into launcher entries
//       -> merge zone `local:` (base) under host values (override)
//       -> hand a ConfigOverlay to the launcher's existing config loader
//
// This module never touches electron, so `npm run validate-config` and the unit
// tests can drive the whole pipeline headlessly.

import os from "node:os";
import path from "node:path";
import type { ConfigRepoProvenance } from "../shared/types";
import type { ConfigOverlay } from "./config";
import { deepMerge } from "./config-merge";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  ensureConfigRepo,
  type ConfigRepoDeps,
  type ConfigRepoResult,
} from "./config-repo";
import { hostPassthrough, mapHostDocumentToLocal } from "./host-config-mapping";
import {
  readZoneName,
  resolveHostDocument,
  resolveHostnameCandidates,
  resolveZoneDocument,
} from "./host-zone-resolver";
import { adaptZoneDocument } from "./zone-adapter";

export const ENV = {
  url: "ELI_LAUNCHER_CONFIG_REPO_URL",
  token: "ELI_LAUNCHER_CONFIG_REPO_TOKEN",
  ref: "ELI_LAUNCHER_CONFIG_REPO_REF",
  subpath: "ELI_LAUNCHER_CONFIG_REPO_SUBPATH",
  cacheDir: "ELI_LAUNCHER_CONFIG_CACHE_DIR",
  hostname: "ELI_LAUNCHER_CONFIG_HOSTNAME",
  timeoutMs: "ELI_LAUNCHER_CONFIG_FETCH_TIMEOUT_MS",
  offline: "ELI_LAUNCHER_CONFIG_OFFLINE",
} as const;

export const DEFAULT_SUBPATH = "launcher";

export type EnvLike = Record<string, string | undefined>;

export type DynamicConfigOptions = {
  url: string;
  token?: string | undefined;
  ref?: string | undefined;
  subpath: string;
  cacheDir: string;
  hostnameOverride?: string | undefined;
  timeoutMs: number;
  offline: boolean;
};

export type DynamicConfigResult = {
  overlay: ConfigOverlay;
  provenance: ConfigRepoProvenance;
  warnings: string[];
};

function text(env: EnvLike, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readBoolean(env: EnvLike, key: string): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (!value) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  throw new Error(
    `\`${key}\` must be a boolean (1/0, true/false, yes/no, on/off), got '${value}'. ` +
      `Remedy: correct the environment variable or unset it.`,
  );
}

function readTimeout(env: EnvLike, key: string): number {
  const raw = env[key]?.trim();
  if (!raw) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `\`${key}\` must be a positive integer number of milliseconds, got '${raw}'. ` +
        `Remedy: correct the environment variable or unset it to use the ${DEFAULT_FETCH_TIMEOUT_MS} ms default.`,
    );
  }
  return value;
}

// The default cache location for non-Electron callers (validate-config, tests).
// The Electron main process passes the per-user `userData` directory instead.
export function defaultCacheDir(): string {
  return path.join(os.tmpdir(), "eli-hmi-launcher-config-repo");
}

// Returns undefined when the feature is switched off, i.e. no repo URL is set.
// In that case the launcher behaves exactly as it did before this feature.
export function readDynamicConfigEnv(
  env: EnvLike,
  defaults: { cacheDir?: string } = {},
): DynamicConfigOptions | undefined {
  const url = text(env, ENV.url);
  if (!url) {
    return undefined;
  }
  return {
    url,
    token: text(env, ENV.token),
    ref: text(env, ENV.ref),
    subpath: text(env, ENV.subpath) ?? DEFAULT_SUBPATH,
    cacheDir: text(env, ENV.cacheDir) ?? defaults.cacheDir ?? defaultCacheDir(),
    hostnameOverride: text(env, ENV.hostname),
    timeoutMs: readTimeout(env, ENV.timeoutMs),
    offline: readBoolean(env, ENV.offline),
  };
}

export function configRootFor(repo: ConfigRepoResult, subpath: string): string {
  return subpath ? path.join(repo.repoDir, subpath) : repo.repoDir;
}

// Resolves host + zone inside an already-checked-out repo. Split out from
// resolveDynamicConfig so tests can exercise resolution without any git at all.
export function resolveFromCheckout(
  repo: ConfigRepoResult,
  options: Pick<DynamicConfigOptions, "subpath" | "hostnameOverride" | "url" | "cacheDir">,
  hostnameFn?: () => string,
): DynamicConfigResult {
  const configRoot = configRootFor(repo, options.subpath);
  const hostname = resolveHostnameCandidates({
    override: options.hostnameOverride,
    ...(hostnameFn ? { hostname: hostnameFn } : {}),
  });
  const host = resolveHostDocument(configRoot, hostname);
  const zoneName = readZoneName(host);
  const zone = resolveZoneDocument(configRoot, zoneName, host.filePath);

  const adapted = adaptZoneDocument(zone.document, zone.filePath);
  const hostMapping = mapHostDocumentToLocal(host.document, host.filePath);

  // FR5 — zone is the base, host overrides it, key by key. Lists replace.
  const zoneLocal = zone.document["local"];
  const merged = deepMerge(
    deepMerge(zoneLocal ?? {}, hostMapping.local),
    hostPassthrough(host.document) ?? {},
  );
  const local = (merged && typeof merged === "object" && !Array.isArray(merged)
    ? merged
    : {}) as Record<string, unknown>;

  const warnings = [...repo.warnings, ...hostMapping.warnings, ...adapted.warnings];

  return {
    overlay: {
      local,
      entrySources: [
        {
          id: `zone:${zone.name}`,
          entries: adapted.entries,
          state: repo.source === "cached" ? "cached" : "fresh",
          stale: repo.source === "cached",
          path: zone.filePath,
          loadedAt: repo.fetchedAt,
          ...(repo.source === "cached"
            ? { message: `Cached config repo commit ${repo.commitSha} fetched at ${repo.fetchedAt}.` }
            : {}),
        },
      ],
      warnings,
    },
    provenance: {
      url: options.url,
      ref: repo.ref,
      commitSha: repo.commitSha,
      fetchedAt: repo.fetchedAt,
      source: repo.source,
      cacheDir: options.cacheDir,
      hostname: hostname.raw,
      hostnameSource: hostname.source,
      hostFile: host.filePath,
      zone: zone.name,
      zoneFile: zone.filePath,
      entryCount: adapted.entries.length,
    },
    warnings,
  };
}

export async function resolveDynamicConfig(
  options: DynamicConfigOptions,
  deps: ConfigRepoDeps,
): Promise<DynamicConfigResult> {
  const repo = await ensureConfigRepo(
    {
      url: options.url,
      token: options.token,
      ref: options.ref,
      cacheDir: options.cacheDir,
      timeoutMs: options.timeoutMs,
      offline: options.offline,
    },
    deps,
  );
  return resolveFromCheckout(repo, options);
}
