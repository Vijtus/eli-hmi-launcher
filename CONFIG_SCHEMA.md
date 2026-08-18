# Configuration schema

The launcher reads one root YAML file and may merge ordered external catalog
files. The root defaults to `config/launcher.yaml` (discovery order in README).
Validate any root file without launching:

```sh
npm run validate-config -- path/to/launcher.yaml
```

## Top level

```yaml
appName: L4 Launcher        # optional; window/header title. Default "L4 Launcher".
local: { … }                # optional machine-specific paths/hosts; required only when used.
catalog: { sources: [ … ] } # optional ordered external entry catalogs.
access: { platforms: { … } }# optional main-process launch restrictions.
security: { … }             # optional; process-launch guardrails. See "Security".
entries: [ … ]              # the GUI rows (also accepts legacy key `rows`).
quickActions: [ … ]         # top-right buttons (Data Browser, Alarm System).
moreActions: [ … ]          # items inside the More… menu.
```

All ids across `entries`, `quickActions`, and `moreActions` share one namespace
and **must be unique**; a duplicate fails at load. If `id` is omitted it is
generated from the name/label (prefer explicit ids).

## Catalog sources

The inline `entries:` list remains valid and has the lowest precedence.
Additional entry documents can live outside the application directory,
including on a mounted filesystem or UNC path:

```yaml
catalog:
  sources:
    - id: shared-l4
      path: '\\server\share\l4-launcher-catalog.yaml'
    - id: machine-override
      path: '${CONFIG_DIR}/machine-catalog.yaml'
```

Each source file is a YAML mapping containing `entries:` (legacy `rows:` is
also accepted). Sources load in listed order. On duplicate entry `id`, the
later source replaces the earlier row and the launcher logs both source ids.
Duplicates inside one source are rejected.

Successful external sources are cached under the launcher's OS user-data
directory. If a source later cannot be read or parsed, the cached document is
used and the UI displays `CATALOG STALE` with the source id and cache timestamp.
If no usable cache exists, that source is skipped, the warning is logged, and
the launcher still opens with the remaining sources. `quickActions` and
`moreActions` stay in the root config and are not imported from catalog files.

## Git config repo overlay

When `ELI_LAUNCHER_CONFIG_REPO_URL` is set, the launcher resolves a host file and
a zone file from a git repository and layers them onto this schema before
validation. See README.md > Git-backed configuration for the repo layout, the
environment variables, and the resolution order. In schema terms:

| Config repo input | Lands in |
|---|---|
| host `zone:` | `local.zoneSymbol` |
| host `P4-workspace:` | `local.workspaceRoot` |
| host `css-gui:` | `local.cssGuiRoot` |
| host `css-install:` | `local.phoebus.installRoot` |
| host `hmi-server:` | `local.hmiApi.baseUrl` (+ `local.hosts."hmi-server"`) |
| host / zone `local:` | merged into `local:` verbatim |
| host / zone `launcher:` | `appName`, `quickActions`, `moreActions` (replaces the root file's) |
| zone `labview-dev:` etc. | `entries:`, as a catalog source named `zone:<ZONE>` |

Precedence is zone file, then host file, then the host file's own `local:` block;
all of them override `local:` in this file. Mappings merge key by key, scalars and
lists replace wholesale, and `null` never overrides.

Zone entries are injected as an ordinary catalog source appended after any
declared `catalog.sources`, so the "later source wins" rule below applies to them
unchanged, and an unreachable repo marks them `cached`/`stale` exactly like an
unreachable filesystem catalog.

`appName`, `quickActions` and `moreActions` may be set from a `launcher:` block in
the zone or host document; the host wins, and a present value REPLACES the root
file's rather than merging with it. Omitting the block leaves the root file in
charge.

`security:` and `access:` are **never** taken from the config repo. This file
remains the trust root that decides which commands may be spawned; a repository
that can be pushed to must not be able to relax `security.allowedCommandRoots`.

`hmi-server` becomes the lifecycle API base URL. A bare `host:port` yields
`http://host:port/api/lifecycle/v1` plus `allowInsecureTransport: true`; a value
that already carries a scheme is used as written and keeps the strict rules; a
value that already carries a path is used verbatim. See README.md > How
`css-install` and `hmi-server` are interpreted.

## Local machine settings

`local:` contains values that differ by workstation. The block, and every key
inside it, is optional until a launcher item references that key.

```yaml
local:
  workspaceRoot: 'C:\ELI\Workspace'
  cssGuiRoot: 'C:\ELI\CSS_GUIs'
  zoneSymbol: L4
  phoebus:
    installRoot: 'C:\Phoebus' # optional; the install DIRECTORY
    executable: 'C:\Phoebus\phoebus.bat'
    serverPort: 4918
    settingsFile: 'C:\ELI\CSS_GUIs\settings.properties' # optional
    # layoutFile: 'C:\ELI\CSS_GUIs\alarm-layout.memento' # optional; site-created
    startupTimeoutMs: 30000 # optional; default 30000
    resourceReadyDelayMs: 8000 # optional; default 0; set only from measured runtime evidence
  hosts:
    laserMockup: 127.0.0.1
  hmiApi:
    baseUrl: http://127.0.0.1:8765/api/lifecycle/v1
    stationId: operator-station-1 # optional; defaults to OS hostname
    authTokenEnv: ELI_HMI_LIFECYCLE_TOKEN # variable name, never the token
    requestTimeoutMs: 2000
    heartbeatIntervalMs: 5000
  monitoring:
    reconcileIntervalMs: 5000 # optional; default 5000
```

`local.phoebus.installRoot` is the Phoebus install DIRECTORY, whereas
`local.phoebus.executable` is a FILE. It exists because the git config repo's
`css-install` key names a directory (`C:\CSS Phoebus\product-5.0.2`). When
`executable` is absent, the install root is PROBED for `phoebus.bat`, then
`phoebus.sh`, then `phoebus`, and the first that exists is used. When none exist —
the normal case when validating a Windows deployment from a POSIX workstation —
the platform default is used so the config still loads and the missing path is
reported by the ordinary existence check at launch. An explicit `executable`
always wins.

`local.hmiApi.allowInsecureTransport` permits a lifecycle API reached over plain
HTTP on a non-loopback host. It is set automatically when the config repo's
`hmi-server` key gives a bare `host:port`. It never permits a credential in
cleartext: `authTokenEnv` combined with a plain-HTTP non-loopback `baseUrl` is
refused outright. Set it to `false` to restore the strict HTTPS requirement.

The example values above illustrate shape only; deployed values must come from
the control-system maintainers. `local.phoebus.serverPort`, when present, must
be an integer from 1 to 65535. `hosts` accepts named host/IP strings so catalog
entries can use `${local.hosts.<name>}` without hard-coding addresses.
`local.phoebus.startupTimeoutMs` is a positive integer. It bounds how long the
launcher waits for the server TCP listener after the operating system accepts
the process start. `local.phoebus.resourceReadyDelayMs` is an optional positive
integer delay applied after a newly started listener appears and before its
first resource request is sent. It is also applied conservatively when a
listener belongs to another launcher process, because that listener may be in
the same startup gap; reuse of this launcher's known-ready server is immediate.
The locked local Phoebus build needs 8000 ms because its TCP listener was
observed before its JavaFX resource handler. Leave it unset unless the deployed
build shows the same ordering. Decision confidence: high for the measured local
build, unknown for the site build.
`local.monitoring.reconcileIntervalMs` is a positive integer that controls local
liveness reconciliation.

When `local.hmiApi.baseUrl` is absent, lifecycle networking is disabled and the
launcher retains session-local monitoring. When present, it selects the
versioned contract implemented by `services/hmi-lifecycle-api`. That service is
for local acceptance and is separate from the ELI HMI EPICS gateway. Its
endpoints and payloads are not asserted to be the unresolved site contract in
`BLOCKERS.md`.

Loopback HTTP is accepted. A non-loopback URL must use HTTPS and configure
`authTokenEnv`; the named environment variable must hold a non-empty token at
startup. URLs containing credentials, query strings, or fragments are refused.
`requestTimeoutMs` and `heartbeatIntervalMs` are positive integers, defaulting
to 2000 and 5000 respectively. Tokens, process commands, argv, PIDs, process
identity values, and environments are not included in lifecycle reports.

An absent but unused key is valid. A referenced key is mandatory and fails at
load with the exact key and item id, for example:

```text
`local.workspaceRoot` is required because entry `camera-dev` uses `kind: process` in `target.command`.
```

## Entry (one GUI row)

```yaml
- id: camera-manager-alena          # unique; stable identifier used by IPC + logs
  name: Camera Manager Alena        # user-facing string (also accepts `label`)
  technology: Cameras               # string or "a; b" -> ["a","b"] (also `type`)
  section: L4b; L4c                  # string or "a; b" -> ["a","b"]
  platform: LabVIEW                  # single string (also `guiType`); e.g. LabVIEW/Phoebus/Web/CSS
  rmc: RMC403                        # arbitrary string; "" or "--" render as "--"
  note: Cam XYZ, Cam ABC             # arbitrary string
  access: { … }                      # optional per-item launch-policy override
  target: { … }                      # required; see "Targets"
```

Field semantics:

- **technology** = domain/function (Vacuum, Cameras, Timing, Pointing, Laser).
- **platform** = implementation/runtime (LabVIEW, Phoebus, Web, CSS). The split
  is intentional; platform is shown as a table column but is **not** a filter.
- **Filtering is by Technology and Section only.** **technology** and
  **section** accept either a plain string or a semicolon-separated string
  (`"L4b; L4c"`), or a YAML list (`[L4b, L4c]`). All three parse to a list; the
  list feeds the two filter dropdowns. Empty / `--` becomes an empty list.
- **search** matches **name** and **note** only.

## Targets

Every entry/action has exactly one `target`. Six kinds are currently accepted:

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
- Detached and unref'd (the GUI keeps running if the launcher closes). Launch
  success means the OS accepted the spawn. A separate registry then compares
  PID plus process start identity; the launch result itself is not a liveness
  guarantee.
- `command`, each `args` element, `cwd`, and `env` values are variable-expanded
  (see "Variables").
- Path resolution of `command`/`cwd`: absolute paths are used as-is; a value
  with a path separator is resolved against the **config directory** (never the
  process CWD); a bare name (no separator) is left for OS PATH resolution and is
  governed by `security.allowBareCommands`.
- `.cmd`/`.bat` on Windows cannot be spawned without a shell; use
  `cmd.exe /c wrapper.cmd` (a bare `cmd.exe`, so `allowBareCommands: true`) or a
  real `.exe` wrapper.

### labview-dev

```yaml
target:
  kind: labview-dev
  iocName: '<ioc-name>'
  hostName: '<host-name>'
  iocType: '<ioc-type>'
  exeName: '<exe-name>'
```

This target represents the LabVIEW Developer HMI flow from CSI-843. Catalog
authors provide the four ticket fields; they do not write a command path. The
launcher requires `local.workspaceRoot` and `local.zoneSymbol` and constructs,
on Windows:

```text
<workspaceRoot>\Common\ELI\IOCs\<iocType>\Builds\GUI Application\<exeName>
argv = [<hostName>, <iocName>, <zoneSymbol>]
```

The executable and each argument are passed separately with `shell: false`.
The space in `GUI Application` therefore needs no manual quoting. On POSIX,
the same segments are joined with POSIX separators. A Windows drive path is not
translated to a Linux mount; it reaches the normal path-existence check and is
rejected there. The command is subject to `security.allowedCommandRoots` and
the same 500 ms process startup grace as a `process` target.

### labview-epics

```yaml
target:
  kind: labview-epics
  guiName: '<gui-name>'
  guiType: '<gui-type>'
  exeName: '<exe-name>'
```

This is the CSI-847 LabVIEW EPICS HMI flow. It also requires
`local.workspaceRoot` and `local.zoneSymbol`, but its path and argv differ from
`labview-dev`. On Windows the launcher constructs:

```text
<workspaceRoot>\Common\ELI\EPICS_GUIs\<guiType>\Builds\GUI Application\<exeName>
argv = [<zoneSymbol>, <guiName>]
```

The two arguments are built by a separate target-specific function; the
Developer target's host/IOC arguments are not reused. POSIX joining, allow-list
checks, path-existence checks, `shell: false`, and startup-grace semantics are
the same as `labview-dev`.

### phoebus

```yaml
target:
  kind: phoebus
  resource: panels/main.bob                # optional for a server-only action
  app: '<name-returned-by-phoebus-list>'   # optional; requires resource
  layout: false                            # true uses local.phoebus.layoutFile
```

This target requires `local.phoebus.executable` and
`local.phoebus.serverPort`. Each launch has two phases:

```text
ensure server:  <executable> -server <port> [-settings <file>]
open resource:  <executable> -server <port> -resource <resource>
```

`local.phoebus.settingsFile`, when configured, is passed only on the invocation
that creates the server. It is not repeated on later `-resource` invocations.
Phoebus treats `-settings` as a settings import rather than a persistent
per-resource option.

A relative `resource` is joined to `local.cssGuiRoot`. Absolute filesystem paths
and HTTP(S) resources are accepted directly. Other URI schemes are rejected.
The optional `app` field adds or replaces the resource's `app` query parameter;
obtain the real internal name from the site's `phoebus -list` output. Do not
copy shell quote characters into either field: each value is one argv element,
so spaces and `&` do not require manual quoting.

The launcher probes TCP `127.0.0.1:<port>` before starting a server, tracks the
PID when it starts one, and serializes concurrent ensure requests per port. A
listener already present is reused. A listener with no launcher-owned live PID
is classified as external rather than assumed to be the launcher's process.
If both the listener and owned process disappear, the next launch starts a new
server. If the process is still alive but the listener is absent, a second
server is refused and the error distinguishes that state.

The TCP probe establishes service liveness, not application identity: another
program could occupy the configured port. The site must reserve the port and
confirm that `4918` is not merely a ticket example. Server startup is bounded by
`local.phoebus.startupTimeoutMs` (default 30000 ms). Arguments are always an
argv array; shell quoting must not be copied into YAML values.

When `layout: true`, `local.phoebus.layoutFile` becomes mandatory and the
server-creating argv includes `-layout <file.memento>`. The option is
startup-only. If a server already owns the configured port, the launcher
refuses the layout request rather than claiming that the existing server loaded
it. No memento is bundled: a human must arrange the three alarm panels in the
site Phoebus build and save the layout. Three sequential `-resource` calls are
not an acceptable layout substitute because they cannot control placement,
sizing, or focus. **Fallback assessment confidence: high.** Execution against a
Phoebus build is unavailable on this host.

### folder

```yaml
target:
  kind: folder
  path: /mnt/l4-shared         # local dir or, on Windows, a UNC path '\\host\share'
```

Opened via Electron `shell.openPath`. A missing/unmounted path returns a clear
error surfaced in the UI and the launch log.

## Runtime state column

The main process owns a session-local runtime registry and publishes snapshots
to the renderer over IPC. The column uses deliberately different observation
models:

- `RUNNING` / `STOPPED` for launcher-owned process targets. A process is called
  running only while both its PID and start identity match. A live PID without
  a start identity is `UNKNOWN`; this avoids treating a reused PID as the
  original GUI.
- `SHARED` for a reachable Phoebus server port. One server can host several
  panels, so this state does not assert that a particular panel is open.
- `HANDOFF` for browser and folder launches. Electron handed the request to an
  external application; the launcher does not own the browser tab or file
  manager window.
- `STALE` when scheduled reconciliation is delayed beyond twice
  `local.monitoring.reconcileIntervalMs`.

On Linux, process start identity comes from `/proc/<pid>/stat` plus the boot id.
The Windows inspector uses PowerShell `Get-Process` start time, but that path has
not been executed in this Linux environment. Registry state is not persisted
across launcher restarts.

## Launch access policies

Launch restrictions are evaluated in the Electron main process immediately
before a target is launched. The renderer receives neither the resolved policy
nor authority to bypass it. Configuration has two override levels:

```yaml
access:
  platforms:
    LabVIEW:
      maxInstances: 1
      writeModeExclusive: true
      launchMode: unknown
      onAlreadyRunning: block
      onUnknownState: block

entries:
  - id: approved-read-view
    name: Approved read view
    platform: LabVIEW
    access:
      maxInstances: null
      writeModeExclusive: true
      launchMode: read
      onAlreadyRunning: block
      onUnknownState: block
    target: { kind: process, command: /opt/eli/l4-launchers/read-view }
```

Resolution order is deterministic: built-in defaults, then a case-insensitive
`access.platforms.<platform>` policy, then the entry/action's own `access`
mapping. A later level replaces only the fields it supplies.

| Field | Meaning |
|---|---|
| `maxInstances` | Positive integer limiting launcher-observed running instances. In an override, `null` explicitly removes an inherited limit. |
| `writeModeExclusive` | When true, at most one observed write-mode instance is allowed. Read-mode launches may coexist unless `maxInstances` also limits them. |
| `launchMode` | Requested mode for this catalog item: `read`, `write`, or `unknown`. Use separate entries when one executable has distinct read/write launch forms. |
| `onAlreadyRunning` | `block`, `prompt`, or `focus`. `prompt` uses a main-process confirmation and logs the decision. `focus` refuses with a precise error unless a native focus implementation supplies a window identity; it never reports a fabricated focus. |
| `onUnknownState` | `block` (default fail-closed) or `allow`. `allow` is a trusted-config override for stale/unobservable state, not a renderer control. |

Generic targets have no instance limit and `writeModeExclusive: false` unless a
policy is configured. A typed LabVIEW target, or any entry whose `platform` is
`LabVIEW`, defaults to the unresolved requirement's more restrictive reading:
`maxInstances: 1`, `writeModeExclusive: true`, `launchMode: unknown`, and both
actions set to `block`. This permits the first launch and blocks another
launcher-observed instance without guessing how write mode is encoded.

Policy state is session-local. It detects launcher-owned process identities but
cannot discover an HMI started elsewhere or before this launcher session. The
HMI Python API source/contract and the definition of LabVIEW write mode remain
blockers in `BLOCKERS.md`; therefore these rules are not a site-wide singleton
guarantee. A per-entry gate serializes policy evaluation plus launch so two
rapid clicks cannot both pass before the first process is registered.

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
`path`, LabVIEW typed-target fields, and `security.allowedCommandRoots`. Both
`${NAME}` and `%NAME%` forms are accepted.

| Variable        | Value                                                             |
|-----------------|-------------------------------------------------------------------|
| `${APP_ROOT}`   | Application root (dev: project dir; packaged: app path)           |
| `${CONFIG_DIR}` | Directory containing the active YAML config                       |
| `${HOME}`       | `HOME`                                                            |
| `${USERPROFILE}`| `USERPROFILE`                                                    |
| `${TEMP}` / `${TMP}` / `${TMPDIR}` | OS temp dir (first of TEMP/TMP/TMPDIR set) |
| `${ANY_ENV}`    | Any environment variable by name                                  |
| `${local.workspaceRoot}` | Machine LabVIEW workspace root                          |
| `${local.cssGuiRoot}` | Machine CSS/Phoebus GUI root                               |
| `${local.zoneSymbol}` | Site zone symbol                                             |
| `${local.phoebus.executable}` | Phoebus launcher executable                         |
| `${local.phoebus.serverPort}` | Phoebus instance-server port                        |
| `${local.phoebus.settingsFile}` | Optional Phoebus settings import file             |
| `${local.phoebus.layoutFile}` | Optional site-created Phoebus layout memento          |
| `${local.hosts.<name>}` | Named IOC host/IP from `local.hosts`                        |
| `${local.hmiApi.baseUrl}` | HMI REST API base URL                                    |
| `${local.hmiApi.stationId}` | Optional lifecycle station identifier                 |
| `${local.hmiApi.authTokenEnv}` | Environment-variable name containing the token     |
| `${local.hmiApi.requestTimeoutMs}` | Lifecycle request timeout in ms                 |
| `${local.hmiApi.heartbeatIntervalMs}` | Lifecycle heartbeat interval in ms           |
| `${local.monitoring.reconcileIntervalMs}` | Local runtime reconciliation interval in ms |

## Validation performed at load

- YAML parses to a mapping (clear error otherwise).
- Each target has a supported `kind`; `web` has a valid HTTP(S) `url`; `process`
  has a `command`; `folder` has a `path`.
- Web URLs are protocol- and format-checked eagerly.
- Every `${local.…}` reference resolves to a configured non-empty value; errors
  name the key, item id, target kind, and field.
- `local.phoebus.serverPort`, when supplied, is in the valid TCP port range.
- `local.monitoring.reconcileIntervalMs`, when supplied, is a positive integer.
- Lifecycle request/heartbeat durations, when supplied, are positive integers;
  endpoint transport and credential rules are checked when Electron starts.
- Access-policy enums and positive instance limits are validated with the
  platform or item key named in the error.
- All ids are unique across entries + quickActions + moreActions.
- On POSIX, the config file is not world-writable (unless overridden).

Command allow-listing and filesystem checks are enforced **at launch** because
they are platform/runtime specific. Command paths must resolve to files (and be
executable on POSIX), `cwd` must be a directory, and folder targets must be
readable directories. A process that exits non-zero during the 500 ms startup
window is also reported as a launch failure. Every outcome is written to the
launch log.
