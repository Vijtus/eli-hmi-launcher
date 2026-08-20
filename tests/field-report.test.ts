import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  FIELD_REPORT_DIR_ENV,
  FIELD_REPORT_ENABLE_ENV,
  PORTABLE_DIR_ENV,
  renderFieldReport,
  resolveFieldReportTarget,
  type FieldReportEnvironment,
} from "../src/main/field-report.ts";
import type { PreflightFinding } from "../src/main/preflight.ts";

function environment(env: Record<string, string | undefined> = {}): FieldReportEnvironment {
  return {
    env,
    hostname: "TESTZ-Deploy",
    desktopDir: "/home/op/Desktop",
    userDataDir: "/home/op/.config/eli-hmi-launcher",
    now: new Date("2026-08-19T15:04:05.678Z"),
  };
}

const allWritable = () => true;

// An installed build must not start dropping files on someone's desktop.
test("recording is off unless a portable run or an explicit opt-in asks for it", () => {
  assert.equal(resolveFieldReportTarget(environment(), allWritable), undefined);
});

test("a portable run records beside the executable", () => {
  const target = resolveFieldReportTarget(
    environment({ [PORTABLE_DIR_ENV]: "/media/usb/ELI" }),
    allWritable,
  );
  assert.equal(target?.origin, "portable");
  assert.equal(target?.directory, "/media/usb/ELI");
  assert.equal(
    path.basename(target?.reportPath ?? ""),
    "ELI-Launcher-testz-deploy-2026-08-19_15-04-05-report.md",
  );
  assert.equal(
    path.basename(target?.eventLogPath ?? ""),
    "ELI-Launcher-testz-deploy-2026-08-19_15-04-05-events.jsonl",
  );
});

test("an explicit directory beats the portable location", () => {
  const target = resolveFieldReportTarget(
    environment({ [PORTABLE_DIR_ENV]: "/media/usb/ELI", [FIELD_REPORT_DIR_ENV]: "/srv/reports" }),
    allWritable,
  );
  assert.equal(target?.origin, "explicit");
  assert.equal(target?.directory, "/srv/reports");
});

// A stick can be read-only, and losing the report silently is the one outcome
// that makes the whole feature pointless.
test("a read-only stick falls back to the Desktop", () => {
  const target = resolveFieldReportTarget(
    environment({ [PORTABLE_DIR_ENV]: "/media/usb/ELI" }),
    (directory) => directory !== "/media/usb/ELI",
  );
  assert.equal(target?.origin, "desktop");
  assert.equal(target?.directory, "/home/op/Desktop");
});

test("an unwritable Desktop falls back to userData", () => {
  const target = resolveFieldReportTarget(
    environment({ [FIELD_REPORT_ENABLE_ENV]: "1" }),
    (directory) => directory === "/home/op/.config/eli-hmi-launcher",
  );
  assert.equal(target?.origin, "userData");
});

test("nowhere writable yields no target rather than throwing", () => {
  assert.equal(
    resolveFieldReportTarget(environment({ [PORTABLE_DIR_ENV]: "/media/usb" }), () => false),
    undefined,
  );
});

test("a hostile hostname cannot escape the report directory", () => {
  const target = resolveFieldReportTarget(
    { ...environment({ [PORTABLE_DIR_ENV]: "/media/usb" }), hostname: "../../etc/pwn" },
    allWritable,
  );
  const name = path.basename(target?.reportPath ?? "");
  // The property that matters: the file lands where it was meant to. Compared
  // through path.join so the expectation is separator-correct on the host
  // running the test rather than assuming POSIX.
  assert.equal(target?.reportPath, path.join("/media/usb", name));
  assert.ok(!name.includes("/") && !name.includes("\\"), `separator survived: ${name}`);
  assert.ok(!name.includes(".."), `dot run survived: ${name}`);
  assert.equal(name, "ELI-Launcher-etc-pwn-2026-08-19_15-04-05-report.md");
});

test("an FQDN keeps its dots so the machine stays identifiable", () => {
  const target = resolveFieldReportTarget(
    { ...environment({ [PORTABLE_DIR_ENV]: "/media/usb" }), hostname: "TESTZ-Deploy.eli.cz" },
    allWritable,
  );
  assert.match(path.basename(target?.reportPath ?? ""), /^ELI-Launcher-testz-deploy\.eli\.cz-/);
});

// --- report content --------------------------------------------------------

function finding(overrides: Partial<PreflightFinding>): PreflightFinding {
  return { id: "e", name: "Entry", kind: "process", status: "ready", ...overrides };
}

function report(findings: PreflightFinding[], extra: Record<string, unknown> = {}): string {
  return renderFieldReport({
    appName: "L4 Launcher",
    appVersion: "0.4.0",
    hostname: "TESTZ-Deploy",
    platform: "win32",
    arch: "x64",
    electronVersion: "40.10.0",
    configPath: "C:\\config\\launcher.yaml",
    findings,
    target: {
      directory: "E:\\",
      reportPath: "E:\\report.md",
      eventLogPath: "E:\\events.jsonl",
      origin: "portable",
    },
    startedAt: new Date("2026-08-19T15:04:05.678Z"),
    ...extra,
  });
}

test("the headline counts what would actually launch", () => {
  const text = report([
    finding({ id: "a", status: "ready" }),
    finding({ id: "b", status: "missing" }),
    finding({ id: "c", status: "denied" }),
  ]);
  assert.match(text, /\*\*1 of 3 entries would launch on this machine\.\*\*/);
});

test("each failure kind is reported with its resolved command and reason", () => {
  const text = report([
    finding({
      id: "cam",
      name: "Camera Manager",
      kind: "labview-dev",
      status: "missing",
      resolvedCommand: "D:\\ws\\Camera Manager\\CMD.exe",
      detail: "does not exist on this machine",
    }),
    finding({ id: "bad", name: "Bad", status: "unresolved", detail: "local.zoneSymbol is required" }),
  ]);
  assert.match(text, /NOT ON THIS MACHINE \(1\)/);
  assert.match(text, /CONFIG INCOMPLETE \(1\)/);
  assert.match(text, /D:\\ws\\Camera Manager\\CMD\.exe/);
  assert.match(text, /local\.zoneSymbol is required/);
});

test("a clean machine says so instead of leaving an empty section", () => {
  const text = report([finding({ status: "ready" })]);
  assert.match(text, /Nothing — every catalog entry resolved to a runnable command/);
});

test("a config-repo failure is reported even with no entries to check", () => {
  const text = report([], { configRepoError: "HTTP Error: 401 Unauthorized" });
  assert.match(text, /The config repo could not be used/);
  assert.match(text, /401 Unauthorized/);
  assert.match(text, /\*\*0 of 0 entries would launch on this machine\.\*\*/);
});

// Observed on a real machine: a run whose catalog failed to load reported
// "every catalog entry resolved to a runnable command", which is the opposite
// of the truth and sends the reader looking in the wrong place.
test("a run with no entries does not claim everything worked", () => {
  const text = report([], { configRepoError: "no host file for this machine" });
  assert.doesNotMatch(text, /every catalog entry resolved/);
  assert.match(text, /The catalog never loaded, so no entry could be checked/);
  assert.match(text, /Nothing was checked/);
});

test("a stale catalog is called out", () => {
  const text = report([finding({})], {
    catalogStatus: { stale: true, sources: [], warnings: ["zone file could not be refreshed"] },
  });
  assert.match(text, /CATALOG STALE/);
  assert.match(text, /zone file could not be refreshed/);
});
