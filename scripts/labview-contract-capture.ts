import path from "node:path";
import { readFile } from "node:fs/promises";

export type LabviewContractCapture = {
  pid: number;
  executable: string;
  args: string[];
  argvPath: string;
  pidPath: string;
  startIdentity: string;
  startIdentityPath: string;
};

export function decodeLabviewContractArgv(
  data: Uint8Array,
): { executable: string; args: string[] } {
  const bytes = Buffer.from(data);
  if (bytes.length === 0 || bytes.at(-1) !== 0) {
    throw new Error("LabVIEW contract argv capture must end with a NUL byte.");
  }

  const fields = bytes.subarray(0, -1).toString("utf8").split("\0");
  const executable = fields.shift();
  if (!executable) {
    throw new Error("LabVIEW contract argv capture has no executable path.");
  }
  return { executable, args: fields };
}

export async function readLabviewContractCapture(
  captureDirectory: string,
  pid: number,
): Promise<LabviewContractCapture> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid LabVIEW contract capture PID: ${pid}`);
  }

  const captureStem = path.join(captureDirectory, `launch-${pid}`);
  const argvPath = `${captureStem}.argv.nul`;
  const pidPath = `${captureStem}.pid`;
  const startIdentityPath = `${captureStem}.start-identity`;
  const [pidText, argvData, startIdentityText] = await Promise.all([
    readFile(pidPath, "utf8"),
    readFile(argvPath),
    readFile(startIdentityPath, "utf8"),
  ]);
  const capturedPidText = pidText.trim();
  if (!/^\d+$/.test(capturedPidText) || Number(capturedPidText) !== pid) {
    throw new Error(
      `LabVIEW contract PID receipt '${pidPath}' does not match expected PID ${pid}.`,
    );
  }

  const startIdentity = startIdentityText.trim();
  if (!/^\d+$/.test(startIdentity)) {
    throw new Error(`LabVIEW contract start identity '${startIdentityPath}' is invalid.`);
  }

  const decoded = decodeLabviewContractArgv(argvData);
  return { pid, ...decoded, argvPath, pidPath, startIdentity, startIdentityPath };
}

export async function waitForLabviewContractCapture(
  captureDirectory: string,
  pid: number,
  timeoutMs = 3_000,
): Promise<LabviewContractCapture> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("LabVIEW contract capture timeout must be a positive integer.");
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readLabviewContractCapture(captureDirectory, pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for LabVIEW contract capture PID ${pid}.`,
          { cause: error },
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}
