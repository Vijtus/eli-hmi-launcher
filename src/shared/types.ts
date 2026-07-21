// Shared types used by main, preload, and renderer.
// Keep this file dependency-free so every layer can import it.

export type ProcessTargetOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type ProcessLaunchTarget = ProcessTargetOptions & {
  kind: "process";
  command: string;
  windows?: ProcessTargetOptions;
  linux?: ProcessTargetOptions;
  darwin?: ProcessTargetOptions;
};

export type WebLaunchTarget = {
  kind: "web";
  url: string;
};

export type FolderLaunchTarget = {
  kind: "folder";
  path: string;
};

export type LaunchTarget = ProcessLaunchTarget | WebLaunchTarget | FolderLaunchTarget;

export type LauncherRow = {
  id: string;
  name: string;
  technology: string[];
  section: string[];
  platform: string;
  rmc: string;
  note: string;
};

export type LauncherAction = {
  id: string;
  label: string;
};

// Security policy that governs what process targets are allowed to run.
// Resolved from the optional top-level `security:` block in the YAML config.
export type SecurityPolicy = {
  // Absolute directory prefixes that a resolved process `command` must live under.
  // Empty list = no directory restriction (a warning is logged at startup).
  allowedCommandRoots: string[];
  // When false, a process `command` with no path separator (a bare name resolved
  // through the OS PATH, e.g. `sh`, `python`) is rejected.
  allowBareCommands: boolean;
  // When false (default), the launcher refuses to load a config file that is
  // world-writable on POSIX systems. Ignored on Windows (no POSIX mode bits).
  allowInsecureConfigPermissions: boolean;
};

export type LauncherConfig = {
  appName: string;
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
};

// Discriminated result returned by the launch IPC channel so the renderer can
// render precise success/failure state instead of only catching thrown errors.
export type LaunchOk = {
  ok: true;
  id: string;
  label: string;
  kind: LaunchTarget["kind"];
  launchedAt: string;
};

export type LaunchFailure = {
  ok: false;
  id: string;
  label: string;
  kind: LaunchTarget["kind"] | "unknown";
  error: string;
  launchedAt: string;
};

export type LaunchResult = LaunchOk | LaunchFailure;
