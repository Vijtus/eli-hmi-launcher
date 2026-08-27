// Structured, append-only diagnostics log, independent of the mock launch
// scripts. One JSON object per line (JSONL). Logging must never break a launch,
// so every write is wrapped and failures are swallowed after a single warning.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { appendFieldEvent } from "./report";
import type { LaunchTarget } from "../../shared/types";

let logFilePath = "";
let warnedOnce = false;
export const REDACTED = "[REDACTED]";
// Shared with effective-config.ts so the troubleshooting dump redacts exactly
// what the launch log redacts.
export const SENSITIVE_NAME = /(?:^|[-_])(password|passwd|token|secret|api[-_]?key|authorization|credential|auth)(?:$|[-_])/i;

export function initLogger(filePath: string): void {
  logFilePath = filePath;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // Directory creation failure is reported lazily on first write.
  }
}

export function getLogFilePath(): string {
  return logFilePath;
}

function write(record: Record<string, unknown>): void {
  const stamped = { ts: new Date().toISOString(), ...record };
  // A portable run also mirrors everything next to the executable, so the
  // operator can hand back one folder instead of hunting for the userData log.
  // Already redacted by the callers below, so nothing extra leaks here.
  appendFieldEvent(stamped);

  if (!logFilePath) {
    return;
  }
  const line = JSON.stringify(stamped) + "\n";
  try {
    appendFileSync(logFilePath, line, "utf8");
  } catch (error) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.error(`Launch log write failed (${logFilePath}):`, error instanceof Error ? error.message : error);
    }
  }
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = REDACTED;
    }
    if (url.password) {
      url.password = REDACTED;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_NAME.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

// Free-form text captured from a launched program, on its way into a report
// that gets sent to other people. Nothing here can know what a given program
// prints, so this is a net rather than a guarantee: assignments whose NAME looks
// like a secret lose their value, and URLs lose any embedded userinfo. The site
// keeps ChannelFinder credentials in the Phoebus settings files these programs
// read, so a failure that echoes its configuration is not hypothetical.
export function redactCapturedOutput(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.replace(
        /([A-Za-z0-9_.\-]*[A-Za-z0-9])\s*[=:]\s*(\S+)/g,
        (match, name: string, value: string) => {
          if (!SENSITIVE_NAME.test(name)) {
            return /^https?:\/\//i.test(value) ? `${name}=${redactUrl(value)}` : match;
          }
          return `${name}=${REDACTED}`;
        },
      ),
    )
    .join("\n");
}

export function redactLaunchArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }

    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (SENSITIVE_NAME.test(name)) {
      if (equalsIndex >= 0) {
        return `${name}=${REDACTED}`;
      }
      redactNext = true;
      return arg;
    }

    if (/^https?:\/\//i.test(arg)) {
      return redactUrl(arg);
    }
    return arg;
  });
}

function describeTarget(
  target: LaunchTarget,
  resolvedCommand?: string,
  resolvedArgs?: string[],
): Record<string, unknown> {
  if (target.kind === "web") {
    return { kind: "web", url: redactUrl(target.url) };
  }
  if (target.kind === "folder") {
    return { kind: "folder", path: target.path };
  }
  if (target.kind === "labview-dev") {
    return {
      kind: "labview-dev",
      command: resolvedCommand,
      args: redactLaunchArgs(resolvedArgs ?? []),
      iocName: target.iocName,
      hostName: target.hostName,
      iocType: target.iocType,
      exeName: target.exeName,
    };
  }
  if (target.kind === "labview-epics") {
    return {
      kind: "labview-epics",
      command: resolvedCommand,
      args: redactLaunchArgs(resolvedArgs ?? []),
      guiName: target.guiName,
      guiType: target.guiType,
      exeName: target.exeName,
    };
  }
  if (target.kind === "phoebus") {
    return {
      kind: "phoebus",
      command: resolvedCommand,
      args: redactLaunchArgs(resolvedArgs ?? []),
      ...(target.resource ? { resource: redactUrl(target.resource) } : {}),
      ...(target.app ? { app: target.app } : {}),
      ...(target.layout ? { layout: true } : {}),
    };
  }
  return {
    kind: "process",
    command: resolvedCommand ?? target.command,
    args: redactLaunchArgs(resolvedArgs ?? target.args ?? []),
  };
}

export type LaunchLogInput = {
  id: string;
  label: string;
  target: LaunchTarget;
  resolvedCommand?: string;
  resolvedArgs?: string[];
  ok: boolean;
  error?: string;
  durationMs: number;
};

export function logLaunch(input: LaunchLogInput): void {
  write({
    type: "launch",
    id: input.id,
    label: input.label,
    ...describeTarget(input.target, input.resolvedCommand, input.resolvedArgs),
    ok: input.ok,
    ...(input.error ? { error: input.error } : {}),
    durationMs: input.durationMs,
  });
}

export function logEvent(level: "debug" | "info" | "warn" | "error", message: string, extra: Record<string, unknown> = {}): void {
  write({ type: "event", level, message, ...extra });
}
