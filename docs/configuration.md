# Configuration

This is the authoritative configuration reference for ELI HMI Launcher. Generic runnable examples are [../config/launcher.yaml](../config/launcher.yaml) and [../examples/launcher.full.yaml](../examples/launcher.full.yaml).

Validate a file without starting Electron:

```sh
npm run validate-config -- path/to/launcher.yaml
```

## Root config discovery

`ELI_LAUNCHER_CONFIG` selects an explicit root file. Without it, the Electron application checks the per-user configuration location and packaged/development candidates produced by `src/main/config/paths.ts`. Packaged execution does not rely on an arbitrary current working directory; development includes the repository `config/launcher.yaml` path.

The root file is the local trust root. Remote operational configuration does not replace its `security` or `access` policy.

## Top-level schema

Canonical fields:

```yaml
siteName: TESTZ                 # optional deployment/site identity
local:                          # optional machine-specific values
  workspaceRoot: 'C:\ELI\Workspace'
  cssGuiRoot: 'C:\ELI\CSS_GUIs'
  zoneSymbol: TESTZ
  phoebus: {}
  hosts: {}
  monitoring: {}

catalog:
  sources: []                   # optional entry-only filesystem catalogs

access:
  platforms: {}                 # optional main-process launch restrictions

security:
  allowedCommandRoots: []
  allowBareCommands: false
  allowInsecureConfigPermissions: false

entries: []
quickActions: []
moreActions: []
```

The application product name is fixed as `ELI HMI Launcher`; configuration does not rename the software. `siteName` is rendered separately. The obsolete `appName` field is rejected; use `siteName` for deployment identity.

IDs share one namespace across entries and actions and must be unique. Entry/action `id` values are required and must be stable.

## Entries

```yaml
entries:
  - id: camera-manager
    name: Camera Manager
    technology:
      - Cameras
    section:
      - L4b
      - L4c
    platform: LabVIEW
    rmc: RMC403
    note: Main camera control
    target:
      kind: process
      command: 'C:\ELI\launchers\camera.cmd'
```

`technology` and `section` accept a single string or a YAML list. Multi-value fields must use a YAML list; semicolon-separated strings are rejected. Entry `id` and `name` are required, and the old root `rows` alias is no longer accepted.

`platform`, `rmc`, and `note` are display/policy metadata. `target` defines what launch operation is performed.

## Actions

`quickActions` and `moreActions` use the same target grammar:

```yaml
quickActions:
  - id: data-browser
    label: Data Browser
    target:
      kind: web
      url: https://example.invalid/data
```

The Git host/zone `launcher:` block may replace `siteName`, `quickActions`, or `moreActions`. It cannot change local security/access policy.

## Target: process

```yaml
target:
  kind: process
  command: /opt/eli/launchers/camera
  args:
    - --mode
    - operator
  cwd: /opt/eli
  env:
    CAMERA_MODE: operator
  windows:
    command: 'C:\ELI\launchers\camera.cmd'
  linux:
    command: /opt/eli/launchers/camera
```

Platform overrides (`windows`, `linux`, `darwin`) replace only supplied process fields. The materialized command uses `shell: false` and argv elements are not joined into a shell command.

On Windows, configure `.bat` and `.cmd` files directly. The launcher recognizes them after policy validation and internally uses a quoted `cmd.exe /c` invocation. Manual `command: cmd.exe` wrappers are obsolete for this purpose and can unnecessarily require `allowBareCommands`.

## Target: LabVIEW developer

```yaml
target:
  kind: labview-dev
  iocName: Camera Manager
  hostName: RMC00-001
  iocType: Camera Manager
  exeName: Camera Manager.exe
```

This typed target derives the executable/argv from `local.workspaceRoot` and `local.zoneSymbol`. Its argument ordering is intentionally different from the EPICS target and is tested independently. The resulting process runs through the shared native execution path.

## Target: LabVIEW EPICS

```yaml
target:
  kind: labview-epics
  guiName: Camera Panel
  guiType: Camera
  exeName: Camera.exe
```

This target also derives its executable/argv from the local workspace/zone settings and then uses the shared native process execution path.

## Target: Phoebus

```yaml
target:
  kind: phoebus
  resource: panels/overview.bob   # optional
  app: display_runtime           # optional, requires resource
  layout: false                  # optional startup layout request
```

Machine settings:

```yaml
local:
  cssGuiRoot: 'C:\ELI\css-gui'
  phoebus:
    installRoot: 'C:\CSS Phoebus\product-5.0.2'
    # executable: 'C:\CSS Phoebus\product-5.0.2\phoebus.bat'
    serverPort: 4918
    settingsFile: 'C:\ELI\css-gui\settings.properties'
    layoutFile: 'C:\ELI\css-gui\alarm-layout.memento'
    startupTimeoutMs: 30000
    resourceReadyDelayMs: 8000
```

`installRoot` is a directory; `executable` is a file and wins when explicitly set. Without an explicit executable the install root is probed for the platform launcher.

`resourceReadyDelayMs` should remain unset unless a deployed Phoebus build has demonstrated a listener/resource startup gap.

## Target: web

```yaml
target:
  kind: web
  url: https://example.invalid/status
```

Only HTTP(S) URLs are accepted. They are opened with Electron `shell.openExternal`.

## Target: folder

```yaml
target:
  kind: folder
  path: '\\server\share\controls'
```

The path is resolved/validated and handed to Electron `shell.openPath`.

## Local machine settings

All local keys are optional until a configured target references them.

```yaml
local:
  workspaceRoot: 'C:\Workspaces\TESTZ'
  cssGuiRoot: 'C:\Workspaces\css-gui'
  zoneSymbol: TESTZ
  hosts:
    diagnostics: 127.0.0.1
  monitoring:
    reconcileIntervalMs: 5000
```

## Access policy

Policy is evaluated in the main process immediately before launch.

```yaml
access:
  platforms:
    LabVIEW:
      maxInstances: 1
      writeModeExclusive: true
      launchMode: unknown
      onAlreadyRunning: block
      onUnknownState: block
```

An entry/action can override fields with its own `access:` mapping. Resolution is built-in defaults, platform override, then item override.

Fields:

- `maxInstances`: positive integer; `null` in an override removes an inherited limit.
- `writeModeExclusive`: prevent a second observed write-mode instance.
- `launchMode`: `read`, `write`, or `unknown`.
- `onAlreadyRunning`: `block`, `prompt`, or `focus`. `focus` fails unless a real native window identity/focus implementation exists; it does not fabricate success.
- `onUnknownState`: `block` or `allow`.

Typed LabVIEW entries default to conservative single-instance/write-exclusive policy unless overridden. Policy uses runtime state observed by the current launcher session. It cannot discover an HMI started before this session or by another launcher; see [ADR 0002](adr/0002-lifecycle-integration.md).

## Security

```yaml
security:
  allowedCommandRoots:
    - /opt/eli/launchers
    - ${APP_ROOT}/examples/launchers
  allowBareCommands: false
  allowInsecureConfigPermissions: false
```

`allowedCommandRoots` applies to the resolved executable/script path. Filesystem resolution follows symlinks before comparing roots. Empty roots mean no directory restriction and trigger a startup warning.

`allowBareCommands: false` rejects pathless commands such as `python` or `cmd.exe`. This does not prevent allow-listed Windows batch scripts: the batch script remains the configured/policy-checked command and `cmd.exe` is introduced only after validation as a platform execution detail.

On POSIX systems, world-writable root configuration is rejected unless `allowInsecureConfigPermissions` is explicitly enabled.

See [../SECURITY.md](../SECURITY.md) for the trust model.

## Filesystem catalog sources

```yaml
catalog:
  sources:
    - id: shared
      path: '\\server\share\launcher-catalog.yaml'
    - id: local-override
      path: '${CONFIG_DIR}/machine-catalog.yaml'
```

A catalog file contains `entries:`. Inline root entries are lowest precedence; external sources apply in listed order. Later sources replace duplicate IDs from earlier sources, while duplicate IDs inside one source are rejected.

Successful sources are cached. If a source later becomes unreadable/unparseable, its cached copy can be used and is reported stale. With no usable cache, that source is skipped and a warning is surfaced.

Actions/security/access are not imported from filesystem catalog files.

## Git-backed host/zone configuration

Preferred centralized layout:

```text
launcher/
  host/<HOST>.yaml
  zone/<ZONE>.yaml
```

The host file selects `zone:` and can map deployment keys into local values. The zone provides base local settings and grouped HMI entries. Zone values are the base; host values override them. Host/zone `launcher:` settings can supply `siteName` and action lists.

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `ELI_LAUNCHER_CONFIG_REPO_URL` | Git remote URL |
| `ELI_LAUNCHER_CONFIG_REPO_TOKEN` | read credential/token |
| `ELI_LAUNCHER_CONFIG_REPO_USERNAME` | optional auth username |
| `ELI_LAUNCHER_CONFIG_REPO_REF` | branch/tag/ref |
| `ELI_LAUNCHER_CONFIG_REPO_SUBPATH` | config root in repo; default `launcher` |
| `ELI_LAUNCHER_CONFIG_CACHE_DIR` | checkout/cache directory |
| `ELI_LAUNCHER_CONFIG_HOSTNAME` | hostname override for diagnosis/testing |
| `ELI_LAUNCHER_CONFIG_REPO_DIR` | already-checked-out local tree; no Git network operation |
| `ELI_LAUNCHER_CONFIG_FETCH_TIMEOUT_MS` | bounded network timeout; default 10000 ms |
| `ELI_LAUNCHER_CONFIG_OFFLINE` | use local/cached content without refresh |

A bundled `config-repo/launcher` tree can supply an offline snapshot when present. The tracked repository contains only instructions; private deployment content is intentionally excluded.

Entry precedence is inline root, filesystem `catalog.sources` in order, then Git zone entries. Git content therefore controls operational catalog values when enabled, but still cannot alter root `security`/`access`.

See [adr/0001-catalog-distribution.md](adr/0001-catalog-distribution.md).

## Canonical config-repo zone keys

The zone adapter uses the repository's kebab-case schema. New data should use these names:

- `labview-dev`: `ioc-name`, `host`, `ioc-type`, `exe`.
- `labview-epics`: `gui-name`, `gui-type`, `exe`.
- `css`: `name`, plus `resource`, optional `app`, or `layout: true`/`bare: true` as applicable.
- `web`: `name`, `url`.

Common row metadata may include `id`, `technology`, `section`, `platform`, `rmc`, and `note`.

## Variables and paths

Configuration strings support `${NAME}` and `%NAME%` environment forms plus application/local values. Important variables include:

- `${APP_ROOT}`: development project root or packaged resource/application root.
- `${CONFIG_DIR}`: active root config directory.
- `${HOME}`, `${USERPROFILE}`, `${TEMP}`, `${TMP}`, `${TMPDIR}`.
- arbitrary environment variables by name.
- `${local.workspaceRoot}`, `${local.cssGuiRoot}`, `${local.zoneSymbol}`.
- `${local.phoebus.*}`, `${local.hosts.<name>}`, `${local.monitoring.reconcileIntervalMs}`.

Relative filesystem paths are resolved against the configuration directory where applicable. Packaged resources that must be spawned are placed outside `app.asar`.

## Validation boundaries

Validation is intentionally strongest where data enters from YAML, environment, filesystem, network/repositories, or renderer IPC. After normalization, internal code relies on typed structures rather than repeatedly rechecking its own values.

At load the launcher validates YAML shape, target kinds/required fields, URL schemes, local variable references, numeric ranges, access policy values, and ID uniqueness. At launch it performs current-platform command allow-listing, path/symlink checks, executable/directory checks, and process startup observation.
