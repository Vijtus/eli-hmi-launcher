# Remaining work & assumptions

## Blocked on real L4 input (cannot proceed without control-system maintainers)

No real ELI paths, hosts, or GUI names were invented. The following must be
supplied by L4 users / control-system maintainers before this leaves mock mode:

- Complete list of current L4 **LabVIEW** GUIs (names + how each is launched).
- Exact **wrapper scripts or commands** for each LabVIEW GUI.
- Exact **Phoebus** launch commands.
- Exact **Data Browser** launch command.
- Exact **Alarm System** layout launch command.
- Real **web GUI** URLs (currently `https://example.local/…`).
- Real **Sequencer** target (URL or command).
- Real **Safety Diagnostics** target (URL or command).
- Real **Network Shared Folder** path (POSIX mount or Windows UNC).
- Final **Technology**, **Section**, **RMC**, and **Note** values.

Once supplied, populate `config/launcher.example-real.yaml`, deploy it read-only,
and run `npm run validate-config -- config/launcher.example-real.yaml`.

To collect the data at scale, hand `intake/L4_GUI_INTAKE.csv` to GUI owners and
convert completed sheets with `npm run intake-to-yaml -- <csv> -o converted.yaml`
(then validate and merge). The workflow and template exist; the **real values**
remain the external blocker.

**Logo:** the header uses a text wordmark (`L4 LAUNCHER`). No official ELI/L4
image asset was supplied, and none was invented. If maintainers provide one,
replace the `<h1>` wordmark in `src/renderer/index.html` with the image and
preserve its aspect ratio; otherwise the text wordmark stays.

## Assumptions made in this iteration

1. **Platform vs Technology** are distinct axes (domain vs runtime). Both are
   kept as data/columns; since 0.3.0 only Technology and Section are filters
   (per user feedback) and Platform is display-only. Conflating the axes in the
   data model would still rot it, so both fields stay.
2. **RMC is optional**; empty renders as `--`. Confidence high.
3. `technology`/`section` remain semicolon-or-list. YAML lists (`[L4b, L4c]`) are
   also accepted and are the cleaner form; the semicolon string is retained for
   editor familiarity. If maintainers prefer, standardise on lists.
4. **Deployment is POSIX-first** for the strict security example. The default
   `launcher.yaml` runs on Linux and Windows; the strict `example-real.yaml`
   uses `.sh` wrappers + `allowBareCommands: false`. See the Windows caveat
   below.
5. The launcher user has permission to run the configured wrappers and to reach
   the web hosts / mounts. Not verified by the app.

## Known limitations / conscious trade-offs

- **Allow-list does not constrain args.** `allowedCommandRoots` guards the
  `command` binary, not its arguments. If `command` is an interpreter
  (`sh`, `python`, `cmd.exe`) with `allowBareCommands: true`, a config author can
  still pass arbitrary code as args. For maximum lockdown, set
  `allowBareCommands: false` and make each `command` the wrapper itself (a
  direct-spawnable `.sh`/`.exe`), not an interpreter. Confidence: this is the
  correct boundary given the requirement to support LabVIEW/Phoebus via wrappers;
  fully sandboxing arbitrary wrappers is out of scope.
- **Windows + `.cmd` + `shell:false`.** A `.cmd`/`.bat` cannot be spawned without
  a shell, so it needs `cmd.exe /c wrapper.cmd` (bare `cmd.exe`,
  `allowBareCommands: true`) or a real `.exe` wrapper. The strict example is
  therefore Linux-oriented; a Windows site should choose `.exe` wrappers or the
  documented `cmd.exe` form. Not auto-resolved — deliberately left to the site.
- **Fire-and-forget after startup.** Missing executables and immediate non-zero
  exits are reported during a 500 ms startup window. After that, success means
  the OS accepted the launch; long-term GUI running-state detection remains
  explicitly v1-out-of-scope.
- **World-writable check is POSIX-only** ("where supported"); Windows ACLs are
  not inspected. Deploy Windows configs with appropriate NTFS permissions.
- **No packaging/installer.** `npm run build` produces `./out` (electron-vite),
  not a distributable installer. If a signed installer is needed, add
  `electron-builder`/`electron-forge` as a follow-up (kept out of v1 to avoid
  scope creep and platform-specific signing setup).

## Suggested next steps (in priority order)

1. Collect the real L4 data above; fill `example-real.yaml`; validate.
2. Decide Windows wrapper strategy (`.exe` vs `cmd.exe` form) and set the
   security posture accordingly.
3. Decide the config distribution mechanism (read-only deploy path, ownership,
   update process) — this is the real security control.
4. Supply the official ELI/L4 logo asset if the text wordmark should be replaced
   by an image. The current wordmark is larger and aligned, but no brand artwork
   was invented.
5. Automate the Electron smoke test in CI. It was run **manually** under
   Linux/Xvfb for this pass (app boot, filter open/keyboard nav, silent success,
   invalid-path error, narrow-width layout — see FINAL_VERIFICATION.md), but the
   automated suite still covers only pure logic (filtering, launch-path
   validation, intake conversion, combobox type-ahead) plus build and config
   validation in CI. A headless Playwright-for-Electron run would lock the UI
   behaviour in.
6. Backlog (only if requested): LabVIEW running-state detection, in-app config
   editing, packaging/auto-update.
