// Convert a completed L4 GUI intake sheet (CSV) to launcher YAML entries.
//
//   npm run intake-to-yaml -- intake/L4_GUI_INTAKE.csv
//   npm run intake-to-yaml -- intake/L4_GUI_INTAKE.csv -o converted.yaml
//
// Only rows marked Enabled=yes are converted. Invalid rows abort with
// row-numbered errors and exit code 1 — the converter never guesses values.
// Validate the result with:  npm run validate-config -- converted.yaml

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { convertIntakeCsv } from "../src/shared/intake";

const args = process.argv.slice(2);
const outFlagIndex = args.findIndex((arg) => arg === "-o" || arg === "--out");
const outputPath = outFlagIndex >= 0 ? args[outFlagIndex + 1] : undefined;
const inputs = args.filter((_, index) => outFlagIndex < 0 || (index !== outFlagIndex && index !== outFlagIndex + 1));
const inputPath = inputs[0];

if (!inputPath || (outFlagIndex >= 0 && !outputPath)) {
  process.stderr.write("Usage: npm run intake-to-yaml -- <intake.csv> [-o output.yaml]\n");
  process.exit(1);
}

let csvText: string;
try {
  csvText = readFileSync(path.resolve(inputPath), "utf8");
} catch (error) {
  process.stderr.write(`Cannot read ${inputPath}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const result = convertIntakeCsv(csvText);

for (const skip of result.skipped) {
  process.stderr.write(`SKIPPED row ${skip.row}: ${skip.reason}\n`);
}

if (result.errors.length > 0) {
  for (const error of result.errors) {
    process.stderr.write(`ERROR row ${error.row}: ${error.message}\n`);
  }
  process.stderr.write(`No YAML written: fix the ${result.errors.length} error(s) above in the sheet and re-run.\n`);
  process.exit(1);
}

if (result.includedIds.length === 0) {
  process.stderr.write("No rows marked Enabled=yes were found; nothing to convert.\n");
  process.exit(1);
}

if (outputPath) {
  writeFileSync(path.resolve(outputPath), result.yaml, "utf8");
  process.stderr.write(`Wrote ${result.includedIds.length} entries to ${outputPath}\n`);
} else {
  process.stdout.write(result.yaml);
  process.stderr.write(`Converted ${result.includedIds.length} entries.\n`);
}
