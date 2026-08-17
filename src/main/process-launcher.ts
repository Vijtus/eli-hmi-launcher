import { spawn, type SpawnOptions } from "node:child_process";

export const DEFAULT_STARTUP_GRACE_MS = 500;

export type SpawnReceipt = {
  pid: number;
  spawnedAt: number;
  // Optional OS start identity captured after spawn. It lets a later liveness
  // check tell the originally launched process apart from a recycled PID.
  startIdentity?: string;
};

export function detachedSpawnOptions(
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): SpawnOptions {
  return {
    detached: true,
    stdio: "ignore",
    shell: false,
    cwd: cwd || undefined,
    env: { ...process.env, ...(env ?? {}) },
    windowsHide: true,
  };
}

export function spawnDetached(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
): Promise<SpawnReceipt> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let startupTimer: NodeJS.Timeout | undefined;
    let receipt: SpawnReceipt | undefined;

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

    const child = spawn(command, args, detachedSpawnOptions(cwd, env));

    child.once("spawn", () => {
      if (child.pid === undefined) {
        settle(() => reject(new Error(`Spawned command '${command}' did not report a process id.`)));
        return;
      }
      receipt = { pid: child.pid, spawnedAt: Date.now() };
      startupTimer = setTimeout(() => {
        settle(() => {
          child.unref();
          resolve(receipt as SpawnReceipt);
        });
      }, startupGraceMs);
    });

    child.once("error", (error) => {
      settle(() => reject(error));
    });

    child.once("exit", (code, signal) => {
      settle(() => {
        if (code === 0 && receipt) {
          resolve(receipt);
          return;
        }
        const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        reject(new Error(`Process exited during startup with ${detail}.`));
      });
    });
  });
}
