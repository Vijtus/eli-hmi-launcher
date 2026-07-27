# Changelog

## Unreleased — strict monochrome reference pass

- **Fixed black-and-white palette.** Pico remains the standard component
  foundation, with its color tokens centrally constrained to pure black and
  white. The interface no longer follows Pico's dark grays, operating-system
  themes, or system accent colors.
- **Monochrome failures everywhere.** Runtime launch failures remain
  dismissible and actionable, while the dedicated startup configuration-error
  window now follows the same black-and-white presentation. Successful
  launches remain completely silent.
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
