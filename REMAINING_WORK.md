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

## Assumptions made in this iteration

1. **Platform vs Technology** are distinct axes (domain vs runtime). Kept both
   from 0.1.0; confidence high — conflating them would rot the filters.
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
- **Fire-and-forget launches.** "Success" = the OS accepted the spawn, not that
  the GUI stayed up. Running-state detection is explicitly v1-out-of-scope.
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
4. Optional: add a lightweight automated test target (the validation exercised
   here can be scripted into `npm test`).
5. Backlog (only if requested): LabVIEW running-state detection, in-app config
   editing, packaging/auto-update.
