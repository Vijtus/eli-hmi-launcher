import { writeFile } from "node:fs/promises";
import path from "node:path";
import { redactError } from "../catalog/auth";
import type { DynamicConfigResult } from "../catalog/load";
import type { ParsedConfig } from "../config/load";
import { PRODUCT_NAME, type FieldReportInfo } from "../../shared/types";
import { watchLaunch as observeLaunch } from "./launch-watch";
import { logEvent } from "./log";
import { preflightConfig, type PreflightFinding } from "./preflight";
import {
  defaultDesktopDir,
  renderFieldReport,
  resolveFieldReportTarget,
  startFieldEventLog,
  type FieldReportInput,
  type FieldReportTarget,
  type SessionLaunch,
} from "./report";
import { surveyRoots, type SurveyResult } from "./workspace";

type DiagnosticsSessionOptions = {
  appVersion: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  electronVersion: string;
  homeDir: string;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  getConfig(): ParsedConfig | undefined;
};

type ReportContext = {
  configPath: string | undefined;
  gitConfig: DynamicConfigResult | undefined;
  findings: PreflightFinding[];
  survey: SurveyResult[];
};

export type DiagnosticsSession = {
  start(): void;
  info(): FieldReportInfo | null;
  captureFileFor(itemId: string): string | undefined;
  recordLaunch(entry: SessionLaunch): void;
  watchLaunch(itemId: string, pid: number | undefined, captureTo: string | undefined): void;
  writeStartup(configPath: string | undefined, gitConfig: DynamicConfigResult | undefined): void;
  writeStartupFailure(configPath: string | undefined, failure: string): Promise<void>;
  rewriteOnExit(): Promise<void>;
};

export function createDiagnosticsSession(options: DiagnosticsSessionOptions): DiagnosticsSession {
  let target: FieldReportTarget | undefined;
  let startupReport: Promise<void> | undefined;
  let lastContext: ReportContext | undefined;
  const launches: SessionLaunch[] = [];
  const pendingWatches = new Set<Promise<void>>();
  const startedAt = new Date();

  function reportEnvelope(
    configPath: string | undefined,
    gitConfig: DynamicConfigResult | undefined,
  ): Pick<
    FieldReportInput,
    | "title"
    | "appVersion"
    | "hostname"
    | "configHostname"
    | "platform"
    | "arch"
    | "electronVersion"
    | "configPath"
    | "configRepo"
    | "catalogStatus"
    | "startedAt"
  > {
    const config = options.getConfig();
    const provenance = gitConfig?.provenance;
    return {
      title: config?.siteName ? `${config.productName} — ${config.siteName}` : (config?.productName ?? PRODUCT_NAME),
      appVersion: options.appVersion,
      hostname: options.hostname,
      configHostname: options.env["ELI_LAUNCHER_CONFIG_HOSTNAME"],
      platform: options.platform,
      arch: options.arch,
      electronVersion: options.electronVersion,
      configPath,
      ...(provenance
        ? {
            configRepo: {
              url: redactError(
                provenance.url,
                options.env["ELI_LAUNCHER_CONFIG_REPO_TOKEN"],
                options.env["ELI_LAUNCHER_CONFIG_REPO_USERNAME"],
              ),
              ref: provenance.ref,
              source: provenance.source,
              commitSha: provenance.commitSha,
              fetchedAt: provenance.fetchedAt,
              zone: provenance.zone,
              hostFile: provenance.hostFile,
              zoneFile: provenance.zoneFile,
              entryCount: provenance.entryCount,
            },
          }
        : {}),
      ...(config ? { catalogStatus: config.catalogStatus } : {}),
      startedAt,
    };
  }

  async function settlePendingWatches(limitMs = 12_000): Promise<void> {
    if (pendingWatches.size === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled([...pendingWatches]),
      new Promise((resolve) => setTimeout(resolve, limitMs)),
    ]);
  }

  async function writeReport(
    configPath: string | undefined,
    gitConfig: DynamicConfigResult | undefined,
    configRepoError?: string,
  ): Promise<void> {
    const config = options.getConfig();
    if (!target || !config) {
      return;
    }

    try {
      const findings = await preflightConfig(config);
      const missingCommandFolders = findings
        .filter((finding) => finding.status === "missing" && finding.resolvedCommand)
        .map((finding) => path.win32.dirname(path.win32.dirname(finding.resolvedCommand as string)));
      const everythingResolved = findings.every((finding) => finding.status === "ready");
      const surveyRootsToCheck = everythingResolved
        ? []
        : [
            ...missingCommandFolders,
            config.context.local.workspaceRoot ?? "",
            config.context.local.cssGuiRoot ?? "",
            ...config.context.security.allowedCommandRoots,
          ].filter((root) => root.trim());
      const survey = await surveyRoots(surveyRootsToCheck);
      lastContext = { configPath, gitConfig, findings, survey };
      await writeFile(
        target.reportPath,
        renderFieldReport({
          ...reportEnvelope(configPath, gitConfig),
          configRepoError,
          findings,
          launches,
          survey,
          target,
        }),
        "utf8",
      );
      logEvent("info", "Field report written", {
        reportPath: target.reportPath,
        eventLogPath: target.eventLogPath,
        origin: target.origin,
        entriesReady: findings.filter((finding) => finding.status === "ready").length,
        entriesTotal: findings.length,
      });
    } catch (error) {
      logEvent("warn", "Field report could not be written", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    start(): void {
      target = resolveFieldReportTarget({
        env: options.env,
        hostname: options.hostname,
        desktopDir: defaultDesktopDir(options.homeDir),
        userDataDir: options.userDataDir,
        now: new Date(),
      });
      if (target) {
        startFieldEventLog(target.eventLogPath);
      }
    },

    info(): FieldReportInfo | null {
      return target ? { directory: target.directory, reportPath: target.reportPath } : null;
    },

    captureFileFor(itemId: string): string | undefined {
      if (!target) {
        return undefined;
      }
      const safeId = itemId.replace(/[^A-Za-z0-9._-]+/g, "-");
      return path.join(target.directory, `launch-${safeId}.log`);
    },

    recordLaunch(entry: SessionLaunch): void {
      launches.push(entry);
    },

    watchLaunch(itemId: string, pid: number | undefined, captureTo: string | undefined): void {
      if (pid === undefined) {
        return;
      }
      const watching = observeLaunch(pid, captureTo)
        .then((observed) => {
          const entry = [...launches].reverse().find((launch) => launch.id === itemId && launch.ok);
          if (!entry) {
            return;
          }
          entry.outcome = observed.outcome;
          entry.observedForMs = observed.observedForMs;
          if (observed.output) {
            entry.output = observed.output;
          }
          logEvent(observed.outcome === "exited-early" ? "warn" : "info", "Launch outcome observed", {
            id: itemId,
            outcome: observed.outcome,
            observedForMs: observed.observedForMs,
          });
        })
        .catch(() => undefined);
      pendingWatches.add(watching);
      void watching.finally(() => pendingWatches.delete(watching));
    },

    writeStartup(configPath: string | undefined, gitConfig: DynamicConfigResult | undefined): void {
      startupReport = writeReport(configPath, gitConfig).catch(() => undefined);
    },

    async writeStartupFailure(configPath: string | undefined, failure: string): Promise<void> {
      if (!target) {
        return;
      }
      try {
        await writeFile(
          target.reportPath,
          renderFieldReport({
            ...reportEnvelope(configPath, undefined),
            configRepoError: failure,
            findings: [],
            target,
          }),
          "utf8",
        );
      } catch {
        // The configuration error window remains the primary failure surface.
      }
    },

    async rewriteOnExit(): Promise<void> {
      if (!target || launches.length === 0 || !lastContext) {
        return;
      }
      await Promise.race([
        startupReport ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
      await settlePendingWatches();
      try {
        await writeFile(
          target.reportPath,
          renderFieldReport({
            ...reportEnvelope(lastContext.configPath, lastContext.gitConfig),
            findings: lastContext.findings,
            launches,
            survey: lastContext.survey,
            target,
          }),
          "utf8",
        );
      } catch {
        // Keep shutdown independent from diagnostic enrichment.
      }
    },
  };
}
