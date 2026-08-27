# Local acceptance infrastructure

This directory contains executable local contracts and fixtures used to exercise integration behavior that unit tests cannot prove by inspection alone.

- `config/`: acceptance-only launcher/Phoebus configuration.
- `assets/`: local Phoebus resources/layout fixtures.
- `phoebus/`: pinned local Phoebus wrapper/bootstrap/self-test infrastructure.
- `drive-electron.ts` / `run.sh`: acceptance driver.

Nothing here defines TESTZ production values. Deployment material belongs under `deployment/TESTZ/`.
