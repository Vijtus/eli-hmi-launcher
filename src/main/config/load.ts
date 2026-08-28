// Root configuration composition. Parsing, value/path normalization, and
// security checks live in focused sibling modules so this file only coordinates
// catalog sources, cross-target validation, and precedence.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CatalogSourceStatus,
  LaunchAccessPolicy,
  LaunchAccessPolicyOverride,
  LaunchTarget,
  ProcessTargetOptions,
} from "../../shared/types";
import { PRODUCT_NAME } from "../../shared/types";
import { resolveLaunchAccessPolicy } from "../launch/policy";
import { deepMerge } from "./merge";
import {
  isObject,
  parseActions,
  parseLocalMachineConfig,
  parsePlatformAccessPolicies,
  parseRows,
  parseYamlMapping,
  readOptionalText,
  readText,
} from "./parse";
import {
  assertConfigFilePermissions,
  assertWebUrlAllowed,
  parseSecurityPolicy,
} from "./security";
import type {
  ConfigItemScope,
  ConfigLoadBase,
  ConfigOverlay,
  ConfiguredRow,
  LaunchContext,
  RawObject,
  ParsedConfig,
} from "./types";
import {
  expandConfiguredString,
  isWindowsAbsolutePath,
  MissingLocalSettingError,
  resolveConfiguredPath,
} from "./values";

export type {
  ConfigEntrySource,
  ConfigItemScope,
  ConfigLoadBase,
  ConfigOverlay,
  ConfiguredAction,
  ConfiguredRow,
  LaunchContext,
  ParsedConfig,
} from "./types";
export { PHOEBUS_LAUNCHER_BY_PLATFORM, PHOEBUS_LAUNCHER_CANDIDATES } from "./parse";
export { assertCommandAllowed, assertConfigFilePermissions, assertWebUrlAllowed } from "./security";
export {
  expandConfiguredString,
  materializeProcessTarget,
  resolveConfiguredPath,
  type MaterializedProcess,
} from "./values";

type CatalogSourceDeclaration = {
  id: string;
  path: string;
};

type CatalogRowsSource = {
  id: string;
  rows: ConfiguredRow[];
};

type LoadedCatalog = {
  sources: CatalogRowsSource[];
  statuses: CatalogSourceStatus[];
  warnings: string[];
};

function parseCatalogSourceDeclarations(value: unknown): CatalogSourceDeclaration[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isObject(value)) {
    throw new Error("`catalog` must be a YAML mapping when provided.");
  }
  const sources = value["sources"];
  if (sources === undefined || sources === null) {
    return [];
  }
  if (!Array.isArray(sources)) {
    throw new Error("`catalog.sources` must be a YAML list.");
  }

  const ids = new Set<string>();
  return sources.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`Catalog source ${index + 1} is not an object.`);
    }
    const id = readText(item["id"]);
    const sourcePath = readText(item["path"]);
    if (!id) {
      throw new Error(`Catalog source ${index + 1} is missing required \`id\`.`);
    }
    if (!sourcePath) {
      throw new Error(`Catalog source \`${id}\` is missing required \`path\`.`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate catalog source id '${id}'.`);
    }
    ids.add(id);
    return { id, path: sourcePath };
  });
}

function assertRowsUniqueWithinSource(rows: ConfiguredRow[], sourceId: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new Error(`Catalog source '${sourceId}' contains duplicate entry id '${row.id}'.`);
    }
    seen.add(row.id);
  }
}

function parseCatalogEntries(value: unknown, sourceId: string, context: LaunchContext): ConfiguredRow[] {
  const rows = parseRows(value);
  assertRowsUniqueWithinSource(rows, sourceId);
  for (const row of rows) {
    validateTargetReferences(row.target, context, {
      id: row.id,
      kind: row.target.kind,
      group: "entry",
    });
  }
  return rows;
}

function parseCatalogDocument(text: string, sourceId: string, context: LaunchContext): ConfiguredRow[] {
  const parsed = parseYamlMapping(text, `Catalog source '${sourceId}'`);
  if (parsed["rows"] !== undefined) {
    throw new Error(`Catalog source '${sourceId}' uses obsolete \`rows\`; rename it to \`entries\`.`);
  }
  return parseCatalogEntries(parsed["entries"], sourceId, context);
}

function catalogCachePath(cacheDir: string, source: CatalogSourceDeclaration, resolvedPath: string): string {
  const safeId = source.id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "catalog";
  const digest = createHash("sha256").update(`${source.id}\0${resolvedPath}`).digest("hex").slice(0, 12);
  return path.join(cacheDir, `${safeId}-${digest}.yaml`);
}

function writeCatalogCache(cachePath: string, text: string): void {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, cachePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Ignore cleanup failure; the original cache error is more useful.
    }
    throw error;
  }
}

function fileTimestamp(filePath: string): string | undefined {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function loadCatalogSources(
  declarations: CatalogSourceDeclaration[],
  context: LaunchContext,
  cacheDir: string,
): LoadedCatalog {
  const loaded: LoadedCatalog = { sources: [], statuses: [], warnings: [] };

  for (const source of declarations) {
    const resolvedPath = resolveConfiguredPath(source.path, context);
    const cachePath = catalogCachePath(cacheDir, source, resolvedPath);
    try {
      const text = readFileSync(resolvedPath, "utf8");
      const rows = parseCatalogDocument(text, source.id, context);
      loaded.sources.push({ id: source.id, rows });
      const status: CatalogSourceStatus = {
        id: source.id,
        path: resolvedPath,
        state: "fresh",
        stale: false,
        entryCount: rows.length,
        cachePath,
        ...(fileTimestamp(resolvedPath) ? { loadedAt: fileTimestamp(resolvedPath) } : {}),
      };
      try {
        writeCatalogCache(cachePath, text);
      } catch (error) {
        const message =
          `Catalog source '${source.id}' loaded from '${resolvedPath}', but its cache could not be updated: ` +
          `${error instanceof Error ? error.message : String(error)}`;
        loaded.warnings.push(message);
        status.message = message;
      }
      loaded.statuses.push(status);
      continue;
    } catch (sourceError) {
      if (sourceError instanceof MissingLocalSettingError) {
        throw sourceError;
      }

      try {
        const cachedText = readFileSync(cachePath, "utf8");
        const rows = parseCatalogDocument(cachedText, source.id, context);
        const message =
          `Catalog source '${source.id}' at '${resolvedPath}' is unavailable or invalid; ` +
          `using cached data from '${cachePath}'. Cause: ` +
          `${sourceError instanceof Error ? sourceError.message : String(sourceError)}`;
        loaded.sources.push({ id: source.id, rows });
        loaded.statuses.push({
          id: source.id,
          path: resolvedPath,
          state: "cached",
          stale: true,
          entryCount: rows.length,
          message,
          cachePath,
          ...(fileTimestamp(cachePath) ? { loadedAt: fileTimestamp(cachePath) } : {}),
        });
        loaded.warnings.push(message);
        continue;
      } catch (cacheError) {
        if (cacheError instanceof MissingLocalSettingError) {
          throw cacheError;
        }
        const message =
          `Catalog source '${source.id}' at '${resolvedPath}' could not be loaded and no usable cache exists. ` +
          `Source error: ${sourceError instanceof Error ? sourceError.message : String(sourceError)}. ` +
          `Cache error: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}.`;
        loaded.statuses.push({
          id: source.id,
          path: resolvedPath,
          state: "unavailable",
          stale: true,
          entryCount: 0,
          message,
          cachePath,
        });
        loaded.warnings.push(message);
      }
    }
  }

  return loaded;
}

function mergeCatalogRows(sources: CatalogRowsSource[], warnings: string[]): ConfiguredRow[] {
  const merged = new Map<string, { row: ConfiguredRow; sourceId: string }>();
  for (const source of sources) {
    assertRowsUniqueWithinSource(source.rows, source.id);
    for (const row of source.rows) {
      const previous = merged.get(row.id);
      if (previous) {
        warnings.push(
          `Catalog entry id '${row.id}' from source '${source.id}' overrides source ` +
            `'${previous.sourceId}' because later configured sources take precedence.`,
        );
        // Delete first so the winning row is ordered where the later source put it.
        merged.delete(row.id);
      }
      merged.set(row.id, { row, sourceId: source.id });
    }
  }
  return [...merged.values()].map(({ row }) => row);
}

function validateProcessOptionsReferences(
  options: ProcessTargetOptions | undefined,
  context: LaunchContext,
  scope: ConfigItemScope,
  prefix: string,
): void {
  if (!options) {
    return;
  }
  if (options.command !== undefined) {
    expandConfiguredString(options.command, context, { ...scope, field: `${prefix}.command` });
  }
  options.args?.forEach((arg, index) => {
    expandConfiguredString(arg, context, { ...scope, field: `${prefix}.args[${index}]` });
  });
  if (options.cwd !== undefined) {
    expandConfiguredString(options.cwd, context, { ...scope, field: `${prefix}.cwd` });
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    expandConfiguredString(value, context, { ...scope, field: `${prefix}.env.${name}` });
  }
}

function validateTargetReferences(target: LaunchTarget, context: LaunchContext, scope: ConfigItemScope): void {
  if (target.kind === "web") {
    assertWebUrlAllowed(target.url, context, scope);
    return;
  }
  if (target.kind === "folder") {
    expandConfiguredString(target.path, context, { ...scope, field: "target.path" });
    return;
  }
  if (target.kind === "labview-dev") {
    expandConfiguredString("${local.workspaceRoot}", context, {
      ...scope,
      field: "local.workspaceRoot",
    });
    expandConfiguredString("${local.zoneSymbol}", context, {
      ...scope,
      field: "local.zoneSymbol",
    });
    expandConfiguredString(target.iocName, context, { ...scope, field: "target.iocName" });
    expandConfiguredString(target.hostName, context, { ...scope, field: "target.hostName" });
    expandConfiguredString(target.iocType, context, { ...scope, field: "target.iocType" });
    expandConfiguredString(target.exeName, context, { ...scope, field: "target.exeName" });
    return;
  }
  if (target.kind === "labview-epics") {
    expandConfiguredString("${local.workspaceRoot}", context, {
      ...scope,
      field: "local.workspaceRoot",
    });
    expandConfiguredString("${local.zoneSymbol}", context, {
      ...scope,
      field: "local.zoneSymbol",
    });
    expandConfiguredString(target.guiName, context, { ...scope, field: "target.guiName" });
    expandConfiguredString(target.guiType, context, { ...scope, field: "target.guiType" });
    expandConfiguredString(target.exeName, context, { ...scope, field: "target.exeName" });
    return;
  }
  if (target.kind === "phoebus") {
    expandConfiguredString("${local.phoebus.executable}", context, {
      ...scope,
      field: "local.phoebus.executable",
    });
    expandConfiguredString("${local.phoebus.serverPort}", context, {
      ...scope,
      field: "local.phoebus.serverPort",
    });
    if (context.local.phoebus.settingsFile !== undefined) {
      expandConfiguredString(context.local.phoebus.settingsFile, context, {
        ...scope,
        field: "local.phoebus.settingsFile",
      });
    }
    if (target.layout) {
      expandConfiguredString("${local.phoebus.layoutFile}", context, {
        ...scope,
        field: "local.phoebus.layoutFile",
      });
    }
    if (target.resource !== undefined) {
      const expandedResource = expandConfiguredString(target.resource, context, {
        ...scope,
        field: "target.resource",
      });
      const hasScheme =
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(expandedResource) &&
        !/^[A-Za-z]:[\\/]/.test(expandedResource);
      if (hasScheme) {
        let uri: URL;
        try {
          uri = new URL(expandedResource);
        } catch {
          throw new Error(`Phoebus resource has a malformed URI: '${expandedResource}'.`);
        }
        if (!["http:", "https:"].includes(uri.protocol)) {
          throw new Error(
            `Phoebus resource URI must use HTTP(S); got '${uri.protocol}' in '${expandedResource}'.`,
          );
        }
      } else if (!path.isAbsolute(expandedResource) && !isWindowsAbsolutePath(expandedResource)) {
        expandConfiguredString("${local.cssGuiRoot}", context, {
          ...scope,
          field: "local.cssGuiRoot",
        });
      }
    }
    if (target.app !== undefined) {
      expandConfiguredString(target.app, context, { ...scope, field: "target.app" });
    }
    return;
  }
  validateProcessOptionsReferences(target, context, scope, "target");
  validateProcessOptionsReferences(target.windows, context, scope, "target.windows");
  validateProcessOptionsReferences(target.linux, context, scope, "target.linux");
  validateProcessOptionsReferences(target.darwin, context, scope, "target.darwin");
}

function mergeLocalOverlay(fileLocal: unknown, overlay: Record<string, unknown> | undefined): unknown {
  if (!overlay || Object.keys(overlay).length === 0) {
    return fileLocal;
  }
  return deepMerge(isObject(fileLocal) ? fileLocal : {}, overlay);
}

function createLaunchContext(parsed: RawObject, base: ConfigLoadBase): LaunchContext {
  const local = parseLocalMachineConfig(mergeLocalOverlay(parsed["local"], base.overlay?.local));
  const security = parseSecurityPolicy(parsed["security"], base, local);
  return { appRoot: base.appRoot, configDir: base.configDir, security, local };
}

function parseConfigObject(
  parsed: RawObject,
  base: ConfigLoadBase,
  loadedCatalog: LoadedCatalog,
): ParsedConfig {
  const context = createLaunchContext(parsed, base);

  if (parsed["rows"] !== undefined) {
    throw new Error("Root config uses obsolete `rows`; rename it to `entries`.");
  }
  const inlineRows = parseRows(parsed["entries"]);
  assertRowsUniqueWithinSource(inlineRows, "inline");
  const warnings = [...loadedCatalog.warnings];
  const rowsWithTargets = mergeCatalogRows(
    [{ id: "inline", rows: inlineRows }, ...loadedCatalog.sources],
    warnings,
  );
  const quickActionsWithTargets = parseActions(
    base.overlay?.quickActions ?? parsed["quickActions"],
    "Quick",
  );
  const moreActionsWithTargets = parseActions(
    base.overlay?.moreActions ?? parsed["moreActions"],
    "More",
  );
  const platformAccessPolicies = parsePlatformAccessPolicies(parsed["access"]);

  const targetsById = new Map<string, LaunchTarget>();
  const labelsById = new Map<string, string>();
  const accessPoliciesById = new Map<string, LaunchAccessPolicy>();

  const register = (
    id: string,
    label: string,
    target: LaunchTarget,
    group: ConfigItemScope["group"],
    platform: string | undefined,
    itemAccess: LaunchAccessPolicyOverride | undefined,
  ): void => {
    if (targetsById.has(id)) {
      throw new Error(`Duplicate launcher id '${id}'. Every row and action id must be unique.`);
    }
    // Validate every configured string, including inactive OS overrides, so a
    // missing local key is reported at startup with the owning item id.
    validateTargetReferences(target, context, { id, kind: target.kind, group });
    targetsById.set(id, target);
    labelsById.set(id, label);
    accessPoliciesById.set(
      id,
      resolveLaunchAccessPolicy({
        targetKind: target.kind,
        platform,
        platformOverride: platform
          ? platformAccessPolicies.get(platform.trim().toLowerCase())
          : undefined,
        itemOverride: itemAccess,
      }),
    );
  };

  for (const row of rowsWithTargets) {
    register(row.id, row.name, row.target, "entry", row.platform, row.access);
  }
  for (const action of quickActionsWithTargets) {
    register(action.id, action.label, action.target, "quick action", undefined, action.access);
  }
  for (const action of moreActionsWithTargets) {
    register(action.id, action.label, action.target, "more action", undefined, action.access);
  }

  const inlineStatus: CatalogSourceStatus = {
    id: "inline",
    state: "inline",
    stale: false,
    entryCount: inlineRows.length,
  };
  const sources = [inlineStatus, ...loadedCatalog.statuses];

  if (parsed["appName"] !== undefined) {
    throw new Error("Root config uses obsolete `appName`; use `siteName` for deployment identity.");
  }
  const configuredSiteName = readOptionalText(base.overlay?.siteName ?? parsed["siteName"]);
  const siteName = configuredSiteName && configuredSiteName !== PRODUCT_NAME ? configuredSiteName : undefined;

  return {
    productName: PRODUCT_NAME,
    ...(siteName ? { siteName } : {}),
    rows: rowsWithTargets.map(({ target: _t, access: _access, ...row }) => row),
    quickActions: quickActionsWithTargets.map(({ target: _t, access: _access, ...a }) => a),
    moreActions: moreActionsWithTargets.map(({ target: _t, access: _access, ...a }) => a),
    targetsById,
    labelsById,
    accessPoliciesById,
    context,
    catalogStatus: {
      stale: sources.some((source) => source.stale),
      sources,
      warnings,
    },
  };
}

// Overlay entry sources are appended AFTER the file's own catalog sources, so
// the existing "later source wins" precedence (see mergeCatalogRows) makes the
// git config repo authoritative over both inline entries and local catalogs.
function appendOverlaySources(
  loadedCatalog: LoadedCatalog,
  overlay: ConfigOverlay | undefined,
  context: LaunchContext,
): LoadedCatalog {
  if (!overlay) {
    return loadedCatalog;
  }
  const warnings = [...loadedCatalog.warnings, ...(overlay.warnings ?? [])];
  const sources = [...loadedCatalog.sources];
  const statuses = [...loadedCatalog.statuses];
  for (const source of overlay.entrySources ?? []) {
    const rows = parseCatalogEntries(source.entries, source.id, context);
    sources.push({ id: source.id, rows });
    statuses.push({
      id: source.id,
      state: source.state ?? "fresh",
      stale: source.stale ?? false,
      entryCount: rows.length,
      ...(source.path ? { path: source.path } : {}),
      ...(source.loadedAt ? { loadedAt: source.loadedAt } : {}),
      ...(source.message ? { message: source.message } : {}),
    });
  }
  return { sources, statuses, warnings };
}

export function parseConfig(rawYamlText: string, base: ConfigLoadBase): ParsedConfig {
  const parsed = parseYamlMapping(rawYamlText, "Config");
  const context = createLaunchContext(parsed, base);
  const declarations = parseCatalogSourceDeclarations(parsed["catalog"]);
  const cacheDir = base.catalogCacheDir ?? path.join(os.tmpdir(), "eli-hmi-launcher-catalog-cache");
  const loadedCatalog = appendOverlaySources(
    loadCatalogSources(declarations, context, cacheDir),
    base.overlay,
    context,
  );
  return parseConfigObject(parsed, base, loadedCatalog);
}

// Convenience wrapper used by main and by the validate-config script.
export function loadConfigFromFile(configPath: string, base: ConfigLoadBase): ParsedConfig {
  const text = readFileSync(configPath, "utf8");
  const result = parseConfig(text, { ...base, configDir: path.dirname(configPath) });
  assertConfigFilePermissions(configPath, result.context.security);
  return result;
}
