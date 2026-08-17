# ELI HMI Launcher (L4) — MVP

Minimal, config-driven launcher for L4 control-system GUIs. It is an Electron
desktop app with a vanilla-TypeScript renderer styled with Pico CSS: a flat,
searchable, filterable table that reflects an external YAML configuration.
Clicking a row launches a GUI. Top-right quick actions cover Data Browser and
Alarm System; a **More…**
menu covers Sequencer, Safety Diagnostics, Network Shared Folder, and future
services. The interface uses a fixed, high-contrast black-and-white palette and
does not follow the operating-system color scheme.

The renderer only displays/filters and sends a launch **id** over IPC. The main
(Node) process owns config loading, validation, security enforcement, and
launching, including instance/write-mode access checks. The renderer never
receives or sends raw commands or resolved access policies.

Version: `0.4.0`. This implementation run used Node `v22.16.0`; Electron 40 requires a currently supported Node toolchain for development.

---

## Run

```sh
npm ci
npm start          # electron-vite dev
```

The default `config/launcher.yaml` is wired to **mock launchers** so everything
is clickable immediately without real LabVIEW/Phoebus paths. Mock process
launches append to `<OS-temp>/eli-hmi-launcher-mock.log`.

```sh
# Linux/macOS
tail -f "${TMPDIR:-/tmp}/eli-hmi-launcher-mock.log"
# Windows (PowerShell)
Get-Content "$env:TEMP\eli-hmi-launcher-mock.log" -Wait
```

## Build / typecheck / validate

```sh
npm test                             # regression tests for filtering, launch validation, UI palette, and config
npm run typecheck                    # tsc -b (main+preload+shared+scripts, and renderer)
npm run build                        # electron-vite build -> ./out
npm run check                        # typecheck + build in one go
npm run validate-config              # validate config/launcher.yaml with the real parser
npm run validate-config -- <path>    # validate a specific YAML (exit 1 on error)
npm run intake-to-yaml -- <csv>      # convert a completed intake sheet to YAML entries
npm run smoke:hmi-lifecycle           # exercise the loopback lifecycle HTTP contract
npm run smoke:labview-contract        # execute exact-path POSIX launch fixtures
npm run smoke:phoebus-local           # validate wrapper argv and local BOB assets
npm run acceptance:local              # run the IOC + lifecycle + Electron + Phoebus acceptance
npm run verify                       # tests + build + four config validations + Phoebus assets
```

## Executable local acceptance

`npm run acceptance:local` exercises the joined local stack through the built
Electron main process. It verifies the supplied IOC with the required `caget`
and `camonitor`, prepares the static mock records and in-memory flashlamp
fanout with a complete `caput` audit, starts the loopback lifecycle sidecar, applies the tracked
alarm layout first, launches both LabVIEW contract fixtures and three Phoebus
BOBs through IPC, captures lifecycle/runtime/argv evidence, and then restores
the memento in a fresh Phoebus process. It stops only processes that it started
or identified from run-specific receipts.

Prerequisites are Linux, Docker access, `npm ci`, the loaded
`laser-mockup-ioc:ready` image, `Xvfb`, `scrot`, `xwininfo`, `lsof`, `jq`, and a
Python interpreter with the dependencies from
`services/hmi-lifecycle-api/requirements.txt`. JWM is used when available.
Bootstrap installs the SHA-256-locked Phoebus/JDK artifacts under ignored
`.local/phoebus/`; the initial download is about 487 MB. If the Python is not in
the standard local paths, set `ELI_HMI_LIFECYCLE_PYTHON` to its executable.

Each run creates an exclusive ignored directory below
`.local/acceptance/<UTC timestamp>.<random suffix>/`,
including literal CA output, JSON launch/lifecycle records, exact NUL-delimited
argv captures, logs, window trees, and screenshots. The tracked sample images
are `reference-screenshots/05-local-phoebus-live.png`,
`06-local-alarm-layout-restored.png`, and
`07-local-acceptance-launcher.png`. The expanded operator-style mock is recorded
in `08-local-realistic-overview.png`, `09-local-realistic-cooling.png`,
`10-local-realistic-timing-control.png`, and
`11-local-realistic-launcher.png`.

This acceptance config contains explicit local contracts. The `.exe` files are
POSIX fixtures, not NI LabVIEW binaries. The lifecycle sidecar is not the
unresolved site lifecycle API, and the memento uses a local alarm root without
a site alarm server. See `STATUS.md` and `BLOCKERS.md` for the ticket buckets.

## Collecting real GUI entries from L4 users

`intake/L4_GUI_INTAKE.csv` is a blank collection sheet. Maintainers hand it to
GUI owners, who fill one row per GUI (name, technology, section, how it starts).
Convert completed rows to YAML deterministically:

```sh
npm run intake-to-yaml -- intake/L4_GUI_INTAKE.csv -o converted.yaml
npm run validate-config -- converted.yaml   # same validator the app uses
```

Only rows marked `Enabled = yes` are converted; invalid rows abort with
row-numbered errors (the converter never guesses values). Merge the resulting
`entries:` into the deployed `launcher.yaml`. See **CONFIG_HOWTO.md** §6.

## Point at a different config

```sh
# Linux/macOS
ELI_LAUNCHER_CONFIG=/absolute/path/to/launcher.yaml npm start
# Windows (PowerShell)
$env:ELI_LAUNCHER_CONFIG="C:\ELI\launcher\launcher.yaml"; npm start
```

If `ELI_LAUNCHER_CONFIG` is unset, the app searches (in order) the current
working directory, the app path, the packaged resources dir, and the executable
dir — each for `config/launcher.yaml`.

---

## How to test the UI

- **Row click** (or focus a row and press **Enter**/**Space**): launches that GUI.
- **Data Browser** / **Alarm System** buttons (top right): quick-action launches.
- **More…**: opens the services menu. **Esc** or a click outside closes it.
- **Search**: matches **Name** and **Note** only. Technology and Section are
  covered by the dropdowns instead.
- **Technology / Section** dropdowns: filter the table. Options are derived
  from the loaded config. An empty result shows a clear empty state. These are
  custom accessible comboboxes (ARIA listbox), not native `<select>`s, so the
  closed, focused, and open states render identically on Linux, Windows, and
  macOS. Full keyboard support: open with **Enter/Space/↓**, move with
  **↑/↓/Home/End**, type-ahead to jump, **Enter** to choose, **Esc** to close.
- A **successful launch shows nothing** — the user clicks and the GUI opens.
  A **failed launch** (missing or non-executable command, invalid working
  directory, unmounted folder, command outside the allow-list, …) shows a
  black-and-white, dismissible error banner with the reason.
- The **State** column is session-local. `RUNNING` requires a launcher-owned PID
  and matching process start identity; `SHARED` means the configured Phoebus
  server port is reachable; `HANDOFF` means Electron passed a browser/folder
  request to another application. These labels are not interchangeable.
- LabVIEW entries default to one launcher-observed instance and fail closed on
  stale or unknown state. Main serializes two rapid requests for the same id.
  This cannot detect an HMI started outside the launcher session until the HMI
  API integration supplies external state.

> Process targets have a short startup grace window. A missing executable or an
> immediate non-zero wrapper exit is reported as a failure. After that window,
> the local registry periodically reconciles process identity. Browser tabs and
> individual Phoebus panels remain unobservable because they do not map 1:1 to
> launcher-owned child PIDs.

Because there is intentionally no success UI, the authoritative signals for
testing are the launched GUI itself, the mock log above, and the structured
launch log below (which records every attempt, success or failure).

---

## Diagnostics: structured launch log

Independently of the mock scripts, every launch attempt is appended as one JSON
object per line (JSONL) to a log in the OS app-logs directory:

- Linux: `~/.config/eli-hmi-launcher/logs/launcher.log.jsonl`
- Windows: `%APPDATA%\eli-hmi-launcher\logs\launcher.log.jsonl`
- macOS: `~/Library/Logs/eli-hmi-launcher/launcher.log.jsonl`

Each launch record contains: timestamp, `id`, `label`, `kind`, the resolved
`command`+`args` / `url` / `path`, `ok`, `error` (on failure), and `durationMs`.
Failures retain their resolved argv so path and quoting faults can be diagnosed.
The target environment is never written. Values following credential-like
flags (`token`, `password`, `secret`, API keys, authorization) and matching URL
query parameters are replaced with `[REDACTED]`. Do not place opaque secrets in
unlabelled argv positions. Config-load success/failure is also logged. Example:

```json
{"ts":"2026-…Z","type":"launch","id":"camera-manager-alena","label":"Camera Manager Alena","kind":"process","command":"/opt/eli/l4-launchers/open-camera-manager-alena.sh","args":[],"ok":true,"durationMs":12}
```

---

## Configuration & security (summary)

Full reference: **CONFIG_SCHEMA.md**. The essentials:

- The config file is a **trust root**. `process` targets run with the launcher
  user's privileges. Anyone who can write the file (or its directory) can make
  every workstation that loads it run arbitrary commands.
- Deploy the config **read-only** to non-privileged users. On POSIX the launcher
  **refuses to load a world-writable config** unless
  `security.allowInsecureConfigPermissions: true`.
- Constrain process launches with the `security` block:
  - `allowedCommandRoots`: a resolved process `command` containing a path must
    live under one of these dirs (enforced at launch, symlinks resolved).
  - `allowBareCommands`: set `false` to reject bare PATH-resolved names.
- Web targets are HTTP(S)-only (validated at load). Folder opens report a clear
  error if the path is missing/unmounted.
- Duplicate ids across entries + quickActions + moreActions are rejected at load.
- Launch access policies resolve from platform defaults to per-item overrides
  and are enforced in main before spawn. LabVIEW defaults to `maxInstances: 1`;
  write exclusivity is modeled, but its site-specific mode signal remains a
  blocker. Unknown or stale state defaults to fail-closed.
- Malformed config **fails visibly**: the app opens an error window explaining
  the problem instead of exiting silently.
- When `local.hmiApi.baseUrl` is present, main coordinates leases, heartbeats,
  external state, and atomic launch reservations through the versioned local
  lifecycle adapter. With no URL, the adapter reports `disabled` and performs
  no lifecycle request. The bundled service is for local acceptance; the site
  owner and contract remain BLK-001.

`config/launcher.yaml` is the runnable mock config.
`config/launcher.example-real.yaml` is the deployment template (strict security
posture, placeholder paths).
`config/local-acceptance.yaml` is the executable Linux contract configuration;
it is not a deployment template.

**Adding your GUIs to the launcher (for L4 users):** see **CONFIG_HOWTO.md** —
a short, copy-paste guide for filling in entries without reading the full
schema reference.

---

## Scope (v1)

In: L4 flat table, search over name/note, Technology + Section filters,
row-click launch, quick actions, More menu, Pico CSS standard controls, six
typed targets, ordered external catalogs, machine-local configuration, Phoebus
server reuse, session-local runtime state, OS command overrides, config
variables, main-process access policies, security allow-list, launch logging,
regression tests, and CI.

Blocked or undecided site integration is listed in `BLOCKERS.md`, including the
HMI Python REST contract, alarm memento, Phoebus app names, write-mode meaning,
and real L4 values. In-app config editing, database storage, telemetry, and an
auto-updater are not part of this work order.

---

## UI component library

The renderer imports `@picocss/pico` locally through the build; it does not
depend on a CDN at runtime. Pico provides the standard input, button, dropdown,
and table foundations. Launcher CSS centrally overrides Pico's color tokens with
only `#000000` and `#ffffff`, so theme defaults and system accent colors cannot
leak into any interaction state. `styles.css` then adds the launcher layout,
single-scroll model, compact sizing, and accessible filter combobox without
reimplementing Pico's standard controls.

The two filter dropdowns are a custom accessible combobox (`combobox.ts`,
ARIA "select-only combobox" pattern) rather than a native `<select>`, because a
native select's popup list is drawn by the OS and cannot be themed consistently
across platforms. The combobox draws its own listbox from the same Pico
variables, keeping every state consistently black and white, and keeps full
keyboard and screen-reader semantics (`role="combobox"`/`listbox"`/`option"`,
`aria-expanded`, `aria-activedescendant`, `aria-selected`).

## Logo

The header uses a **text wordmark** (`L4 LAUNCHER`). No official ELI/L4 image
logo was supplied with this work, and none was invented. If maintainers provide
an official asset, drop it in and replace the `<h1>` wordmark, preserving its
aspect ratio. See `BLOCKERS.md`.
