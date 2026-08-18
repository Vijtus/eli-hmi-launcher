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

export type LabviewDeveloperLaunchTarget = {
  kind: "labview-dev";
  iocName: string;
  hostName: string;
  iocType: string;
  exeName: string;
};

export type LabviewEpicsLaunchTarget = {
  kind: "labview-epics";
  guiName: string;
  guiType: string;
  exeName: string;
};

export type PhoebusLaunchTarget = {
  kind: "phoebus";
  resource?: string;
  app?: string;
  layout?: boolean;
};

export type LaunchTarget =
  | ProcessLaunchTarget
  | WebLaunchTarget
  | FolderLaunchTarget
  | LabviewDeveloperLaunchTarget
  | LabviewEpicsLaunchTarget
  | PhoebusLaunchTarget;

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

export type CatalogSourceState = "inline" | "fresh" | "cached" | "unavailable";

export type CatalogSourceStatus = {
  id: string;
  path?: string;
  state: CatalogSourceState;
  stale: boolean;
  entryCount: number;
  message?: string;
  cachePath?: string;
  loadedAt?: string;
};

// Provenance of the git-backed configuration, surfaced so an operator can tell a
// fresh start from one running on a cached commit (NFR3/NFR8).
export type ConfigRepoProvenance = {
  url: string;
  ref: string;
  commitSha: string;
  fetchedAt: string;
  source: "fresh" | "cached";
  cacheDir: string;
  hostname: string;
  hostnameSource: "env" | "os";
  hostFile: string;
  zone: string;
  zoneFile: string;
  entryCount: number;
};

export type CatalogStatus = {
  stale: boolean;
  sources: CatalogSourceStatus[];
  warnings: string[];
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

export type LocalPhoebusConfig = {
  // Phoebus install DIRECTORY. When `executable` is absent it is derived from
  // this plus the platform launcher script name. Fed by the config repo's
  // `css-install` host key.
  installRoot?: string;
  executable?: string;
  serverPort?: number;
  settingsFile?: string;
  layoutFile?: string;
  startupTimeoutMs?: number;
  resourceReadyDelayMs?: number;
};

export type LocalHmiApiConfig = {
  baseUrl?: string;
  stationId?: string;
  authTokenEnv?: string;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  // Opt-in for a lifecycle API reached over plain HTTP on a trusted site LAN.
  // Set automatically when the config repo's `hmi-server` key gives a bare
  // `host:port` with no scheme. It never permits sending a token in cleartext —
  // HTTP combined with `authTokenEnv` is refused outright.
  allowInsecureTransport?: boolean;
};

export type LocalMonitoringConfig = {
  reconcileIntervalMs?: number;
};

// Machine-specific values are intentionally optional. A setting becomes
// mandatory only when an enabled launcher item references it or a typed target
// requires it. This keeps web-only and portable configs usable without local
// LabVIEW/Phoebus installation details.
export type LocalMachineConfig = {
  workspaceRoot?: string;
  cssGuiRoot?: string;
  zoneSymbol?: string;
  phoebus: LocalPhoebusConfig;
  hosts: Record<string, string>;
  hmiApi: LocalHmiApiConfig;
  monitoring: LocalMonitoringConfig;
};

export type LauncherConfig = {
  appName: string;
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
  catalogStatus: CatalogStatus;
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

export type RuntimeObservationModel = "pid" | "phoebus-port" | "external-handoff";

export type RuntimeStatus = "running" | "stopped" | "shared" | "handed-off" | "unknown";

export type RuntimeItemState = {
  id: string;
  kind: LaunchTarget["kind"];
  model: RuntimeObservationModel;
  status: RuntimeStatus;
  runningInstances: number;
  totalInstances: number;
  launchedAt: string;
  lastSeenAt?: string;
  stale: boolean;
  detail: string;
};

export type RuntimeSnapshot = {
  generatedAt: string;
  reconcileIntervalMs: number;
  items: RuntimeItemState[];
  hmiApi?: HmiApiHealth;
};

export type HmiApiHealthStatus =
  | "disabled"
  | "connected"
  | "unavailable"
  | "misconfigured";

export type HmiApiHealth = {
  status: HmiApiHealthStatus;
  reason?: string;
  lastSuccessAt?: string;
};

export type LaunchAccessMode = "read" | "write" | "unknown";

export type AlreadyRunningAction = "block" | "focus" | "prompt";

export type UnknownStateAction = "block" | "allow";

// `maxInstances: null` is meaningful in an override: it clears a stricter
// platform/default limit so a write-mode-only policy can be expressed.
export type LaunchAccessPolicyOverride = {
  maxInstances?: number | null;
  writeModeExclusive?: boolean;
  launchMode?: LaunchAccessMode;
  onAlreadyRunning?: AlreadyRunningAction;
  onUnknownState?: UnknownStateAction;
};

export type LaunchAccessPolicy = {
  maxInstances?: number;
  writeModeExclusive: boolean;
  launchMode: LaunchAccessMode;
  onAlreadyRunning: AlreadyRunningAction;
  onUnknownState: UnknownStateAction;
};
