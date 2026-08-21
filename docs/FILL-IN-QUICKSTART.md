# Filling in your own catalog — quick start

One page. The full guide is [`CONFIG_HOWTO.md`](CONFIG_HOWTO.md); the
complete reference is [`CONFIG_SCHEMA.md`](CONFIG_SCHEMA.md).

## 1. Get a blank file

Start from **`config/launcher.blank.yaml`**. It is a valid, empty catalog with a
commented example of every target kind. Uncomment one, edit it, delete the rest.

## 2. Put it where the launcher looks

| | Path |
|---|---|
| Windows | `%APPDATA%\eli-hmi-launcher\launcher.yaml` |
| macOS | `~/Library/Application Support/eli-hmi-launcher/launcher.yaml` |
| Linux | `~/.config/eli-hmi-launcher/launcher.yaml` |

Paste `%APPDATA%` into the Explorer address bar to get there. This file **wins
over whatever shipped with the app**, needs no admin rights, and survives
reinstalls.

To use a file somewhere else instead, set `ELI_LAUNCHER_CONFIG` to its absolute
path — that overrides everything.

## 3. Add one block per GUI

Under `entries:`, at exactly 2 spaces of indent:

```yaml
entries:
  - id: camera-manager-alena     # unique, lowercase-with-dashes, never changes
    name: Camera Manager Alena   # shown in the table; searched
    technology: Cameras          # Technology filter — reuse existing spellings
    section: L4b; L4c            # Section filter — several: separate with ;
    platform: LabVIEW            # display only
    rmc: RMC403                  # or --
    note: Cam XYZ, Cam ABC       # searched too; or --
    target:
      kind: process
      command: C:\ELI\approved-launchers\camera-manager.exe
```

**Spaces, never tabs.** Only `name` and `note` are searched, so put the words
people will actually type into one of those two.

## 4. Check it before you deploy it

```sh
npm run validate-config -- <path to your file>
```

Exits 0 and prints a summary when valid; exits 1 and names the file, the entry
and the problem when not. Run this every time — it catches every mistake below.

## 5. The four that bite everyone

- **Tabs instead of spaces.** YAML rejects tabs outright.
- **Duplicate `id`.** Must be unique across the whole file.
- **A Windows `.bat`/`.cmd` as `command`.** Windows cannot start those directly.
  Use `command: cmd.exe` with `args: ["/c", "C:\\path\\to\\script.cmd"]`, which
  needs `allowBareCommands: true` or `cmd.exe`'s absolute path.
- **`security.allowedCommandRoots` doesn't cover your program.** The launch is
  refused even though the file exists. Add its directory, or leave the list
  empty while you are still drafting.

## 6. Entries that need `local:` values

Some target kinds build their path from machine-wide settings, so those must be
filled in or the file will not load:

| Target kind | Requires |
|---|---|
| `labview-dev`, `labview-epics` | `local.workspaceRoot`, `local.zoneSymbol` |
| `phoebus` | `local.cssGuiRoot`, `local.phoebus.installRoot` |
| `process`, `web`, `folder` | nothing |

Set them once at the top of the file rather than repeating them per entry, and
refer to them as `${local.workspaceRoot}` where you need the value inline.

## 7. See what a machine can actually run

The **portable** build writes a report next to itself listing every entry it
could and could not launch, and why. See
[`INSTALL.md`](INSTALL.md#diagnosing-a-machine-portable-build).
