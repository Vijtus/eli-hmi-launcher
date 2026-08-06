# Changelog

## Unreleased — realistic local Phoebus panels (2026-08-06)

- Replaced the three minimal one-value BOB fixtures with operator-style
  laser/regenerator, cooling, and flashlamp/timing panels. The displays use a
  configurable `CP` macro, navigate between one another, and expose 84 of the
  supplied IOC's 89 records. Status widgets remain display-only; writable
  widgets are restricted to the IOC's explicit command records.
- Added primary/legacy chiller views with engineering units, level and flow
  visualization, error indicators, and the database's deliberate
  `AI_NL2_CHILLER_13_LEVEL` LOW/MINOR alarm. The timing panel includes unit-22
  and unit-28 state/delay commands plus the seven-by-two legacy flashlamp
  matrix. Every display is visibly marked as a local mock, not an operations
  screen.
- Added `prepare-mock-ioc.sh`. Live testing found that seeded input records
  remain UDF and the supplied global flashlamp fanout drops the requested enum
  value. The script processes seeded values, repairs three link fields in IOC
  memory, initializes safe command values, logs every `caput`, and proves the
  expected alarm and both ends of the fanout without modifying the IOC image.
- Expanded the Phoebus asset smoke from three single-PV assertions to exact PV
  inventories, unique widget names, CP macro and mock-label checks, navigation
  target checks, and a fail-closed writable-PV allowlist. Both local configs and
  the smoke now run in `npm run verify` and therefore in pull-request CI.
- A native IOC plus the locked Phoebus runtime displayed all three panels.
  On-screen controls changed all 14 legacy flashlamps STANDBY → RUN → STANDBY,
  unit-22 channel-1 state STANDBY → RUN → STANDBY, and its delay 50 → 77 → 50;
  each readback followed. Electron then launched the same three resources
  through one port-14918 server and rendered all rows as `SHARED`. Screenshots
  08-11 record that run. `npm run verify` passed 165/165 tests, the build, four
  config validations, and the expanded asset smoke.

## Unreleased — post-delivery defect fixes (continuation, 2026-08-04)

Three narrow fixes for the defects that `AGENT-PROMPT.md` listed as deliberately
left unfixed. No ticket changed bucket; the counts stay 7 implemented,
2 constructed-unverifiable, 3 blocked. Nothing was pushed.

- **CSI-844 Phoebus liveness by start identity.** `PhoebusServerManager` decided
  owned-server liveness with a bare `process.kill(pid, 0)` existence check, while
  `runtime-registry.ts` already distinguishes processes by OS start identity. A
  recycled PID could make the manager wrongly refuse to start a needed server.
  The manager now captures the server's start identity through the same
  `inspectProcess` dependency after spawn and compares it on each liveness check;
  an indeterminate identity falls back to plain liveness so a needed server is
  never wrongly refused. `SpawnReceipt` gains an optional `startIdentity`; the
  `isProcessAlive` injection point is unchanged. Six unit cases were added, and
  the live `acceptance:local` server-reuse path still passes. Confidence: high.
- **CSI-853 command discriminator on non-Linux POSIX identity.** `inspectProcess`
  derived its non-Linux identity from `ps -o lstart=`, whose whole-second
  granularity left a PID reused within the same second indistinguishable. `comm`
  is added as a second discriminator (`ps -o lstart= -o comm=`) so a PID reused by
  a different executable is detected; the residual same-second/same-executable
  gap that `/proc` and .NET start ticks avoid is documented. Linux and Windows
  paths are unchanged. `tests/process-inspector.test.ts` forces the `ps` path.
  Confidence: high for the different-executable case; the same-second/
  same-executable case stays a documented limitation.
- **Lockfile-consistent `run.sh` install.** `run.sh` used `npm install`, which
  can rewrite `package-lock.json` and diverge from `.github/workflows/ci.yml` and
  work order section 7. It now uses `npm ci`. Confidence: high.

Regression after the three fixes: 165/165 Node tests (156 inherited plus 9 new),
14/14 lifecycle service tests, typecheck/build/both config validations exit 0,
and `npm run acceptance:local` passed (IOC caget 0 / camonitor 124, six Electron
IPC launches, one reused Phoebus server across three BOBs, and the memento
restoring all three native alarm window titles).

## Unreleased — executable local contracts (fourth host)

- **CSI-853/CSI-854 local lifecycle contract.** Added a standalone loopback
  FastAPI sidecar with leases, sequenced idempotent mutations, heartbeats,
  atomic launch reservations, optional bearer authentication, and strict JSON
  schemas. Electron now uses a real HTTP adapter/coordinator when
  `local.hmiApi.baseUrl` is configured and retains the `disabled` no-op path
  otherwise. Retries reuse operation identity, 409 responses trigger an
  authoritative refresh, constrained launches reserve before spawn, and
  graceful quit deregisters observed entries. The contract and service docs
  label this a local acceptance interface, not the unresolved site API.
  Decision confidence: high for separating it from the EPICS gateway; moderate
  for the local version-1 wire shape.
- **CSI-843/CSI-847 executable launch contracts.** Added exact-path POSIX `.exe`
  fixtures for the two different LabVIEW builders, NUL-delimited argv/PID/start
  identity capture, and smoke coverage through the production materialization,
  spawn, registry, and policy modules. Literal metacharacters remain argv data;
  singleton and writer denials are exercised; stopped fixtures can relaunch;
  cleanup validates captured process identities before signaling their groups.
  Evidence explicitly states that NI LabVIEW was not executed, so both tickets
  remain constructed-unverifiable.
- **CSI-844/CSI-848 real Phoebus execution.** Locked the measured official ORNL
  Phoebus 4.7.4-SNAPSHOT archive and Temurin JDK 25.0.3 by SHA-256 and size,
  with an ignored local bootstrap/install. Real `-list` output supplied
  `display_runtime`, `alarm_tree`, `alarm_table`, and `alarm_area`. Electron
  opened three BOB resources through one server and the mock IOC supplied live
  values. A filesystem resource is now converted to a `file:` URI before an
  `app` query is appended; the real runtime had otherwise treated `?app=` as
  filename text. Decision confidence: high.
- **Phoebus first-resource readiness.** The locked build's TCP listener was
  observed before JavaFX installed its resource handler. Added optional
  `local.phoebus.resourceReadyDelayMs`; it is applied after a newly started
  listener and conservatively on cross-process reuse, where the other
  launcher's JavaFX readiness is unknown. Reuse of a server this manager
  already marked ready is immediate. Local acceptance uses the measured 8000
  ms; deployment leaves it unset until the site build is measured. Decision
  confidence: high for the locked build, unknown for the site build.
- **CSI-849 local memento evidence without a site claim.** A real Phoebus UI
  session arranged Alarm Tree, Alarm Area, and Alarm Table, then Phoebus saved
  the tracked memento. Its hash/provenance is tracked, and a fresh locked-runtime
  process restored the three stages. The local alarm root has no alarm server;
  BLK-002 and BLK-003 remain open for the site-created file and site build names.
- **One-command acceptance.** Added `config/local-acceptance.yaml`, CDP evidence
  collection, and `npm run acceptance:local`. The runner verifies the IOC,
  starts the lifecycle sidecar and an isolated X display, launches the alarm
  layout, two LabVIEW fixtures, and three BOBs through Electron IPC, asserts
  lifecycle/runtime/argv evidence, closes Electron through its quit path,
  restores the memento in a fresh Phoebus process, and stops only owned
  processes. The observed run passed. Regression results are 156/156 Node
  tests, 14/14 lifecycle service tests, typecheck/build/config validation exit
  0. Three new reference screenshots record the local Phoebus, restored layout,
  and combined launcher states.

## Unreleased — CSI-744 continuation (later host)

- **Local IOC and HMI EPICS gateway exercised on a third host.** The supplied
  IOC image passed its embedded checksum, loaded as
  `laser-mockup-ioc:ready`, and served the two required PVs under Docker host
  networking. A sibling checkout identified the EPICS gateway as
  `https://github.com/eli-eric/eli-hmi.git`, canonical branch `dev`,
  `backend/python-websocket-server`. The unchanged FastAPI + aioca source read
  value `32.0` over HTTP. Thirty-sample warm HTTP reads measured 2.284 ms p50
  and 2.682 ms p95; 20-sample writes measured 1.971 ms p50 and 2.382 ms p95.
  No production latency target or slow trace was supplied, so no optimization
  was made. The gateway has no launcher lifecycle registration endpoints, so
  BLK-001 now asks who owns that separate contract. On the same host, Electron
  reached `document.readyState=complete`, rendered 19 rows and seven expected
  headings, and a click on the safe `L4 CIS VCS` mock row appended the observed
  launch line to `/tmp/eli-hmi-launcher-mock.log`.
- **Combobox element ids no longer collide with their mount (CSI-851).** The
  control was assigned the mount element's own id, so `technology-filter` and
  `section-filter` each appeared twice in the rendered DOM, and
  `getElementById(<mount id>)` resolved to the wrapper instead of the control.
  `deriveComboboxIds()` and `comboboxOptionId()` now namespace every generated
  id under the mount id, and the accessible name is computed from the label
  plus the value span rather than an id reference that depended on document
  order. Measured on the running app before and after: the computed accessible
  name is `Technology Select` in both cases, no duplicate ids remain, the
  listbox still opens, and the Cameras filter still yields 3 of 19 rows. Two
  regression tests assert the generated ids differ from the mount id and stay
  unique.
- **A policy outcome that launched nothing is no longer reported as a launch
  (CSI-854).** The launch IPC handler ran `logLaunch({ok: true})` and returned
  `ok: true` unconditionally once the access policy resolved, so a
  `launched: false` focus outcome would have claimed a launch that never
  happened and written a launch record for a process that was never spawned.
  `describeUnperformedLaunch()` names that outcome and the handler returns a
  failure carrying the reason before the success log. Focus is still not
  claimed to work; the message states that no native window identity mechanism
  has been supplied, and BLK-010 stays open. The path is unreachable today
  because Electron main never injects `focusExisting`, so this removes a latent
  defect rather than a currently observable one. Four regression tests cover
  the focused, non-focused, and launched cases plus the ordering of the guard
  against the success log.
- **Dependency install reproduced on a clean host.** `npm ci` completed with
  exit 0 (`added 134 packages`, 0 vulnerabilities) and left
  `package-lock.json` unmodified. The previous host's `EAI_AGAIN` registry
  failure did not recur. This resolves that install limitation only and moved
  no ticket between buckets.
- **The three POSIX permission tests were executed.** Tests 85-87 skip under
  uid 0 because root bypasses permission bits. Running the same suite as a
  non-root account reported 123 tests, 123 passed, 0 failed, 0 skipped.
- **Status record separated by host.** `STATUS.md` now marks the inherited
  sections as the previous-host record and adds a current-host verification
  section with the commands, exit codes, and renderer assertions gathered here.
  Ticket buckets are unchanged at 5 IMPLEMENTED, 4 CONSTRUCTED-UNVERIFIABLE,
  3 BLOCKED.

## Unreleased — CSI-744 launcher core

- **Linux smoke fixture execution.** Restored executable modes on `run.sh` and
  the bundled POSIX mock launcher. A regression test executes the mock with
  shell metacharacters in its label and reads the appended temp log. The live
  Xvfb run used `npm start -- --noSandbox --remoteDebuggingPort 9222`; it
  rendered 19 rows, filtered Cameras to 3 rows, searched Camera Manager to 2
  rows, appended `Mock launch: L4 CIS VCS`, displayed and dismissed a missing
  executable error, and handed an HTTP URL to a controlled `xdg-open` fixture.
  Four screenshots in `reference-screenshots/` record the rendered states.
- **CSI-854 main-process access restrictions.** Added platform and per-item
  policies for `maxInstances`, write-mode exclusivity, requested launch mode,
  already-running action, and stale/unknown-state action. LabVIEW targets and
  legacy rows labelled `platform: LabVIEW` default to the restrictive
  single-instance reading while the ticket ambiguity remains open. Policy
  evaluation and launch are serialized per entry in Electron main, so two
  rapid requests cannot both pass before registration. Stale and unobservable
  state fail closed unless trusted config explicitly selects `allow`;
  renderer-side bypass is absent. `prompt` uses a logged main-process dialog.
  `focus` returns a precise error when no native window identity is available.
  Both “only once” and “one writer” policies are expressible, but site-wide
  enforcement remains blocked on external HMI discovery and the definition of
  write mode. `npm test` reported 122 tests, 119 passed, 3 skipped, 0 failed.
- **CSI-853 local runtime registry and disabled REST boundary.** Added a
  configurable reconciliation loop, launcher-owned process records containing
  resolved argv/PID/spawn time/last-seen state, and PID-reuse detection based on
  process start identity. Browser/folder launches are explicit external
  handoffs; Phoebus rows report shared server-port reachability without
  claiming individual panel presence. Runtime snapshots are exposed over IPC
  and rendered in a seventh table column. The `register` / `heartbeat` /
  `deregister` / `query` REST interface has one no-op adapter that reports
  disabled and sends no requests because the API source and contract are
  absent. Linux `/proc` identity was executed; the Windows PowerShell inspector
  is constructed but was not run here. `npm test` reported 104 tests, 101
  passed, 3 skipped, 0 failed.
- **CSI-852 typed launch diagnostics.** Process preflight and spawn errors now
  carry the resolved command and argv into the main-process failure log.
  Phoebus executable-path failures remain distinct from a server that starts
  but never opens its TCP listener. Tests cover both cases, the 500 ms startup
  grace constant, and JSONL failure records containing item id, argv, and reason.
  Target environments are omitted; credential-like argv and URL values are
  redacted. Passing the grace window still means only that the OS accepted the
  launch, not that the GUI remains healthy. `npm test` reported 96 tests, 93
  passed, 3 skipped, 0 failed.
- **CSI-851 navigation reconciliation.** The original wireframe's title,
  search, two filters, actions, and six data columns remain present. Tests now
  pin the accessible custom combobox semantics, the single table scroll region,
  sticky headers, and the strict six-column order. A runtime-state column width
  and DOM marker are reserved for CSI-853, but no state heading or cell is shown
  before registry data exists. CSI-853 later activates that column, and the
  reference screenshots were replaced during the live monochrome run. No visible
  layout change was made in this ticket. `npm test` reported 92 tests, 89 passed,
  3 skipped, 0 failed.
- **CSI-850 web launch audit.** Web targets still use Electron
  `shell.openExternal` and are validated at configuration load and immediately
  before launch. Tests reject `javascript:`, `file:`, `data:`, and
  protocol-relative inputs. An embedded Electron browser is not introduced:
  it would add session, certificate, navigation, and renderer-isolation duties
  without improving the operator launch flow. Decision confidence: moderate.
  `npm test` reported 89 tests, 86 passed, 3 skipped, 0 failed.
- **CSI-849 alarm layout flag construction and blocker.** A Phoebus target may
  request `layout: true`, which adds `-layout <local.phoebus.layoutFile>` only to
  the server-creating argv. The path is intentionally unset in the deployment
  template. A request is refused when the configured port already has a server,
  because a startup-only flag cannot then be applied. The memento and the site
  app names remain blocked on maintainers. Sequential resource opens were
  assessed as an unacceptable layout substitute because they do not control
  panel geometry or focus. The intake sheet accepts only a yes/no request and
  rejects per-entry memento paths. Confidence: high. `npm test` reported 86
  tests, 83 passed, 3 skipped, 0 failed.
- **CSI-848 Phoebus settings and panel argv construction.** Relative panel
  resources now resolve below `local.cssGuiRoot`; absolute filesystem paths and
  HTTP(S) resources remain direct. Optional application names are added through
  the `app` query parameter. `local.phoebus.settingsFile` appears only on the
  server-creating argv and never on follow-up resource opens, and tests reject
  literal shell quotes in argv. The site's internal application names remain
  blocked on running `phoebus -list` against the site build. `npm test` reported
  80 tests, 77 passed, 3 skipped, 0 failed.
- **CSI-844 Phoebus server mode and reuse.** Added the typed `phoebus` target,
  separate ensure-server/open-resource argv, a per-port serialized server
  manager, localhost TCP liveness probes, launcher-owned PID tracking, dead
  server recreation, and refusal to duplicate a still-running but unreachable
  server process. Startup wait is configurable with
  `local.phoebus.startupTimeoutMs` (default 30000 ms). No Phoebus executable or
  JAR was found in the bundle or searched host paths, so this remains
  constructed-unverifiable outside unit and real-listener tests. `npm test`
  reported 75 tests, 72 passed, 3 skipped, 0 failed.
- **CSI-847 LabVIEW EPICS target construction.** Added the typed
  `labview-epics` target (`guiName`, `guiType`, `exeName`) and a separate argv
  builder that passes `[zoneSymbol, guiName]`. The executable path is built
  below `Common/ELI/EPICS_GUIs/<guiType>/Builds/GUI Application`; intake and
  configuration documentation now expose the three fields. No LabVIEW runtime
  is present on this host, so execution remains constructed-unverifiable.
  `npm test` reported 68 tests, 65 passed, 3 skipped, 0 failed.
- **CSI-843 LabVIEW Developer target construction.** Added the typed
  `labview-dev` target (`iocName`, `hostName`, `iocType`, `exeName`),
  platform-native path joining, exact three-argument construction, launch-time
  allow-list/existence checks, and intake conversion. Tests assert the Windows
  path containing `GUI Application`, literal shell metacharacters in argv, and
  the missing-executable error. No LabVIEW runtime is present on this host, so
  this ticket remains constructed-unverifiable rather than executed end to end.
  `npm test` reported 62 tests, 59 passed, 3 skipped, 0 failed.
- **CSI-845 external HMI catalogs.** Added ordered filesystem/UNC catalog
  sources, deterministic later-source precedence with duplicate-id warnings,
  user-data caching, stale/unavailable source state, launcher logging, and a
  visible monochrome `CATALOG STALE` indicator. Added the distribution decision
  memo and typed-target intake columns. `npm test` reported 55 tests, 52 passed,
  3 skipped, 0 failed.
- **CSI-846 local machine configuration.** Added optional typed settings for
  LabVIEW/CSS roots, zone symbol, Phoebus executable/port/settings, named hosts,
  and the HMI API base URL. `${local.…}` references are expanded in catalog
  strings and fail at load with the missing key, item id, target kind, and
  field. `npm test` reported 49 tests, 46 passed, 3 skipped, 0 failed.

## Unreleased — strict monochrome reference pass

- **Fixed black-and-white palette.** Pico remains the standard component
  foundation, with its color tokens centrally constrained to pure black and
  white. The interface no longer follows Pico's dark grays, operating-system
  themes, or system accent colors.
- **Monochrome failures everywhere.** Runtime launch failures remain
  dismissible and actionable, while the dedicated startup configuration-error
  window now follows the same black-and-white presentation. Successful
  launches remain silent.
- **Palette regression coverage.** Tests inspect the renderer stylesheet and
  the actual inline startup-error style block, rejecting non-black/white color
  literals, functional color syntax, and gradients.

## 0.4.0 — visual, accessibility, and intake pass

Second review pass. Fixes the reported Linux select inconsistency, the nested
scrolling, and the wireframe appearance, and adds a deterministic intake→YAML
workflow — all without changing the launcher workflow itself.

- **Consistent, accessible filters.** The Technology and Section native
  `<select>`s are replaced by a custom **accessible combobox** (`combobox.ts`,
  ARIA "select-only combobox" pattern). A native select's popup is drawn by the
  OS and could not be themed, which is exactly why the closed control looked
  light while the open list looked dark on Linux/Electron. The combobox draws
  its own listbox from the shared Pico variables, so **closed, focused, open, and
  active-option states are identical on Linux, Windows, and macOS**. Full
  keyboard support (Enter/Space/↓ to open; ↑/↓/Home/End; type-ahead; Enter to
  choose; Esc to close; Tab to leave) and screen-reader semantics
  (`role`, `aria-expanded`, `aria-activedescendant`, `aria-selected`,
  `aria-labelledby`) are preserved.
- **Removed the conflicting select styling.** The former per-control overrides
  that caused mismatched open and closed states were consolidated into shared
  Pico variables. The current Unreleased palette constrains those variables to
  fixed black and white.
- **One coherent scrolling model.** The page body no longer scrolls; the table
  panel is the single scroll region, so the header, filters, and sticky column
  headings stay visible. On narrow widths the table keeps its own horizontal
  scroll and the page never gains a second horizontal scrollbar.
- **Less wireframe, more control-room.** Reworked spacing, uppercase muted field
  labels, sticky table header, row hover/focus states, denser rows, a bordered
  table panel, outline quick-action buttons, and a Pico dropdown for **More…**.
- **Intake → YAML converter.** `scripts/intake-to-yaml.ts` (+ pure, tested
  `src/shared/intake.ts`) deterministically converts a completed
  `intake/L4_GUI_INTAKE.csv` to launcher YAML. Only `Enabled = yes` rows are
  converted; invalid rows abort with row-numbered errors; no values are guessed.
  Output is validated by the same parser the app uses.
- **A Content-Security-Policy** meta tag was added to the renderer HTML
  (`default-src 'self'`; no remote origins), matching the no-CDN policy.
- **More tests:** 31 total (was 10). Added launch-status silence/error mapping,
  intake conversion + round-trip through the real config parser, config schema
  validation, multivalue filter coverage, and combobox type-ahead.
- Package and lockfile versions synchronized at `0.4.0`.
- Docs (README, CONFIG_HOWTO, CONFIG_SCHEMA, REMAINING_WORK) updated.

## 0.3.0-mvp — user-feedback pass

Adjustments from first user review of the flat-table launcher:

- **Search** now matches **Name and Note only** (was: name, technology,
  section, platform, RMC, note). Technology/Section discovery belongs to the
  dropdowns, not the free-text search.
- **Filters reduced to Technology and Section.** The Platform dropdown was
  removed; Platform remains a table column.
- **Header:** the wordmark/logo is larger and vertically centered with the
  quick-action buttons (was bottom-aligned and smaller).
- **No more success banner.** "Launch request sent: …" was removed — the user
  clicks and the GUI either opens or it doesn't. Failures still show a
  dismissible banner and are always written to the launch log; the current
  Unreleased styling is strictly monochrome. Process wrappers that exit
  non-zero during a 500 ms startup window are now reported instead of being
  treated as successful spawns.
- **Clearer launch errors for bad paths.** The main process now validates both
  existence and target type before launching and reports human-readable errors:
  - command path missing, not a file, or not executable on POSIX;
  - bare command missing from PATH;
  - working directory missing, inaccessible, or not a directory;
  - folder target missing, inaccessible, or not a directory.
- **New CONFIG_HOWTO.md**: step-by-step YAML instructions aimed at L4 users so
  they can fill in their own GUI entries for testing (the full reference stays
  in CONFIG_SCHEMA.md).
- **Standard component library:** the renderer now imports Pico CSS 2.1.1 for
  standard controls and tables. The remaining CSS is launcher-specific layout,
  sizing, contrast, and interaction styling; no runtime CDN is used.
- **Regression tests and CI:** pure filtering and launch-path validation are
  covered by Node tests. GitHub Actions runs `npm ci` and `npm run verify` on
  pushes and pull requests.
- Package and lockfile versions are synchronized at `0.3.0-mvp`.
- Docs (README, CONFIG_SCHEMA, REMAINING_WORK) updated accordingly.

## 0.2.2-mvp
- Added `run.sh` (Linux/macOS one-command runner: checks Node, installs deps,
  validates the config, then starts the app).


## 0.2.0-mvp — hardening pass (this iteration)

Continues the 0.1.0 MVP; the flat table UI, Electron main/preload/renderer
split, YAML config model, and mock launchers are preserved. Nothing was thrown
away. Changes:

### Security (config trust boundary)
- Added a `security` config block:
  - `allowedCommandRoots` — process `command` paths must resolve inside an
    allow-listed directory or the launch is refused (enforced at launch,
    symlinks resolved so a symlink cannot escape a root).
  - `allowBareCommands` — when false, bare PATH-resolved command names are
    refused.
  - `allowInsecureConfigPermissions` — when false (default), the launcher
    refuses to load a **world-writable** config on POSIX.
- Kept `shell: false` and argv-array args (no arg-joining, no shell parsing).
- Documented the config-as-trust-root model in README and CONFIG_SCHEMA.md, and
  gave `launcher.example-real.yaml` a strict posture.
- Rationale: the previous MVP would execute **any** command named in the config
  (verified: absolute `/bin/sh -c …` and bare PATH names both ran). The
  allow-list + bare-command switch close the absolute-path drive-by vector; the
  residual (an interpreter as `command` plus arbitrary `args`) is documented.

### Diagnostics (new)
- Added `src/main/logger.ts`: structured JSONL launch log written to the OS
  app-logs dir (`launcher.log.jsonl`), independent of the mock scripts. Records
  timestamp, id, label, kind, resolved command/args|url|path, ok, error,
  durationMs. Config load success/failure is also logged.

### Startup failure is now visible
- A malformed/duplicate/invalid config previously called `console.error` +
  `app.quit()` — the app vanished with no message. Now the main process opens a
  dedicated **error window** that shows the exact error, the config path, and
  remediation hints, and keeps the process alive.

### Schema validation
- Web-target URLs are validated (HTTP(S) + well-formed) **at load**, not only at
  launch, so bad URLs fail fast at startup.
- Launch failures now return a **discriminated result** to the renderer
  (`{ ok: false, error, … }`) instead of only throwing, so the UI can show a
  precise reason. `LaunchResult` in `shared/types.ts` is now a union.

### Refactor (behaviour-preserving)
- Extracted all pure logic — YAML parsing, schema validation, security policy,
  variable expansion, path resolution, command allow-list, process
  materialisation — into `src/main/config.ts`, which imports **only** `yaml` and
  Node built-ins (no Electron). `src/main/index.ts` is now Electron wiring only.
- This makes validation unit-testable and powers the new
  `npm run validate-config` CLI (`scripts/validate-config.ts`, run via `tsx`).

### Tooling / DX
- `package.json`: version bump; added `validate-config` and `check` scripts.
- `tsconfig.node.json`: include `scripts/**/*.ts` so the CLI is typechecked.
- Docs: rewrote README; added CONFIG_SCHEMA.md, REMAINING_WORK.md, this file.

### UX (small, no redesign)
- Search placeholder now reflects actual behaviour ("Search name, technology,
  section, RMC, note…").
- Status banner distinguishes success vs. failure and includes the failure
  reason.
- Default config's Linux process targets now invoke the mock script directly by
  an absolute in-allow-list path (demonstrates the allow-list) instead of via a
  bare `sh`. `examples/launchers/mock-launch.sh` is marked executable.

### Already present in 0.1.0 (verified, left as-is)
Sticky table header, row hover/focus, keyboard Enter/Space to launch, Esc /
outside-click to close the More menu, empty-filter state, duplicate-id
detection, HTTP(S)-only web launch, `shell:false` spawning, folder-open error
surfacing, `contextIsolation`/`sandbox`/`nodeIntegration:false`, config
variables, and OS command overrides.

### Validation run before release
`npm run typecheck` and `npm run build` pass. The config parser/validator and
launch path were exercised headlessly: all schema checks reject as expected;
the allow-list blocks the previously-working `/bin/sh -c` execution and no file
was created; web launch enforces HTTP(S); folder errors surface; mock spawn
writes to the mock log; JSONL launch records are written; and the packaged app
boots under Xvfb (happy path logs "Config loaded" with 9 rows; a broken config
opens the error window and stays alive).
