import type {
  CatalogSourceState,
  CatalogStatus,
  LaunchAccessPolicy,
  LaunchAccessPolicyOverride,
  LaunchTarget,
  LauncherAction,
  LauncherRow,
  LocalMachineConfig,
  SecurityPolicy,
} from "../../shared/types";

export type RawObject = Record<string, unknown>;

export type LaunchContext = {
  appRoot: string;
  configDir: string;
  security: SecurityPolicy;
  local: LocalMachineConfig;
};

export type ConfigItemScope = {
  id: string;
  kind: LaunchTarget["kind"];
  group: "entry" | "quick action" | "more action";
  field?: string;
};

export type ConfiguredRow = LauncherRow & {
  target: LaunchTarget;
  access?: LaunchAccessPolicyOverride;
};

export type ConfiguredAction = LauncherAction & {
  target: LaunchTarget;
  access?: LaunchAccessPolicyOverride;
};

export type ParsedConfig = {
  productName: string;
  siteName?: string;
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
  targetsById: Map<string, LaunchTarget>;
  labelsById: Map<string, string>;
  accessPoliciesById: Map<string, LaunchAccessPolicy>;
  context: LaunchContext;
  catalogStatus: CatalogStatus;
};

export type ConfigEntrySource = {
  id: string;
  entries: unknown;
  state?: CatalogSourceState;
  stale?: boolean;
  path?: string;
  loadedAt?: string;
  message?: string;
};

// Remote operational configuration intentionally excludes security/access.
// Those policies remain owned by the local root file.
export type ConfigOverlay = {
  local?: Record<string, unknown>;
  entrySources?: ConfigEntrySource[];
  siteName?: string;
  quickActions?: unknown;
  moreActions?: unknown;
  warnings?: string[];
};

export type ConfigLoadBase = {
  appRoot: string;
  configDir: string;
  catalogCacheDir?: string;
  overlay?: ConfigOverlay;
};
