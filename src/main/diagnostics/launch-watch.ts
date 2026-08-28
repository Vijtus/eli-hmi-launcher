import { readFile, stat } from "node:fs/promises";
import { inspectProcess } from "../runtime/process";
import { redactCapturedOutput } from "./log";

// A successful spawn is not proof that a GUI stayed alive. Watch the process
// briefly so immediate exits and diagnostic output are recorded accurately.

export type LaunchOutcome =
  // Still running when we stopped watching — the good case.
  | "still-running"
  // Started, then exited within the watch window. Almost always a failure the
  // operator saw as an error dialog.
  | "exited-early"
  // Could not be determined (permissions, inspector unavailable).
  | "unknown";

export type LaunchWatchResult = {
  outcome: LaunchOutcome;
  /** How long after spawn it was last observed alive. */
  observedForMs: number;
  /** Anything the process printed, trimmed to the tail. */
  output?: string | undefined;
  reason?: string | undefined;
};

// Deliberately short: an operator is standing there, and a GUI that survives ten
// seconds has got past its startup errors. Anything longer buys little.
export const DEFAULT_WATCH_CHECKPOINTS_MS = [1_000, 3_000, 10_000];

const MAX_OUTPUT_BYTES = 8_000;

async function readTail(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }
  try {
    const info = await stat(filePath);
    if (info.size === 0) {
      return undefined;
    }
    const text = await readFile(filePath, "utf8");
    const trimmed = redactCapturedOutput(text.trimEnd());
    return trimmed.length > MAX_OUTPUT_BYTES
      ? `…(truncated)…\n${trimmed.slice(-MAX_OUTPUT_BYTES)}`
      : trimmed;
  } catch {
    return undefined;
  }
}

export async function watchLaunch(
  pid: number,
  captureFile: string | undefined,
  checkpointsMs: number[] = DEFAULT_WATCH_CHECKPOINTS_MS,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<LaunchWatchResult> {
  let elapsed = 0;
  let lastAliveAt = 0;

  for (const checkpoint of checkpointsMs) {
    await sleep(checkpoint - elapsed);
    elapsed = checkpoint;

    const observation = await inspectProcess(pid);
    if (observation.alive) {
      lastAliveAt = elapsed;
      continue;
    }
    return {
      outcome: "exited-early",
      observedForMs: lastAliveAt,
      output: await readTail(captureFile),
      reason: observation.reason ?? `no longer running ${elapsed} ms after launch`,
    };
  }

  const output = await readTail(captureFile);
  return {
    outcome: "still-running",
    observedForMs: elapsed,
    ...(output ? { output } : {}),
  };
}
