# Changelog

## Unreleased

### Changed

- Reorganized product, TESTZ deployment, acceptance fixtures, diagnostics, catalog tooling, and historical evidence into explicit repository boundaries.
- Reduced the Electron main entry point to composition/application wiring and introduced a single launch orchestration boundary.
- Consolidated native process, LabVIEW developer, and LabVIEW EPICS execution through one spawn/watch/runtime-registration path.
- Centralized IPC channel names and the preload renderer API type in shared code.
- Replaced the custom ARIA combobox and Pico CSS dependency with native selects, semantic launch buttons, and application-specific CSS.
- Separated immutable product identity (`ELI HMI Launcher`) from optional deployment `siteName`.
- Consolidated configuration, architecture, security, and troubleshooting documentation.
- Tightened repository-owned YAML to require explicit entry/action IDs and canonical list/field syntax instead of generated IDs and legacy aliases.
- Moved catalog intake conversion code under `tools/catalog-import/` so migration/import tooling is not part of the product shared boundary.

### Removed

- Root-config `git pull` startup behavior, which duplicated the Git-backed host/zone configuration repository and blurred the local trust boundary.
- Source-checkout `run.sh`, `run.cmd`, and `scripts/run.mjs` wrappers in favor of the npm workflow.
- Pico CSS and the custom renderer combobox implementation/tests.
- The experimental production lifecycle REST client/coordinator and `local.hmiApi` configuration. The repository has no approved site lifecycle contract; the loopback prototype is archived as TESTZ evidence.

### Fixed

- Documentation/examples now configure Windows `.bat`/`.cmd` scripts directly, matching the launcher's automatic checked `cmd.exe /c` execution path.
- Moved local Phoebus infrastructure under acceptance tests and archived the unapproved TESTZ lifecycle prototype outside the product/test architecture.

## 0.4.0 — 2026-08-27

Previous implementation history is available from version control and archived TESTZ evidence rather than duplicated here as a session-by-session diary.
