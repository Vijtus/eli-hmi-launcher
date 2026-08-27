# ELI HMI Launcher

ELI HMI Launcher is a small Electron desktop application for finding and launching configured control-system HMIs. It presents a searchable table, applies launch policy in the Electron main process, starts native/LabVIEW/Phoebus targets, hands web/folder targets to the operating system, and reports observed runtime state.

The product name is fixed. Deployment identity is configuration data (`siteName`) and deployment-specific material lives outside the generic application tree.

## Platforms

The application is built and tested on Windows, macOS, and Linux. Packaging targets include Windows NSIS/portable/zip, macOS dmg/zip, and Linux AppImage/deb/rpm/tar.gz. Platform-specific process behavior is covered by the cross-platform CI matrix.

## Development

Requires Node.js 20.19 or newer.

```sh
npm ci
npm start
```

Common checks:

```sh
npm test
npm run typecheck
npm run verify
npm run validate-config -- config/launcher.yaml
```

Build the Electron bundles with `npm run build`. Build an unpacked application with `npm run pack`, or installers for the current platform with `npm run dist`. Platform-specific installer scripts are `dist:win`, `dist:mac`, and `dist:linux`.

## Configuration

The launcher reads one local `launcher.yaml`. That file is the trust root: it owns security and access policy and may also contain a local catalog. The active file can be selected with `ELI_LAUNCHER_CONFIG`; otherwise the application checks the per-user configuration location and packaged/development defaults.

Operational catalog/site data can additionally come from the Git-backed config repository. Host and zone files may supply local machine values, site identity, actions, and catalog entries, but they cannot change local `security` or `access` policy. An ordered filesystem `catalog.sources` mechanism remains supported for deployments that distribute catalogs as files rather than through Git.

See [docs/configuration.md](docs/configuration.md) for the authoritative schema and source precedence. The minimal runnable example is [config/launcher.yaml](config/launcher.yaml); [examples/launcher.full.yaml](examples/launcher.full.yaml) shows the supported generic options.

Windows `.bat` and `.cmd` targets should be configured as the script itself. The launcher validates the script path against command policy and, on Windows, invokes it through `cmd.exe /c` internally. Do not rewrite batch targets as a bare `cmd.exe` command merely to make them launchable.

## Architecture

The main process is organized by responsibility:

```text
src/main/
  index.ts          Electron composition and application lifecycle
  config/           local configuration loading and trust policy
  catalog/          Git/host/zone catalog resolution
  launch/           launch policy, target materialization, execution
  runtime/          process identity and observed runtime state
  diagnostics/      logs, preflight checks, reports, launch observation
  ipc.ts            renderer-facing IPC registration

src/preload/         minimal context-isolated bridge
src/renderer/        framework-free DOM renderer
src/shared/          shared IPC names and cross-process types
```

Detailed process boundaries and launch flow are in [docs/architecture.md](docs/architecture.md). Security properties are in [SECURITY.md](SECURITY.md). Operator failures and packaging issues are in [docs/troubleshooting.md](docs/troubleshooting.md).

## Repository boundaries

`src/`, generic `config/`, `examples/`, and the main unit tests describe the launcher product. `deployment/TESTZ/` contains TESTZ configuration, field evidence, screenshots, and historical notes. `tests/acceptance/` contains local executable contracts such as the Phoebus fixture. `tools/catalog-import/` contains catalog conversion tooling.

These boundaries are intentional: TESTZ deployment material can be extracted later without changing the generic launcher architecture.

## Shared lifecycle coordination

The launcher currently enforces instance policy from runtime state observed in the current launcher session. It does not implement the previously prototyped lifecycle REST contract because the repository contains no approved production service definition for it. The TESTZ loopback prototype is preserved only as historical evidence under `deployment/TESTZ/archive/lifecycle-prototype/`. See [ADR 0002](docs/adr/0002-lifecycle-integration.md) for the decision and its limitation.

## Diagnostics

The application writes structured launch/config events to its Electron logs directory. Portable/diagnostic runs can also produce a field report and event capture; see [docs/troubleshooting.md](docs/troubleshooting.md#diagnostics-and-field-reports).

## Releases and history

Significant user/operator-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md). TESTZ implementation history and unresolved historical deployment questions are archived under `deployment/TESTZ/archive/`; they are not product documentation.
