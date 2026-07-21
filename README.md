# ELI HMI Launcher (L4) — MVP

Minimal, config-driven launcher for L4 control-system GUIs. It is an Electron
desktop app with a vanilla-TypeScript renderer: a flat, searchable, filterable
table that reflects an external YAML configuration. Clicking a row launches a
GUI. Top-right quick actions cover Data Browser and Alarm System; a **More…**
menu covers Sequencer, Safety Diagnostics, Network Shared Folder, and future
services.

The renderer only displays/filters and sends a launch **id** over IPC. The main
(Node) process owns config loading, validation, security enforcement, and
launching. The renderer never receives or sends raw commands.

Version: `0.2.0-mvp`. Node 18+ recommended (built/tested on Node 22).

---

## Run

```sh
npm install
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
npm run typecheck                    # tsc -b (main+preload+shared+scripts, and renderer)
npm run build                        # electron-vite build -> ./out
npm run check                        # typecheck + build in one go
npm run validate-config              # validate config/launcher.yaml with the real parser
npm run validate-config -- <path>    # validate a specific YAML (exit 1 on error) — good for CI/pre-deploy
```

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
- **Search**: filters across name, technology, section, RMC, and note.
- **Technology / Section / Platform** dropdowns: filter the table. Options are
  derived from the loaded config. An empty result shows a clear empty state.
- Every launch shows a status banner: *"Launch request sent: …"* on success, or
  a red *"Launch failed: … — <reason>"* on failure.

> "Request sent", not "launched": process targets are fire-and-forget. A
> successful spawn means the OS accepted the launch, not that the GUI stayed up.
> Detecting running state is out of scope for v1.

Because mock desktop notifications may be unavailable on a headless/plain
desktop, the authoritative signals are the in-app status banner, the mock log
above, and the structured launch log below.

---

## Diagnostics: structured launch log

Independently of the mock scripts, every launch attempt is appended as one JSON
object per line (JSONL) to a log in the OS app-logs directory:

- Linux: `~/.config/eli-hmi-launcher/logs/launcher.log.jsonl`
- Windows: `%APPDATA%\eli-hmi-launcher\logs\launcher.log.jsonl`
- macOS: `~/Library/Logs/eli-hmi-launcher/launcher.log.jsonl`

Each launch record contains: timestamp, `id`, `label`, `kind`, the resolved
`command`+`args` / `url` / `path`, `ok`, `error` (on failure), and `durationMs`.
Config-load success/failure is also logged. Example:

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
- Malformed config **fails visibly**: the app opens an error window explaining
  the problem instead of exiting silently.

`config/launcher.yaml` is the runnable mock config.
`config/launcher.example-real.yaml` is the deployment template (strict security
posture, placeholder paths).

---

## Scope (v1)

In: L4 flat table, search, three filters, row-click launch, quick actions, More
menu, three target kinds (web/process/folder), OS command overrides, config
variables, security allow-list, launch logging.

Out (not implemented; see REMAINING_WORK.md): LabVIEW running-state detection,
in-app config editing, per-user/section/machine customization, auth/roles,
database backend, telemetry, auto-updater.
