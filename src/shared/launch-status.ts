import type { LaunchResult } from "./types";

export type LaunchStatus = { message: string; isError: true } | null;

// Maps a launch result to what the status region should show. Successful
// launches are intentionally silent: null means "clear any previous message
// and show nothing". Failures always produce a visible, actionable message.
export function statusForLaunchResult(result: LaunchResult): LaunchStatus {
  if (result.ok) {
    return null;
  }
  return { message: `Launch failed: ${result.label} — ${result.error}`, isError: true };
}
