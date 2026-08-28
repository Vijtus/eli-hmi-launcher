import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalMachineConfig, SecurityPolicy } from "../../shared/types";
import { isObject, readText } from "./parse";
import type { ConfigItemScope, LaunchContext } from "./types";
import {
  expandConfiguredString,
  isWindowsAbsolutePath,
  MissingLocalSettingError,
} from "./values";

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(normalized)) return true;
    if (["false", "no", "off", "0"].includes(normalized)) return false;
  }
  return fallback;
}

export function parseSecurityPolicy(
  value: unknown,
  base: { appRoot: string; configDir: string },
  local: LocalMachineConfig,
): SecurityPolicy {
  const raw = isObject(value) ? value : {};
  const ctxForRoots: LaunchContext = {
    appRoot: base.appRoot,
    configDir: base.configDir,
    security: { allowedCommandRoots: [], allowBareCommands: true, allowInsecureConfigPermissions: false },
    local,
  };

  // A root that references a `local.*` setting this machine does not have is
  // dropped rather than fatal. That lets one allow-list cover both a workstation
  // with no workspace configured and a deployed machine that has one, and it is
  // safe in the only direction that matters: dropping a root can only ever
  // NARROW what may be launched, never widen it.
  const roots = Array.isArray(raw["allowedCommandRoots"])
    ? (raw["allowedCommandRoots"] as unknown[])
        .map((entry) => readText(entry))
        .filter((entry) => entry.length > 0)
        .flatMap((entry) => {
          let expanded: string;
          try {
            expanded = expandConfiguredString(entry, ctxForRoots);
          } catch (error) {
            if (error instanceof MissingLocalSettingError) {
              return [];
            }
            throw error;
          }
          const abs = path.isAbsolute(expanded) || isWindowsAbsolutePath(expanded)
            ? expanded
            : path.resolve(base.configDir, expanded);
          return [path.normalize(abs)];
        })
    : [];

  return {
    allowedCommandRoots: roots,
    allowBareCommands: readBoolean(raw["allowBareCommands"], true),
    allowInsecureConfigPermissions: readBoolean(raw["allowInsecureConfigPermissions"], false),
  };
}

// Windows path comparison is case-insensitive and separator-agnostic; POSIX is
// neither. Platform is a parameter so the Windows rule can be exercised from a
// POSIX host — a Windows deployment's allow-list is routinely checked from a
// Linux workstation, and getting the answer wrong there is silent.
function normalizeForCompare(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === "win32" ? path.win32.normalize(value) : path.normalize(value);
  return platform === "win32" ? normalized.replace(/\//g, "\\").toLowerCase() : normalized;
}

// Symlink resolution is only meaningful on the host that owns the filesystem.
// Checking a Windows deployment's allow-list from Linux must not push a
// `D:\...` path through POSIX path functions, which would resolve it against
// the working directory and produce nonsense.
function resolveThroughExistingAncestor(target: string, platform: NodeJS.Platform): string {
  if (platform !== process.platform) {
    return target;
  }
  const segments: string[] = [];
  let current = target;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (existsSync(current)) {
        const resolved = realpathSync(current);
        return segments.length > 0 ? path.join(resolved, ...segments.reverse()) : resolved;
      }
    } catch {
      return target;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return target; // Reached the filesystem root without finding anything.
    }
    segments.push(path.basename(current));
    current = parent;
  }
  return target;
}

// Enforced at LAUNCH time (authoritative, uses the exact command that will be
// spawned on the current platform). Throws on violation.
export function assertCommandAllowed(
  resolvedCommand: string,
  policy: SecurityPolicy,
  platform: NodeJS.Platform = process.platform,
): void {
  const hasSeparator = resolvedCommand.includes("/") || resolvedCommand.includes("\\");

  if (!hasSeparator) {
    if (!policy.allowBareCommands) {
      throw new Error(
        `Process command '${resolvedCommand}' is a bare name resolved through the OS PATH, ` +
          `which is disabled by security.allowBareCommands=false. ` +
          `Use an absolute path to a wrapper inside an allowed command root.`,
      );
    }
    return;
  }

  const absolute = path.isAbsolute(resolvedCommand) || isWindowsAbsolutePath(resolvedCommand)
    ? resolvedCommand
    : path.resolve(resolvedCommand);

  if (policy.allowedCommandRoots.length === 0) {
    return; // No allow-list configured (a startup warning is emitted separately).
  }

  // Resolve symlinks so a symlink cannot escape a root. When the command itself
  // does not exist — the ordinary case for a machine that simply has not got it
  // installed — resolve the nearest ancestor that DOES and re-append the rest.
  // Without this, a root under a symlinked parent (macOS /var -> /private/var)
  // resolves while the absent command cannot, and a plainly missing file is
  // reported as a security refusal, sending the reader after the wrong problem.
  const candidate = resolveThroughExistingAncestor(absolute, platform);

  const separator = platform === "win32" ? "\\" : path.sep;
  const normalizedCandidate = normalizeForCompare(candidate, platform);
  const allowed = policy.allowedCommandRoots.some((root) => {
    // Resolved exactly like the candidate. Anything less is an asymmetry: a
    // command under a symlinked parent resolves to the real path while a root
    // that does not itself exist yet keeps the symlinked one, and the two stop
    // sharing a prefix — refusing a launch that is plainly inside its allowed
    // root. macOS makes this routine, since /var is a symlink to /private/var
    // and every temporary directory sits under it.
    const rootResolved = resolveThroughExistingAncestor(root, platform);
    const normalizedRoot = normalizeForCompare(rootResolved, platform);
    const withSep = normalizedRoot.endsWith(separator) ? normalizedRoot : normalizedRoot + separator;
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(withSep);
  });

  if (!allowed) {
    // Reports the path as configured, not the symlink-resolved form used for
    // the comparison above. Someone reading this has to find the string in
    // their own YAML; echoing an internally normalised variant of it (macOS
    // rewriting /var to /private/var, say) sends them looking for text they
    // never wrote.
    throw new Error(
      `Process command '${absolute}' is not inside any allowed command root ` +
        `(${policy.allowedCommandRoots.join(", ") || "<none configured>"}). ` +
        `Add its directory to security.allowedCommandRoots or move the wrapper into an allowed root.`,
    );
  }
}

// Enforced at LOAD time. Refuses a world-writable config file on POSIX systems
// unless explicitly allowed. No-op on Windows (POSIX mode bits are not meaningful).
export function assertConfigFilePermissions(configPath: string, policy: SecurityPolicy): void {
  if (os.platform() === "win32" || policy.allowInsecureConfigPermissions) {
    return;
  }
  let mode: number;
  try {
    mode = statSync(configPath).mode;
  } catch {
    return;
  }
  // 0o002 = writable by "other".
  if ((mode & 0o002) !== 0) {
    throw new Error(
      `Config file '${configPath}' is world-writable (mode ${(mode & 0o777).toString(8)}). ` +
        `Any user could rewrite it to launch arbitrary commands. ` +
        `Run: chmod o-w '${configPath}' (or set security.allowInsecureConfigPermissions: true to override).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Web URL validation (not platform-specific, so validated eagerly at load).
// ---------------------------------------------------------------------------

export function assertWebUrlAllowed(url: string, context: LaunchContext, scope?: ConfigItemScope): URL {
  const expanded = expandConfiguredString(url, context, scope ? { ...scope, field: "target.url" } : undefined);
  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    throw new Error(`Web target has a malformed URL: '${expanded}'.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only HTTP(S) URLs are allowed for web targets (got '${parsed.protocol}//' in '${expanded}').`);
  }
  return parsed;
}
