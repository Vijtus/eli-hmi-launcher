import { accessSync, appendFileSync, constants, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PreflightFinding, PreflightStatus } from "./preflight";
import type { SurveyResult } from "./workspace-survey";
import type { CatalogStatus } from "../shared/types";

// ---------------------------------------------------------------------------
// The field report: what a portable build leaves behind on the stick it was run
// from, so someone can hand the file back instead of describing symptoms over
// the phone.
//
// Two files, side by side:
//   *.md    a readable snapshot written at startup — what resolved, what did not
//   *.jsonl every launch and event appended live, for the run's full history
// ---------------------------------------------------------------------------

export type FieldReportTarget = {
  directory: string;
  reportPath: string;
  eventLogPath: string;
  // Why this location won, so the report can explain itself.
  origin: "explicit" | "portable" | "desktop" | "userData";
};

export type FieldReportEnvironment = {
  env: Record<string, string | undefined>;
  hostname: string;
  desktopDir: string;
  userDataDir: string;
  now: Date;
};

export const FIELD_REPORT_DIR_ENV = "ELI_LAUNCHER_FIELD_REPORT_DIR";
export const FIELD_REPORT_ENABLE_ENV = "ELI_LAUNCHER_FIELD_REPORT";
// electron-builder's portable target sets this to the directory holding the
// .exe — i.e. the USB stick or wherever the operator dropped it.
export const PORTABLE_DIR_ENV = "PORTABLE_EXECUTABLE_DIR";

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

// Filesystem-safe and still recognisable when twenty of these land in an inbox.
// Dots survive because FQDNs are legitimate hostnames (testz-deploy.eli.cz), but
// runs of them are collapsed so a hostile hostname cannot produce a filename
// that reads like a traversal. Separators are already gone by then, so the path
// itself was never at risk.
function safeHostname(hostname: string): string {
  const cleaned = hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "unknown-host";
}

function isWritable(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true });
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Ordered candidates. A read-only stick must not silently lose the report, so
// each location falls through to the next.
export function resolveFieldReportTarget(
  environment: FieldReportEnvironment,
  writable: (directory: string) => boolean = isWritable,
): FieldReportTarget | undefined {
  const { env } = environment;
  const explicit = env[FIELD_REPORT_DIR_ENV]?.trim();
  const portable = env[PORTABLE_DIR_ENV]?.trim();
  const forced = /^(1|true|yes|on)$/i.test(env[FIELD_REPORT_ENABLE_ENV]?.trim() ?? "");

  const candidates: Array<{ directory: string; origin: FieldReportTarget["origin"] }> = [];
  if (explicit) {
    candidates.push({ directory: explicit, origin: "explicit" });
  }
  if (portable) {
    candidates.push({ directory: portable, origin: "portable" });
  }
  // Only reach for the Desktop when recording was actually asked for; an
  // installed build should not start dropping files on someone's desktop.
  if (explicit || portable || forced) {
    candidates.push({ directory: environment.desktopDir, origin: "desktop" });
    candidates.push({ directory: environment.userDataDir, origin: "userData" });
  }

  for (const candidate of candidates) {
    if (!candidate.directory || !writable(candidate.directory)) {
      continue;
    }
    const stem = `ELI-Launcher-${safeHostname(environment.hostname)}-${timestamp(environment.now)}`;
    return {
      directory: candidate.directory,
      origin: candidate.origin,
      reportPath: path.join(candidate.directory, `${stem}-report.md`),
      eventLogPath: path.join(candidate.directory, `${stem}-events.jsonl`),
    };
  }
  return undefined;
}

// --- report rendering ------------------------------------------------------

const STATUS_LABEL: Record<PreflightStatus, string> = {
  ready: "READY",
  missing: "NOT ON THIS MACHINE",
  denied: "REFUSED BY SECURITY POLICY",
  unresolved: "CONFIG INCOMPLETE",
  "not-checked": "NOT CHECKED",
};

export type FieldReportInput = {
  appName: string;
  appVersion: string;
  hostname: string;
  configHostname?: string | undefined;
  platform: string;
  arch: string;
  electronVersion: string;
  configPath: string | undefined;
  configRepo?:
    | {
        url: string;
        ref: string;
        source: string;
        commitSha: string;
        fetchedAt?: string;
        zone?: string;
        hostFile?: string;
        zoneFile?: string;
        entryCount?: number;
      }
    | undefined;
  configRepoError?: string | undefined;
  catalogStatus?: CatalogStatus | undefined;
  findings: PreflightFinding[];
  survey?: SurveyResult[] | undefined;
  target: FieldReportTarget;
  startedAt: Date;
};

// Emits a complete two-column markdown table, header included — a table without
// one renders as literal pipes in every viewer.
function table(rows: Array<[string, string | undefined]>): string {
  const body = rows
    .filter((row): row is [string, string] => row[1] !== undefined && row[1] !== "")
    .map(([key, value]) => `| ${key} | ${value} |`);
  return ["| | |", "|---|---|", ...body].join("\n");
}

export function renderFieldReport(input: FieldReportInput): string {
  const counts = new Map<PreflightStatus, number>();
  for (const finding of input.findings) {
    counts.set(finding.status, (counts.get(finding.status) ?? 0) + 1);
  }
  const ready = counts.get("ready") ?? 0;
  const total = input.findings.length;

  const lines: string[] = [];
  lines.push(`# ${input.appName} — field report`);
  lines.push("");
  lines.push(`**${ready} of ${total} entries would launch on this machine.**`);
  lines.push("");
  lines.push(
    table([
      ["Machine", input.hostname],
      ["Identified to config as", input.configHostname ?? input.hostname],
      ["Platform", `${input.platform} ${input.arch}`],
      ["App version", input.appVersion],
      ["Electron", input.electronVersion],
      ["Started", input.startedAt.toISOString()],
      ["Config file", input.configPath ?? "(none resolved)"],
      ["Report written to", input.target.directory],
    ]),
  );
  lines.push("");

  lines.push("## Catalog source");
  lines.push("");
  if (input.configRepoError) {
    lines.push(`**The config repo could not be used.**`);
    lines.push("");
    lines.push("```");
    lines.push(input.configRepoError);
    lines.push("```");
  } else if (input.configRepo) {
    lines.push(
      table([
        ["Repo", input.configRepo.url],
        ["Ref", input.configRepo.ref],
        ["Fetched", input.configRepo.source],
        ["Fetched at", input.configRepo.fetchedAt],
        ["Commit", input.configRepo.commitSha],
        ["Zone", input.configRepo.zone],
        ["Host file", input.configRepo.hostFile],
        ["Zone file", input.configRepo.zoneFile],
        ["Entries from repo", input.configRepo.entryCount?.toString()],
      ]),
    );
  } else {
    lines.push("No config repo configured; the catalog came from the local config file only.");
  }
  if (input.catalogStatus?.stale) {
    lines.push("");
    lines.push("> **CATALOG STALE** — at least one source could not be refreshed and a cached copy was used.");
  }
  for (const warning of input.catalogStatus?.warnings ?? []) {
    lines.push(`- warning: ${warning}`);
  }
  lines.push("");

  const order: PreflightStatus[] = ["unresolved", "denied", "missing", "not-checked", "ready"];
  const problems = input.findings.filter((f) => f.status !== "ready");

  lines.push("## What is not working");
  lines.push("");
  if (input.findings.length === 0) {
    // "every entry resolved" is a lie when there were no entries to resolve.
    lines.push(
      "The catalog never loaded, so no entry could be checked. See **Catalog source** above " +
        "for the reason — that is the problem to fix first.",
    );
  } else if (problems.length === 0) {
    lines.push("Nothing — every catalog entry resolved to a runnable command on this machine.");
  } else {
    for (const status of order.filter((s) => s !== "ready")) {
      const group = input.findings.filter((f) => f.status === status);
      if (group.length === 0) {
        continue;
      }
      lines.push(`### ${STATUS_LABEL[status]} (${group.length})`);
      lines.push("");
      for (const finding of group) {
        lines.push(`- **${finding.name}** \`${finding.id}\` (${finding.kind})`);
        if (finding.resolvedCommand) {
          lines.push(`  - resolved to: \`${finding.resolvedCommand}\``);
        }
        if (finding.detail) {
          lines.push(`  - ${finding.detail}`);
        }
      }
      lines.push("");
    }
  }
  lines.push("");

  lines.push("## What is working");
  lines.push("");
  const good = input.findings.filter((f) => f.status === "ready");
  if (input.findings.length === 0) {
    lines.push("Nothing was checked — the catalog did not load.");
  } else if (good.length === 0) {
    lines.push("Nothing resolved successfully.");
  } else {
    for (const finding of good) {
      const where = finding.resolvedCommand ? ` — \`${finding.resolvedCommand}\`` : "";
      lines.push(`- **${finding.name}** \`${finding.id}\` (${finding.kind})${where}`);
      if (finding.detail) {
        lines.push(`  - ${finding.detail}`);
      }
    }
  }
  lines.push("");

  // What is actually on disk, as opposed to what the config expected to find.
  // When a configured path is wrong, this is the section that shows the right one.
  if (input.survey && input.survey.length > 0) {
    lines.push("## What is actually on this machine");
    lines.push("");
    for (const entry of input.survey) {
      lines.push(`### \`${entry.root}\``);
      lines.push("");
      if (!entry.exists) {
        lines.push(`**Not usable** — ${entry.reason ?? "unavailable"}.`);
        lines.push("");
        continue;
      }
      lines.push(
        `Folders directly inside: ${
          entry.topLevel.length > 0 ? entry.topLevel.map((n) => `\`${n}\``).join(", ") : "_(none)_"
        }`,
      );
      lines.push("");
      if (entry.executables.length === 0) {
        lines.push("No executables found beneath it.");
      } else {
        lines.push(`Executables found (${entry.executables.length}):`);
        lines.push("");
        lines.push("```");
        for (const executable of entry.executables) {
          lines.push(executable);
        }
        lines.push("```");
      }
      if (entry.truncated) {
        lines.push("");
        lines.push(`> Survey was cut short: ${entry.reason ?? "limit reached"}.`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `Live events for this run are appended to \`${path.basename(input.target.eventLogPath)}\` ` +
      "in this folder. Send both files back together.",
  );
  lines.push("");
  return lines.join("\n");
}

// --- live event sink -------------------------------------------------------

let eventLogPath = "";
let warnedOnce = false;

export function startFieldEventLog(filePath: string): void {
  eventLogPath = filePath;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // Reported lazily on first write; never block startup over a log file.
  }
}

export function getFieldEventLogPath(): string {
  return eventLogPath;
}

// Mirrors whatever the normal logger records. Failures are swallowed after one
// warning: a USB stick pulled mid-run must not take the launcher down with it.
export function appendFieldEvent(record: Record<string, unknown>): void {
  if (!eventLogPath) {
    return;
  }
  try {
    appendFileSync(eventLogPath, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.error(
        `Field event log write failed (${eventLogPath}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function defaultDesktopDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, "Desktop");
}
