# Security

This document describes security properties implemented by ELI HMI Launcher. It is not a generic Electron hardening checklist.

## Configuration is a trust boundary

The local `launcher.yaml` can authorize native programs that run with the launcher's user privileges. Protect the file and its directory accordingly. On POSIX systems, world-writable root configuration is rejected by default.

The local file owns `security` and `access` policy. Git-backed host/zone configuration may supply operational catalog and machine values, but the overlay cannot supply either policy. Do not move executable trust policy into a repository writable by catalog publishers.

Filesystem `catalog.sources` are also untrusted input until parsed and normalized. They provide entries but do not replace the local `security` block.

## Executable policy

`security.allowedCommandRoots` restricts path-based native commands. Before launch, command paths are resolved through the filesystem and checked against resolved allowed roots. This prevents a symlink inside an allowed directory from redirecting execution outside the policy root.

`security.allowBareCommands: false` rejects commands resolved only through `PATH`. Hardened deployments should normally use explicit executable/wrapper paths.

Do not use a general interpreter such as `sh`, `python`, or PowerShell as the allowed command when an untrusted catalog can control its arguments. The allow-list protects the executable path; it does not make interpreter arguments safe.

Native targets use `shell: false` and argv arrays. The launcher does not concatenate ordinary process arguments into shell command lines.

### Windows batch files

`.bat`/`.cmd` scripts are configured as their own command paths and are checked by the same command policy. After validation, Windows execution is routed internally through a quoted `cmd.exe /c` invocation because Node cannot spawn batch files as ordinary executables. A deployment does not need to enable bare commands solely to launch an allow-listed batch script.

## Renderer/main isolation

The BrowserWindow uses `contextIsolation: true`, `nodeIntegration: false`, and Electron sandboxing. The renderer receives a narrow API from preload. Launch IPC accepts an item ID and resolves the target in the main process; the renderer cannot submit arbitrary executable paths or argv.

The renderer Content Security Policy limits content to application resources and disables object embedding. Web targets are opened by the main process through Electron's external URL handling rather than embedded as privileged renderer content.

## URL handling

Web targets must resolve to HTTP or HTTPS URLs. `javascript:`, `file:`, `data:`, protocol-relative, and malformed values are rejected before `shell.openExternal` is called.


## Credentials and tokens

Git repository credentials are supplied through environment variables and passed to `isomorphic-git` callbacks; they are not written into repository configuration. Errors/provenance are redacted before logging.

Use read-only repository credentials with the minimum scope needed for catalog retrieval.

## Remote config and cache

Network refreshes are time-bounded. Cached repository/catalog content can be used for offline operation, but stale status and provenance are surfaced so cached data is distinguishable from a fresh update.

Offline resilience does not relax local security policy: cached/remote entries are normalized through the same local trust rules before launch.

## Filesystem and packaged resources

`${APP_ROOT}` and `${CONFIG_DIR}` are resolved to explicit filesystem locations. Resources that must be spawned or inspected are packaged outside `app.asar`; code must not assume an asar path behaves like a normal executable path.

## Reporting vulnerabilities

Do not include passwords, deploy tokens, or control-network credentials in issue reports, screenshots, field reports, or example configuration. Provide the smallest reproducible configuration with secrets removed.
