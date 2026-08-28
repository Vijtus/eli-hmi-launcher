# Troubleshooting

## Configuration does not load

The startup error window reports the active path when it was resolved and the validation failure. Validate the file without starting Electron:

```sh
npm run validate-config -- /path/to/launcher.yaml
```

If no file is found, set `ELI_LAUNCHER_CONFIG` to an absolute path or install `launcher.yaml` in the normal per-user/application location. See [configuration.md](configuration.md#root-config-discovery).

A missing `local.*` value is reported only when an entry/target actually requires it. Fix the named value rather than adding unrelated machine settings.

## A native launch is refused

Distinguish policy refusal from an operating-system launch failure.

- **Outside `allowedCommandRoots`**: add the intended executable/wrapper root to the local trust policy or correct the configured command path.
- **Bare command refused**: use an explicit path or deliberately change `allowBareCommands` in the local trust root.
- **Command missing/not executable**: inspect the resolved command in the launch error/log and verify installation/permissions.
- **Working directory missing**: correct `cwd` or the relevant local path.

Do not work around a policy failure by switching the command to a general shell/interpreter.

## Windows `.bat` / `.cmd`

Configure the batch script directly:

```yaml
target:
  kind: process
  command: 'C:\ELI\launchers\camera.cmd'
```

The launcher detects batch files and safely routes them through `cmd.exe /c` after checking the script path against command policy. Old configurations that manually use `command: cmd.exe` merely to launch a batch file should be migrated; otherwise the policy is checking the interpreter rather than the actual script.

## Git config repository

The launcher logs whether the operational config repository was resolved fresh or from cache, together with host/zone provenance.

Check:

- `ELI_LAUNCHER_CONFIG_REPO_URL` or `ELI_LAUNCHER_CONFIG_REPO_DIR`;
- read-only token/username environment variables when the remote requires authentication;
- selected ref/subpath;
- hostname resolution (`ELI_LAUNCHER_CONFIG_HOSTNAME` can override it for diagnosis);
- fetch timeout;
- cached checkout availability when offline.

`ELI_LAUNCHER_CONFIG_OFFLINE=1` forbids refresh and requires usable cached/local content. Network errors must not expose credentials; report a redaction failure as a security defect.

## Filesystem catalog source is stale

`catalog.sources` caches the most recent successful source. If a mounted path/UNC share becomes unavailable, the UI can continue with cached content and marks the catalog stale. Inspect the source status and path, restore the share, then restart to obtain fresh data.

If no cache exists, the unavailable source is skipped and a warning is logged.

## Phoebus

Verify `local.phoebus.installRoot` or `local.phoebus.executable`, `serverPort`, and any settings/layout/resource paths. An install root is a directory; an explicit executable is a file.

A missing executable is different from a server-listener timeout. The former means the configured launcher cannot be started; the latter means the process started but the expected Phoebus server did not become reachable within `startupTimeoutMs`.

`resourceReadyDelayMs` exists for builds where the TCP listener is observed before the resource handler is ready. Leave it unset unless deployment evidence demonstrates that startup gap.

Acceptance-only Phoebus scripts and assets are under `tests/acceptance/phoebus/` and `tests/acceptance/assets/`; they are not deployment content.

## Runtime state looks wrong

Launcher-owned processes are tracked by PID plus process start identity to avoid PID-reuse errors. Phoebus is reported as shared server state rather than per-panel process ownership. Web/folder targets are external handoffs and cannot be monitored as owned windows.

Runtime state is session-local. A process started before this launcher session or by another launcher may therefore be unknown to instance policy. This is a known architectural limitation, not a connectivity failure; see [ADR 0002](adr/0002-lifecycle-integration.md).

## Diagnostics and field reports

Structured logs are written to Electron's logs directory as `launcher.log.jsonl`.

Diagnostic/portable runs can additionally create a Markdown field report and event capture. Set:

- `ELI_LAUNCHER_FIELD_REPORT=1` to enable report generation;
- `ELI_LAUNCHER_FIELD_REPORT_DIR=<directory>` to choose its destination.

Preflight checks resolve commands/paths and classify launchability without starting every configured GUI. Field reports should be treated as operational evidence, not product documentation; TESTZ examples live under `deployment/TESTZ/field-reports/`.

## Linux Electron sandbox

Source checkouts or unpackaged archives can fail if Electron's `chrome-sandbox` helper lacks the required ownership/mode. Packaged deb/rpm installations normally handle this. For development-only diagnosis, either configure the helper correctly for the installed Electron distribution or run in an isolated test environment with the sandbox override understood as a temporary development workaround.

## Headless/SSH sessions

Electron requires a display server. CI uses a virtual display on Linux for packaged smoke tests. For a headless local check, use an equivalent Xvfb setup rather than interpreting “window did not appear” as a launcher/config failure.

## Unsigned release artifacts

Current packaging configuration produces unsigned macOS/Windows artifacts. SmartScreen/Gatekeeper warnings are therefore expected for locally built/released unsigned packages. Signing/notarization is a release-process concern; do not disable runtime security controls in application code to suppress OS trust warnings.
