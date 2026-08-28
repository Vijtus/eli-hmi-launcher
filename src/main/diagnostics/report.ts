import { accessSync, appendFileSync, constants, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PreflightFinding, PreflightStatus } from "./preflight";
import type { SurveyResult } from "./workspace";
import type { CatalogStatus } from "../../shared/types";

// Diagnostics write a readable startup snapshot and an append-only JSONL event
// log so launch failures can be investigated without reproducing them live.

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
    // One folder per run. A single run writes a report, an event log and one
    // capture file per launch; scattering those across a Desktop turns five
    // runs into forty loose files and makes the set you actually want hard to
    // pick out and hard to send on.
    const stem = `ELI-Launcher-${safeHostname(environment.hostname)}-${timestamp(environment.now)}`;
    const runDirectory = path.join(candidate.directory, stem);
    if (!writable(runDirectory)) {
      continue;
    }
    return {
      directory: runDirectory,
      origin: candidate.origin,
      reportPath: path.join(runDirectory, "report.md"),
      eventLogPath: path.join(runDirectory, "events.jsonl"),
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

// One click and what came of it. The startup report describes what COULD run;
// this describes what the operator actually tried.
export type SessionLaunch = {
  id: string;
  label: string;
  ok: boolean;
  command?: string | undefined;
  args?: string[] | undefined;
  error?: string | undefined;
  at: string;
  /** What became of it shortly after launch, when it was watched. */
  outcome?: "still-running" | "exited-early" | "unknown" | undefined;
  observedForMs?: number | undefined;
  /** Anything the process printed — usually the actual error text. */
  output?: string | undefined;
};

export type FieldReportInput = {
  title: string;
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
  launches?: SessionLaunch[] | undefined;
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

// A report that lists every panel on the machine and separately says a panel is
// missing leaves the reader to join the two by eye. The basename is enough to
// join them here: a configured pm.bob that does not exist, and a pm.bob that
// does, are almost certainly the same file at a path nobody had checked.
function suggestionsFor(
  finding: PreflightFinding,
  survey: SurveyResult[] | undefined,
): string[] {
  const configured = finding.resolvedCommand;
  if (!configured || finding.status !== "missing" || !survey) {
    return [];
  }
  const wanted = path.basename(configured.replace(/\\/g, "/")).toLowerCase();
  if (!wanted) {
    return [];
  }
  const hits: string[] = [];
  for (const entry of survey) {
    for (const candidate of [...entry.panels, ...entry.executables]) {
      if (path.basename(candidate.replace(/\\/g, "/")).toLowerCase() === wanted) {
        // Joined the way the deployment writes paths, not the way the host
        // rendering the report does. This report is routinely produced on Linux
        // for a Windows machine, and `C:\\Workspaces\\css-gui/panel\\pm.bob` is not
        // pasteable — in the one line whose whole purpose is to hand over a path.
        const joiner = /^[A-Za-z]:[\\/]|^\\\\/.test(entry.root) ? path.win32 : path.posix;
        hits.push(joiner.join(entry.root, candidate));
      }
    }
  }
  return [...new Set(hits)].slice(0, 5);
}

export function renderFieldReport(input: FieldReportInput): string {
  const counts = new Map<PreflightStatus, number>();
  for (const finding of input.findings) {
    counts.set(finding.status, (counts.get(finding.status) ?? 0) + 1);
  }
  const ready = counts.get("ready") ?? 0;
  const total = input.findings.length;

  const lines: string[] = [];
  lines.push(`# ${input.title} — field report`);
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
        for (const suggestion of suggestionsFor(finding, input.survey)) {
          lines.push(`  - **found a file with that name here:** \`${suggestion}\``);
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

  // Resolving a path only proves a file is there. This is the part that says
  // whether pressing the button actually started anything, which is the
  // question the whole exercise is really asking.
  lines.push("## What was launched in this session");
  lines.push("");
  if (!input.launches || input.launches.length === 0) {
    lines.push("Nothing was clicked during this run.");
  } else {
    const started = input.launches.filter((launch) => launch.ok).length;
    lines.push(`**${started} of ${input.launches.length} launch attempts started a process.**`);
    lines.push("");
    for (const launch of input.launches) {
      // A process that spawned and then died is the case an operator sees as an
      // error dialog, and it must not read as a success.
      const verdict = !launch.ok
        ? "**FAILED TO START**"
        : launch.outcome === "exited-early"
          ? "**STARTED THEN QUIT**"
          : launch.outcome === "still-running"
            ? "**RUNNING**"
            : "**STARTED**";
      lines.push(`- ${verdict} — ${launch.label} \`${launch.id}\` at ${launch.at}`);
      if (launch.outcome === "exited-early") {
        lines.push(
          `  - exited about ${Math.round((launch.observedForMs ?? 0) / 100) / 10}s after launching — ` +
            "it did not stay open",
        );
      } else if (launch.outcome === "still-running") {
        lines.push(`  - still running ${Math.round((launch.observedForMs ?? 0) / 1000)}s later`);
      }
      if (launch.command) {
        lines.push(`  - command: \`${launch.command}\``);
      }
      if (launch.args && launch.args.length > 0) {
        lines.push(`  - args: \`${JSON.stringify(launch.args)}\``);
      }
      if (launch.error) {
        lines.push(`  - ${launch.error}`);
      }
      if (launch.output) {
        lines.push("  - what it printed:");
        lines.push("");
        lines.push("    ```");
        for (const line of launch.output.split("\n")) {
          lines.push(`    ${line}`);
        }
        lines.push("    ```");
      }
    }
    lines.push("");
    lines.push(
      "_RUNNING means the process was still alive ten seconds after launching. It is still " +
        "not proof the RIGHT program opened: several entries can resolve to real but different " +
        "executables. Compare against what appeared on screen._",
    );
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
      // Phoebus reports a missing panel itself but cannot say where the file
      // really is. This is the section that answers that.
      if (entry.panels.length > 0) {
        lines.push(`Phoebus panels found (${entry.panels.length}):`);
        lines.push("");
        lines.push("```");
        for (const panel of entry.panels) {
          lines.push(panel);
        }
        lines.push("```");
        lines.push("");
      }
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
      lines.push("");
      lines.push(`_Scanned ${entry.scanned} directory entries._`);
      if (entry.truncated) {
        lines.push("");
        lines.push(
          `> **Survey was cut short: ${entry.reason ?? "limit reached"}.** ` +
            "Anything below is therefore incomplete — absence here is not proof of absence on disk.",
        );
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
