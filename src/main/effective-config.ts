// FR7 — a fully-resolved, redacted view of the effective configuration, for
// on-site troubleshooting.
//
// Reachable two ways:
//   npm run dump-config            (headless, no Electron)
//   the launcher logs it at debug level on every start
//
// Redaction reuses the launch log's SENSITIVE_NAME rule, so a key that would be
// scrubbed from a launch record is scrubbed here too.

import type { ParsedConfig } from "./config";
import type { ConfigRepoProvenance } from "../shared/types";
import { REDACTED, SENSITIVE_NAME } from "./logger";

export type EffectiveConfig = Record<string, unknown>;

export function redactDeep(value: unknown, keyName = ""): unknown {
  if (keyName && SENSITIVE_NAME.test(keyName) && typeof value !== "object") {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactDeep(item, key);
    }
    return result;
  }
  if (typeof value === "string") {
    // Strip userinfo from any URL, whatever the key is called.
    return value.replace(/(\bhttps?:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`);
  }
  return value;
}

export function buildEffectiveConfig(
  parsed: ParsedConfig,
  provenance?: ConfigRepoProvenance | undefined,
): EffectiveConfig {
  const entries = parsed.rows.map((row) => ({
    ...row,
    target: parsed.targetsById.get(row.id),
    access: parsed.accessPoliciesById.get(row.id),
  }));
  return redactDeep({
    appName: parsed.appName,
    ...(provenance ? { configRepo: provenance } : {}),
    local: parsed.context.local,
    security: parsed.context.security,
    catalogStatus: parsed.catalogStatus,
    entryCount: entries.length,
    entries,
    quickActions: parsed.quickActions.map((action) => ({
      ...action,
      target: parsed.targetsById.get(action.id),
    })),
    moreActions: parsed.moreActions.map((action) => ({
      ...action,
      target: parsed.targetsById.get(action.id),
    })),
  }) as EffectiveConfig;
}
