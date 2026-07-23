function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  const detail = String(error).trim();
  return detail || "Unknown error.";
}

export function launchErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function processLaunchError(command: string, error: unknown): Error {
  const code = launchErrorCode(error);

  if (code === "ENOENT") {
    return new Error(
      `Command could not be started because it or a required interpreter was not found: '${command}'. ` +
        "Verify the configured path or ensure the command is available on the system PATH.",
    );
  }

  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `Command could not be started because it is inaccessible or not executable: '${command}'. ` +
        "Check the command and working-directory permissions.",
    );
  }

  return new Error(`Failed to start command '${command}': ${errorDetail(error)}`);
}

export function webLaunchError(url: string, error: unknown): Error {
  return new Error(`Failed to open web target '${url}': ${errorDetail(error)}`);
}

export function folderLaunchError(folderPath: string, error: unknown): Error {
  return new Error(`Failed to open folder target '${folderPath}': ${errorDetail(error)}`);
}
