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
} from "../src/main/diagnostics/report.ts";
import type { PreflightFinding } from "../src/main/diagnostics/preflight.ts";

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
  assert.equal(target?.directory, path.join("/media/usb/ELI", path.basename(target?.directory ?? "")));
  // Everything for one run lands in one folder named after the machine and time.
  assert.equal(
    target?.directory,
    path.join("/media/usb/ELI", "ELI-Launcher-testz-deploy-2026-08-19_15-04-05"),
  );
  assert.equal(path.basename(target?.reportPath ?? ""), "report.md");
  assert.equal(path.basename(target?.eventLogPath ?? ""), "events.jsonl");
});

test("an explicit directory beats the portable location", () => {
  const target = resolveFieldReportTarget(
    environment({ [PORTABLE_DIR_ENV]: "/media/usb/ELI", [FIELD_REPORT_DIR_ENV]: "/srv/reports" }),
    allWritable,
  );
  assert.equal(target?.origin, "explicit");
  assert.equal(target?.directory, path.join("/srv/reports", path.basename(target?.directory ?? "")));
});

// A stick can be read-only, and losing the report silently is the one outcome
// that makes the whole feature pointless.
test("a read-only stick falls back to the Desktop", () => {
  const target = resolveFieldReportTarget(
    environment({ [PORTABLE_DIR_ENV]: "/media/usb/ELI" }),
    (directory) => !path.resolve(directory).startsWith(path.resolve("/media/usb/ELI")),
  );
  assert.equal(target?.origin, "desktop");
  assert.equal(target?.directory, path.join("/home/op/Desktop", path.basename(target?.directory ?? "")));
});

test("an unwritable Desktop falls back to userData", () => {
  // path.join normalises separators to the host's, so the predicate has to
  // compare the same way rather than against a POSIX literal.
  const userData = path.join("/home/op/.config/eli-hmi-launcher");
  const target = resolveFieldReportTarget(
    environment({ [FIELD_REPORT_ENABLE_ENV]: "1" }),
    (directory) => path.resolve(directory).startsWith(path.resolve(userData)),
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
  const name = path.basename(target?.directory ?? "");
  // The property that matters: the file lands where it was meant to. Compared
  // through path.join so the expectation is separator-correct on the host
  // running the test rather than assuming POSIX.
  assert.equal(target?.directory, path.join("/media/usb", name));
  assert.ok(!name.includes("/") && !name.includes("\\"), `separator survived: ${name}`);
  assert.ok(!name.includes(".."), `dot run survived: ${name}`);
  assert.equal(name, "ELI-Launcher-etc-pwn-2026-08-19_15-04-05");
});

test("an FQDN keeps its dots so the machine stays identifiable", () => {
  const target = resolveFieldReportTarget(
    { ...environment({ [PORTABLE_DIR_ENV]: "/media/usb" }), hostname: "TESTZ-Deploy.eli.cz" },
    allWritable,
  );
  assert.match(path.basename(target?.directory ?? ""), /^ELI-Launcher-testz-deploy\.eli\.cz-/);
});

// --- report content --------------------------------------------------------

function finding(overrides: Partial<PreflightFinding>): PreflightFinding {
  return { id: "e", name: "Entry", kind: "process", status: "ready", ...overrides };
}

function report(findings: PreflightFinding[], extra: Record<string, unknown> = {}): string {
  return renderFieldReport({
    title: "ELI HMI Launcher",
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

// A failed catalog load must still report
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

// The startup report describes what COULD run; the operator clicks afterwards.
// Those outcomes previously existed only in the JSONL, which nobody reads, so a
// run where six of eight programs started looked identical to one where none did.
test("launch attempts and their outcomes appear in the readable report", () => {
  const text = report([finding({ status: "ready" })], {
    launches: [
      {
        id: "cm-001",
        label: "Camera Manager — RMC00-001",
        ok: true,
        command: "C:\\ws\\Standalone\\CM\\Builds\\CM.exe",
        args: ["RMC00-001", "Camera Manager", "TESTZ"],
        at: "2026-08-20T12:20:00.000Z",
      },
      {
        id: "fp-001",
        label: "Fast Pointing IOC",
        ok: false,
        command: "C:\\ws\\missing.exe",
        error: "Configured command does not exist: C:\\ws\\missing.exe",
        at: "2026-08-20T12:21:00.000Z",
      },
    ],
  });
  assert.match(text, /\*\*1 of 2 launch attempts started a process\.\*\*/);
  assert.match(text, /\*\*STARTED\*\* — Camera Manager — RMC00-001/);
  assert.match(text, /\*\*FAILED TO START\*\* — Fast Pointing IOC/);
  assert.match(text, /Configured command does not exist/);
  assert.match(text, /RMC00-001","Camera Manager","TESTZ/);
});

test("a run where nothing was clicked says so rather than implying success", () => {
  const text = report([finding({ status: "ready" })]);
  assert.match(text, /Nothing was clicked during this run\./);
});

// Resolving a path and starting the right program are different claims; several
// entries here resolved to real but probably-wrong executables.
test("the report does not let a started process imply the right program opened", () => {
  const text = report([finding({})], {
    launches: [{ id: "a", label: "A", ok: true, at: "2026-08-20T12:20:00.000Z" }],
  });
  assert.match(text, /not proof the RIGHT program opened/);
});

// The case the operator actually reported: a LabVIEW GUI that spawns, throws an
// error dialog and dies. It returns a pid, so without watching it reads as a
// success and the report contradicts what the person saw on screen.
test("a process that started then quit is not reported as running", () => {
  const text = report([finding({})], {
    launches: [
      {
        id: "cm",
        label: "Camera Manager",
        ok: true,
        outcome: "exited-early",
        observedForMs: 1000,
        output: "LabVIEW: Error 1055 occurred at Open VI Reference",
        at: "2026-08-20T12:20:00.000Z",
      },
    ],
  });
  assert.match(text, /\*\*STARTED THEN QUIT\*\*/);
  assert.doesNotMatch(text, /\*\*RUNNING\*\*/);
  assert.match(text, /did not stay open/);
  // The program's own words are the actual explanation.
  assert.match(text, /Error 1055 occurred at Open VI Reference/);
});

test("a process still alive at the end of the watch is reported as running", () => {
  const text = report([finding({})], {
    launches: [
      {
        id: "cm",
        label: "Camera Manager",
        ok: true,
        outcome: "still-running",
        observedForMs: 10_000,
        at: "2026-08-20T12:20:00.000Z",
      },
    ],
  });
  assert.match(text, /\*\*RUNNING\*\*/);
  assert.match(text, /still running 10s later/);
});

// The report listed every panel on the machine and, separately, said a panel was
// missing — leaving the reader to join the two by eye across a listing of
// hundreds. Observed with pm.bob: Phoebus said it could not find
// C:\Workspaces\css-gui\pm.bob while the survey had the real path all along.
test("a missing file is matched against what the survey actually found", () => {
  const text = report(
    [
      finding({
        id: "pm",
        name: "Power Meters",
        kind: "phoebus",
        status: "missing",
        resolvedCommand: "C:\\Workspaces\\css-gui\\pm.bob",
        detail: "Phoebus starts, but the panel does not exist",
      }),
    ],
    {
      survey: [
        {
          root: "C:\\Workspaces\\css-gui",
          exists: true,
          topLevel: ["panel"],
          executables: [],
          panels: ["panel\\pm.bob", "panel\\centroids.bob"],
          truncated: false,
          scanned: 42,
        },
      ],
    },
  );
  assert.match(text, /found a file with that name here/);
  assert.match(text, /panel\\pm\.bob/);
  // The unrelated panel must not be offered as a match.
  assert.doesNotMatch(text, /found a file with that name here:.*centroids/);
});

test("no suggestion is invented when nothing matches", () => {
  const text = report(
    [finding({ id: "x", status: "missing", resolvedCommand: "C:\\nowhere\\ghost.bob" })],
    {
      survey: [
        {
          root: "C:\\Workspaces\\css-gui",
          exists: true,
          topLevel: [],
          executables: [],
          panels: ["panel\\pm.bob"],
          truncated: false,
          scanned: 1,
        },
      ],
    },
  );
  assert.doesNotMatch(text, /found a file with that name here/);
});

test("a ready entry is never given a suggestion", () => {
  const text = report(
    [finding({ id: "ok", status: "ready", resolvedCommand: "C:\\Workspaces\\css-gui\\pm.bob" })],
    {
      survey: [
        {
          root: "C:\\Workspaces\\css-gui",
          exists: true,
          topLevel: [],
          executables: [],
          panels: ["panel\\pm.bob"],
          truncated: false,
          scanned: 1,
        },
      ],
    },
  );
  assert.doesNotMatch(text, /found a file with that name here/);
});
