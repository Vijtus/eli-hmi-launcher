import os from "node:os";
import path from "node:path";
import { runLabviewContractSmoke } from "./labview-contract-smoke";

async function main(): Promise<void> {
  const evidencePath =
    process.argv[2] ??
    process.env["ELI_LABVIEW_CONTRACT_EVIDENCE"] ??
    path.join(os.tmpdir(), "eli-hmi-launcher", "labview-contract-smoke.json");
  const evidence = await runLabviewContractSmoke({ evidencePath });
  process.stdout.write(
    `${JSON.stringify({ result: evidence.result, evidencePath: path.resolve(evidencePath) })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
