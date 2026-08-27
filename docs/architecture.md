# Architecture

## Process boundary

ELI HMI Launcher uses Electron's standard three-process boundary.

- **Main process** owns configuration, filesystem/network access, launch policy, process creation, runtime tracking, diagnostics, and all Electron shell operations.
- **Preload** exposes a deliberately small `LauncherApi` through `contextBridge`. It contains no business logic.
- **Renderer** renders configuration returned by the main process and sends only item IDs or explicit UI requests back over IPC. It has no Node.js access and cannot provide arbitrary commands or paths to spawn.

IPC channel names and the renderer API type are defined once in `src/shared/ipc.ts`.

## Main-process domains

`src/main/index.ts` is the composition root. It resolves configuration, starts runtime services, registers IPC, creates the BrowserWindow, and coordinates shutdown. The substantive behavior sits in these domains:

- `config/`: root YAML loading, normalization, variable/path resolution, security policy, filesystem catalogs, validation.
- `catalog/`: Git repository refresh/cache, credential redaction, hostname/zone resolution, host-to-local mapping, config-repo catalog adaptation.
- `launch/`: main-process access policy, target materialization, native/Phoebus/web/folder execution, launch error normalization.
- `runtime/`: process identity tracking and Phoebus/handoff state.
- `diagnostics/`: structured logging, preflight checks, workspace survey, launch watches, field reports.

## Configuration sources and trust

The local `launcher.yaml` is always the security trust root. It owns `security` and `access` and can contain local entries/actions/machine settings.

Two optional operational catalog mechanisms exist:

1. `catalog.sources`: ordered YAML files on local/mounted/UNC storage. They supply entries only and use a local cache when a previously successful source becomes unavailable.
2. Git-backed config repository: resolves a host and zone, maps machine values into `local`, optionally supplies `siteName`/actions, and appends zone entries at highest catalog precedence. Repository refresh is bounded and falls back to its cached checkout when configured to do so.

The Git overlay type intentionally has no `security` or `access` field. Remotely writable configuration therefore cannot relax executable policy.

The former mechanism that ran `git pull` in the directory containing the root `launcher.yaml` was removed. It duplicated repository refresh while also mixing the local trust root with remotely updated content.

See [configuration.md](configuration.md) and [adr/0001-catalog-distribution.md](adr/0001-catalog-distribution.md).

## Launch pipeline

Renderer requests carry an item ID, not an executable description. The launch boundary performs:

1. validate the IPC item ID;
2. resolve the normalized target and access policy from loaded configuration;
3. evaluate restrictions against observed session runtime state;
4. materialize the target for the current machine;
5. execute or hand off the target;
6. register process/runtime state;
7. attach launch diagnostics/watch state;
8. return a small `LaunchResult` to the renderer.

`process`, `labview-dev`, and `labview-epics` targets share one native execution path after their target-specific materialization. This keeps spawning, startup checks, diagnostics, and runtime registration consistent.

## Native process launching

Process execution uses `shell: false`. Arguments remain an argv array. Commands with paths are checked against the configured allow-list using resolved filesystem paths so a symlink cannot escape an allowed root.

Windows batch scripts are the one platform exception to direct executable spawning: Node cannot safely spawn `.bat`/`.cmd` as normal executables. The launcher therefore validates the configured script as the command, then constructs a quoted `cmd.exe /c` invocation internally. `cmd.exe` is an implementation detail, not the policy subject.

LabVIEW developer and EPICS target modules only build their documented executable/argument layouts; they do not own process lifecycle logic.

## Phoebus

Phoebus has a shared-instance model. The launcher materializes a server plan, ensures the configured local server port is usable/reachable, then optionally opens a resource. Runtime status reflects the server/listener relationship rather than pretending individual panels are processes owned by the launcher.

## Runtime

`RuntimeRegistry` tracks launcher-owned process identities, shared Phoebus state, and external handoffs. PID liveness alone is insufficient: process identity checks protect against PID reuse. Runtime knowledge is intentionally session-local; see [ADR 0002](adr/0002-lifecycle-integration.md) for why the unapproved shared lifecycle prototype is not production code.

## Diagnostics

Normal launch control flow records concise structured events. More expensive preflight/workspace/field-report behavior is isolated under `diagnostics/` and enabled by the diagnostic/portable behavior rather than embedded in target execution.

Diagnostics must redact credential-like values and never turn failures into launch permission.

## Renderer

The renderer deliberately has no framework. It uses semantic buttons for launches, native `<select>` elements for filters, a search input, and ordinary DOM updates. Native browser controls own keyboard/focus semantics instead of custom widget state.

## Shutdown

Before quitting, diagnostics get a final rewrite opportunity and runtime reconciliation stops. The app then allows Electron to quit. Cleanup failures are logged but do not silently leave the application in a half-running UI state.
