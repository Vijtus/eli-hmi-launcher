# Changelog

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
