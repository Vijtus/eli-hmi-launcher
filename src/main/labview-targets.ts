import path from "node:path";
import {
  expandConfiguredString,
  type ConfigItemScope,
  type LaunchContext,
  type MaterializedProcess,
} from "./config";
import type {
  LabviewDeveloperLaunchTarget,
  LabviewEpicsLaunchTarget,
} from "../shared/types";

function requiredLocalValue(
  key: "local.workspaceRoot" | "local.zoneSymbol",
  context: LaunchContext,
  scope?: ConfigItemScope,
): string {
  return expandConfiguredString(
    `\${${key}}`,
    context,
    scope ? { ...scope, field: key } : undefined,
  );
}

function expandTargetField(
  value: string,
  field: string,
  context: LaunchContext,
  scope?: ConfigItemScope,
): string {
  return expandConfiguredString(
    value,
    context,
    scope ? { ...scope, field: `target.${field}` } : undefined,
  );
}

export function joinWorkspacePath(
  workspaceRoot: string,
  segments: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return path.win32.join(workspaceRoot, ...segments);
  }

  // POSIX development hosts use POSIX path semantics. Backslashes in a supplied
  // root are normalised only as separators; drive-letter roots are not mapped to
  // a mount point and therefore fail the ordinary existence check at launch.
  return path.posix.join(workspaceRoot.replace(/\\/g, "/"), ...segments);
}

export function materializeLabviewDeveloperTarget(
  target: LabviewDeveloperLaunchTarget,
  context: LaunchContext,
  scope?: ConfigItemScope,
  platform: NodeJS.Platform = process.platform,
): MaterializedProcess {
  const workspaceRoot = requiredLocalValue("local.workspaceRoot", context, scope);
  const zoneSymbol = requiredLocalValue("local.zoneSymbol", context, scope);
  const iocType = expandTargetField(target.iocType, "iocType", context, scope);
  const exeName = expandTargetField(target.exeName, "exeName", context, scope);
  const hostName = expandTargetField(target.hostName, "hostName", context, scope);
  const iocName = expandTargetField(target.iocName, "iocName", context, scope);

  return {
    command: joinWorkspacePath(
      workspaceRoot,
      ["Common", "ELI", "IOCs", iocType, "Builds", "GUI Application", exeName],
      platform,
    ),
    args: [hostName, iocName, zoneSymbol],
  };
}

export function materializeLabviewEpicsTarget(
  target: LabviewEpicsLaunchTarget,
  context: LaunchContext,
  scope?: ConfigItemScope,
  platform: NodeJS.Platform = process.platform,
): MaterializedProcess {
  const workspaceRoot = requiredLocalValue("local.workspaceRoot", context, scope);
  const zoneSymbol = requiredLocalValue("local.zoneSymbol", context, scope);
  const guiType = expandTargetField(target.guiType, "guiType", context, scope);
  const exeName = expandTargetField(target.exeName, "exeName", context, scope);
  const guiName = expandTargetField(target.guiName, "guiName", context, scope);

  return {
    command: joinWorkspacePath(
      workspaceRoot,
      ["Common", "ELI", "EPICS_GUIs", guiType, "Builds", "GUI Application", exeName],
      platform,
    ),
    // CSI-847 intentionally has a different order and count from CSI-843.
    args: [zoneSymbol, guiName],
  };
}
