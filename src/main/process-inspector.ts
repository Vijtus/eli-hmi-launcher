import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessObservation = {
  alive: boolean;
  identity?: string;
  reason?: string;
};

export type ProcessInspector = (pid: number) => Promise<ProcessObservation>;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function linuxStartTicks(statText: string): string | undefined {
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) {
    return undefined;
  }
  // /proc/<pid>/stat fields after the command begin at field 3. Start time is
  // field 22, therefore index 19 in this tail array.
  const tail = statText.slice(closeParen + 1).trim().split(/\s+/);
  return tail[19];
}

async function inspectLinux(pid: number): Promise<ProcessObservation> {
  if (!processExists(pid)) {
    return { alive: false, reason: "process does not exist" };
  }
  try {
    const [statText, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const startTicks = linuxStartTicks(statText);
    if (!startTicks) {
      return { alive: true, reason: "process start time could not be read" };
    }
    return { alive: true, identity: `linux:${bootId.trim()}:${startTicks}` };
  } catch (error) {
    if (!processExists(pid)) {
      return { alive: false, reason: "process exited while being inspected" };
    }
    return {
      alive: true,
      reason: `process exists but start identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function inspectWindows(pid: number): Promise<ProcessObservation> {
  const command =
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`;
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 2_000 },
    );
    const ticks = result.stdout.trim();
    if (!ticks) {
      return { alive: true, reason: "Windows process start time was empty" };
    }
    return { alive: true, identity: `windows:${ticks}` };
  } catch (error) {
    if (!processExists(pid)) {
      return { alive: false, reason: "process does not exist" };
    }
    return {
      alive: true,
      reason: `process exists but Windows start identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// `ps -o lstart=` resolves a process start time only to whole seconds, so on
// non-Linux POSIX two processes that reuse a PID within the same second produce
// the same start string. `comm` is added as a second discriminator so a PID
// reused by a different executable — the common case — is still detected. A PID
// reused within the same second by the *same* executable remains
// indistinguishable on this path; Linux avoids it with /proc start ticks and the
// boot id, and Windows with .NET start ticks. Identity is opaque to callers and
// is only ever compared for equality, so combining the fields is safe.
async function inspectPs(pid: number): Promise<ProcessObservation> {
  if (!processExists(pid)) {
    return { alive: false, reason: "process does not exist" };
  }
  try {
    const result = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-o", "comm=", "-p", String(pid)],
      { timeout: 2_000 },
    );
    const started = result.stdout.trim().replace(/\s+/g, " ");
    if (!started) {
      return { alive: false, reason: "process not returned by ps" };
    }
    return { alive: true, identity: `posix:${started}` };
  } catch (error) {
    if (!processExists(pid)) {
      return { alive: false, reason: "process exited while being inspected" };
    }
    return {
      alive: true,
      reason: `process exists but POSIX start identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function inspectProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessObservation> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { alive: false, reason: `invalid process id ${pid}` };
  }
  if (platform === "linux") {
    return await inspectLinux(pid);
  }
  if (platform === "win32") {
    return await inspectWindows(pid);
  }
  return await inspectPs(pid);
}
