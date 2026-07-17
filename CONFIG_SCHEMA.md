# Configuration schema

The launcher reads a single YAML file. By default `config/launcher.yaml`
(discovery order in README). Validate any file without launching:

```sh
npm run validate-config -- path/to/launcher.yaml
```

## Top level

```yaml
appName: L4 Launcher        # optional; window/header title. Default "L4 Launcher".
security: { … }             # optional; process-launch guardrails. See "Security".
entries: [ … ]              # the GUI rows (also accepts legacy key `rows`).
quickActions: [ … ]         # top-right buttons (Data Browser, Alarm System).
moreActions: [ … ]          # items inside the More… menu.
```

All ids across `entries`, `quickActions`, and `moreActions` share one namespace
and **must be unique**; a duplicate fails at load. If `id` is omitted it is
generated from the name/label (prefer explicit ids).

## Entry (one GUI row)

```yaml
- id: camera-manager-alena          # unique; stable identifier used by IPC + logs
  name: Camera Manager Alena        # user-facing string (also accepts `label`)
  technology: Cameras               # string or "a; b" -> ["a","b"] (also `type`)
  section: L4b; L4c                  # string or "a; b" -> ["a","b"]
  platform: LabVIEW                  # single string (also `guiType`); e.g. LabVIEW/Phoebus/Web/CSS
  rmc: RMC403                        # arbitrary string; "" or "--" render as "--"
  note: Cam XYZ, Cam ABC             # arbitrary string
  target: { … }                      # required; see "Targets"
```

Field semantics:

- **technology** = domain/function (Vacuum, Cameras, Timing, Pointing, Laser).
- **platform** = implementation/runtime (LabVIEW, Phoebus, Web, CSS). This split
  is intentional and is why both a Technology and a Platform filter exist.
- **technology** and **section** accept either a plain string or a
  semicolon-separated string (`"L4b; L4c"`), or a YAML list (`[L4b, L4c]`). All
  three parse to a list; the list feeds the filter dropdowns. Empty / `--`
  becomes an empty list.
- **search** matches name, technology, section, platform, rmc, and note.

## Targets

Every entry/action has exactly one `target`. Three kinds:

### web

```yaml
target:
  kind: web
  url: https://host.example/path      # HTTP(S) only — validated at load
```

Opened in the OS default browser via Electron `shell.openExternal`. Non-HTTP(S)
or malformed URLs are rejected at startup.

### process

```yaml
target:
  kind: process
  command: /opt/eli/l4-launchers/open-x.sh   # required
  args: [ "--flag", "value" ]                # optional; passed as an argv array
  cwd: /opt/eli/l4-launchers                 # optional working directory
  env: { EPICS_CA_ADDR_LIST: "10.0.0.1" }    # optional extra env (merged over process env)
  # OS-specific overrides (merged over the base fields on that platform):
  windows: { command: "…", args: [ … ], cwd: "…", env: { … } }
  linux:   { command: "…", args: [ … ], cwd: "…", env: { … } }
  darwin:  { command: "…", args: [ … ], cwd: "…", env: { … } }
```

- Spawned with `shell: false`. **Args are an argv array and are never joined
  into a shell string**, so there is no shell parsing or command injection via
  args. Prefer `args: []` entries over embedding arguments in `command`.
- Detached and unref'd (the GUI keeps running if the launcher closes). Success
  means the OS accepted the spawn; it is not a running-state check.
- `command`, each `args` element, `cwd`, and `env` values are variable-expanded
  (see "Variables").
- Path resolution of `command`/`cwd`: absolute paths are used as-is; a value
  with a path separator is resolved against the **config directory** (never the
  process CWD); a bare name (no separator) is left for OS PATH resolution and is
  governed by `security.allowBareCommands`.
- `.cmd`/`.bat` on Windows cannot be spawned without a shell; use
  `cmd.exe /c wrapper.cmd` (a bare `cmd.exe`, so `allowBareCommands: true`) or a
  real `.exe` wrapper.

### folder

```yaml
target:
  kind: folder
  path: /mnt/l4-shared         # local dir or, on Windows, a UNC path '\\host\share'
```

Opened via Electron `shell.openPath`. A missing/unmounted path returns a clear
error surfaced in the UI and the launch log.

## Actions (quickActions / moreActions)

```yaml
- id: data-browser
  label: Data Browser          # button/menu text
  target: { … }                # same target grammar as entries
```

`quickActions` render as top-right buttons; `moreActions` render inside the
More… menu. The Jira-specified defaults are Data Browser + Alarm System (quick)
and Sequencer, Safety Diagnostics, Network Shared Folder (more).

## Security

```yaml
security:
  allowedCommandRoots:                 # default: [] (no directory restriction; a startup warning is logged)
    - /opt/eli/l4-launchers
    - ${APP_ROOT}/examples/launchers
  allowBareCommands: false             # default: true
  allowInsecureConfigPermissions: false # default: false
```

- **The config file is a trust root.** `process` targets run with the launcher
  user's privileges. Anyone who can write the file or its directory controls
  what runs on every workstation that loads it. Deploy it read-only to
  non-privileged users.
- **allowedCommandRoots** — when non-empty, a resolved process `command` that
  contains a path must live under one of these directories, or the launch is
  refused. Enforced **at launch** (so it applies to the exact command for the
  current platform), with symlinks resolved so a symlink cannot escape a root.
  Entries may use `${APP_ROOT}`/`${CONFIG_DIR}`/env and relative paths (resolved
  against the config directory). **It does not constrain `args`** — so in a
  hardened deployment do not use an interpreter (`sh`, `python`) as `command`;
  make the wrapper itself the command.
- **allowBareCommands** — when `false`, a bare `command` (no path separator,
  resolved via OS PATH) is refused. Recommended for hardened setups; note that
  `cmd.exe`-based Windows wrappers require `true`.
- **allowInsecureConfigPermissions** — when `false` (default), on POSIX the
  launcher refuses to load a world-writable config file. Set `true` only if you
  understand the risk (e.g. a controlled single-user machine).

## Variables

Expanded inside `command`, each `args` element, `cwd`, `env` values, `url`,
`path`, and `security.allowedCommandRoots`. Both `${NAME}` and `%NAME%` forms
are accepted.

| Variable        | Value                                                             |
|-----------------|-------------------------------------------------------------------|
| `${APP_ROOT}`   | Application root (dev: project dir; packaged: app path)           |
| `${CONFIG_DIR}` | Directory containing the active YAML config                       |
| `${HOME}`       | `HOME`                                                            |
| `${USERPROFILE}`| `USERPROFILE`                                                    |
| `${TEMP}` / `${TMP}` / `${TMPDIR}` | OS temp dir (first of TEMP/TMP/TMPDIR set) |
| `${ANY_ENV}`    | Any environment variable by name                                  |

## Validation performed at load

- YAML parses to a mapping (clear error otherwise).
- Each target has a supported `kind`; `web` has a valid HTTP(S) `url`; `process`
  has a `command`; `folder` has a `path`.
- Web URLs are protocol- and format-checked eagerly.
- All ids are unique across entries + quickActions + moreActions.
- On POSIX, the config file is not world-writable (unless overridden).

Command allow-listing and folder-existence are enforced **at launch** (they are
platform/runtime specific), and every launch outcome is written to the launch
log.
