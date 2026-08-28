import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

export const DEFAULT_STARTUP_GRACE_MS = 500;

export type SpawnReceipt = {
  pid: number;
  spawnedAt: number;
  // Optional OS start identity captured after spawn. It lets a later liveness
  // check tell the originally launched process apart from a recycled PID.
  startIdentity?: string;
};

// A launched GUI normally has its output discarded: the launcher must not hold
// pipes open against a detached process it does not own. A diagnostic run needs
// the opposite, so output is redirected to a FILE descriptor rather than a pipe
// — the child writes to it directly and the parent keeps nothing open, which is
// what makes this safe to combine with `detached`.
export function detachedSpawnOptions(
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  outputFd?: number,
): SpawnOptions {
  return {
    detached: true,
    stdio: outputFd === undefined ? "ignore" : ["ignore", outputFd, outputFd],
    shell: false,
    cwd: cwd || undefined,
    env: { ...process.env, ...(env ?? {}) },
    windowsHide: true,
  };
}

// Returns a descriptor for `captureTo`, or undefined when capture is off or the
// file cannot be opened. Never throws: losing the diagnostic copy of a
// program's output must not stop the program being launched.
function openCaptureFile(captureTo: string | undefined): number | undefined {
  if (!captureTo) {
    return undefined;
  }
  try {
    mkdirSync(path.dirname(captureTo), { recursive: true });
    return openSync(captureTo, "a");
  } catch {
    return undefined;
  }
}

// Windows cannot execute .bat/.cmd through CreateProcess directly. Do not use
// `shell: true`: validate the script itself, then invoke cmd.exe explicitly.
// cmd /c strips an outer quote pair, so quote each token and wrap the complete
// command line once more; this also preserves paths containing spaces.

export function isWindowsBatchFile(command: string): boolean {
  return /\.(bat|cmd)$/i.test(command.trim());
}

// Quotes a single token for cmd.exe. Embedded quotes are doubled, which is how
// cmd expects them escaped inside a quoted string.
function quoteForCmd(token: string): string {
  // A run of backslashes immediately before the closing quote has to be doubled.
  // `C:\CSS GUIs\` would otherwise close as `"C:\CSS GUIs\"`, and the CRT argv
  // parser in the launched program reads that `\"` as an escaped quote and
  // swallows the argument after it.
  const escaped = token.replace(/"/g, '""').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export type CmdInvocation = { command: string; args: string[]; verbatim: boolean };

export function windowsBatchInvocation(command: string, args: string[]): CmdInvocation {
  const line = [command, ...args].map(quoteForCmd).join(" ");
  return {
    command: process.env["ComSpec"] || "cmd.exe",
    // The extra surrounding quotes are consumed by cmd's own stripping rule.
    args: ["/c", `"${line}"`],
    verbatim: true,
  };
}

export function spawnDetached(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
  captureTo?: string,
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
      releaseFd();
      callback();
    };

    const outputFd = openCaptureFile(captureTo);
    // The allow-list has already been checked against `command` itself, so
    // routing through cmd.exe here cannot widen what may be launched.
    const invocation =
      process.platform === "win32" && isWindowsBatchFile(command)
        ? windowsBatchInvocation(command, args)
        : { command, args, verbatim: false };
    const child = spawn(invocation.command, invocation.args, {
      ...detachedSpawnOptions(cwd, env, outputFd),
      ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    // The child holds its own duplicate of the descriptor once spawned, so the
    // parent's copy is released immediately rather than kept for the process
    // lifetime.
    const releaseFd = (): void => {
      if (outputFd !== undefined) {
        try {
          closeSync(outputFd);
        } catch {
          // Already closed, or never valid; nothing to recover.
        }
      }
    };

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
