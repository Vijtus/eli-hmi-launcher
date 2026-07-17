// Structured, append-only diagnostics log, independent of the mock launch
// scripts. One JSON object per line (JSONL). Logging must never break a launch,
// so every write is wrapped and failures are swallowed after a single warning.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { LaunchTarget } from "../shared/types";

let logFilePath = "";
let warnedOnce = false;

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
  if (!logFilePath) {
    return;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
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

function describeTarget(target: LaunchTarget, resolvedCommand?: string): Record<string, unknown> {
  if (target.kind === "web") {
    return { kind: "web", url: target.url };
  }
  if (target.kind === "folder") {
    return { kind: "folder", path: target.path };
  }
  return {
    kind: "process",
    command: resolvedCommand ?? target.command,
    args: target.args ?? [],
  };
}

export type LaunchLogInput = {
  id: string;
  label: string;
  target: LaunchTarget;
  resolvedCommand?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
};

export function logLaunch(input: LaunchLogInput): void {
  write({
    type: "launch",
    id: input.id,
    label: input.label,
    ...describeTarget(input.target, input.resolvedCommand),
    ok: input.ok,
    ...(input.error ? { error: input.error } : {}),
    durationMs: input.durationMs,
  });
}

export function logEvent(level: "info" | "warn" | "error", message: string, extra: Record<string, unknown> = {}): void {
  write({ type: "event", level, message, ...extra });
}
