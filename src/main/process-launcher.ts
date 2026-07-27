import { spawn } from "node:child_process";

const DEFAULT_STARTUP_GRACE_MS = 500;

export function spawnDetached(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let startupTimer: NodeJS.Timeout | undefined;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
      }
      callback();
    };

    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      cwd: cwd || undefined,
      env: { ...process.env, ...(env ?? {}) },
      windowsHide: true,
    });

    child.once("spawn", () => {
      startupTimer = setTimeout(() => {
        settle(() => {
          child.unref();
          resolve();
        });
      }, startupGraceMs);
    });

    child.once("error", (error) => {
      settle(() => reject(error));
    });

    child.once("exit", (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        reject(new Error(`Process exited during startup with ${detail}.`));
      });
    });
  });
}
