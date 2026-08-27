import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function filesystemError(message: string, targetPath: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${message}: ${targetPath}${detail ? ` (${detail})` : ""}`);
}

async function readStats(
  targetPath: string,
  missingMessage: string,
  inaccessibleMessage: string,
  inspectionMessage: string,
) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(missingMessage);
    }
    if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") {
      throw new Error(inaccessibleMessage);
    }
    throw filesystemError(inspectionMessage, targetPath, error);
  }
}

async function assertPathAccess(
  targetPath: string,
  mode: number,
  missingMessage: string,
  deniedMessage: string,
  inspectionMessage: string,
): Promise<void> {
  try {
    await access(targetPath, mode);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(missingMessage);
    }
    if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") {
      throw new Error(deniedMessage);
    }
    throw filesystemError(inspectionMessage, targetPath, error);
  }
}

export function assertResolvedValueNotEmpty(value: string, description: string): void {
  if (!value.trim()) {
    throw new Error(
      `Configured ${description} resolves to an empty value. Check its environment-variable substitutions.`,
    );
  }
}

export async function assertCommandPathUsable(commandPath: string): Promise<void> {
  const info = await readStats(
    commandPath,
    `Configured command does not exist: ${commandPath}`,
    `Configured command is not accessible: ${commandPath}`,
    "Unable to inspect configured command",
  );

  if (!info.isFile()) {
    throw new Error(`Configured command is not a file: ${commandPath}`);
  }

  if (process.platform !== "win32") {
    await assertPathAccess(
      commandPath,
      constants.X_OK,
      `Configured command does not exist: ${commandPath}`,
      `Configured command is not executable: ${commandPath}`,
      "Unable to inspect configured command permissions",
    );
  }
}

export async function assertWorkingDirectoryUsable(cwd: string): Promise<void> {
  const info = await readStats(
    cwd,
    `Configured working directory does not exist: ${cwd}`,
    `Configured working directory is not accessible: ${cwd}`,
    "Unable to inspect configured working directory",
  );

  if (!info.isDirectory()) {
    throw new Error(`Configured working directory is not a directory: ${cwd}`);
  }

  if (process.platform !== "win32") {
    await assertPathAccess(
      cwd,
      constants.X_OK,
      `Configured working directory does not exist: ${cwd}`,
      `Configured working directory is not accessible: ${cwd}`,
      "Unable to inspect configured working-directory permissions",
    );
  }
}

export async function assertFolderPathUsable(folderPath: string): Promise<void> {
  const info = await readStats(
    folderPath,
    `Configured folder target does not exist: ${folderPath}`,
    `Configured folder target is not accessible: ${folderPath}`,
    "Unable to inspect configured folder target",
  );

  if (!info.isDirectory()) {
    throw new Error(`Configured folder target is not a directory: ${folderPath}`);
  }

  await assertPathAccess(
    folderPath,
    constants.R_OK,
    `Configured folder target does not exist: ${folderPath}`,
    `Configured folder target is not readable: ${folderPath}`,
    "Unable to inspect configured folder permissions",
  );

  if (process.platform !== "win32") {
    await assertPathAccess(
      folderPath,
      constants.X_OK,
      `Configured folder target does not exist: ${folderPath}`,
      `Configured folder target is not accessible: ${folderPath}`,
      "Unable to inspect configured folder permissions",
    );
  }
}
