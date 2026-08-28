import {
  assertCommandAllowed,
  type LaunchContext,
  type MaterializedProcess,
} from "../config/load";
import {
  assertCommandPathUsable,
  assertResolvedValueNotEmpty,
  assertWorkingDirectoryUsable,
} from "./validation";
import { attachLaunchDiagnostics, launchErrorCode, processLaunchError } from "./errors";
import { spawnDetached, type SpawnReceipt } from "./process";

export type NativeLaunchResult = {
  command: string;
  args: string[];
  receipt: SpawnReceipt;
  captureTo?: string | undefined;
};

export async function launchMaterializedProcess(
  materialized: MaterializedProcess,
  context: LaunchContext,
  captureTo?: string,
): Promise<NativeLaunchResult> {
  const args = materialized.args ?? [];
  try {
    assertResolvedValueNotEmpty(materialized.command, "process command");
    if (materialized.cwd !== undefined) {
      assertResolvedValueNotEmpty(materialized.cwd, "working directory");
    }

    assertCommandAllowed(materialized.command, context.security);

    const hasSeparator = materialized.command.includes("/") || materialized.command.includes("\\");
    if (hasSeparator) {
      await assertCommandPathUsable(materialized.command);
    }
    if (materialized.cwd) {
      await assertWorkingDirectoryUsable(materialized.cwd);
    }

    try {
      const receipt = await spawnDetached(
        materialized.command,
        args,
        materialized.cwd,
        materialized.env,
        undefined,
        captureTo,
      );
      return { command: materialized.command, args, receipt, captureTo };
    } catch (error) {
      const code = launchErrorCode(error);
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
        if (materialized.cwd) {
          await assertWorkingDirectoryUsable(materialized.cwd);
        }
        if (hasSeparator) {
          await assertCommandPathUsable(materialized.command);
        }
      }
      throw processLaunchError(materialized.command, error);
    }
  } catch (error) {
    throw attachLaunchDiagnostics(error, { command: materialized.command, args });
  }
}
