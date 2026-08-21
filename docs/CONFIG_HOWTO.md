# How to add your GUIs to the L4 Launcher (YAML how-to)

This guide is for **L4 users** who want to add their control-system GUIs to the
launcher. You do not need to know the whole configuration format — you only
copy one block per GUI and fill in a few fields. The full technical reference
lives in `CONFIG_SCHEMA.md`; you should not need it for normal entries.

The launcher shows **one table row per GUI**. The whole table comes from one
YAML file. Adding a GUI = adding one block to that file.

Machine-specific paths, host addresses, the zone symbol, Phoebus executable,
settings/layout files, and lifecycle API location belong in the top-level `local:` block, not repeated in
each entry. Catalog strings may reference them as `${local.workspaceRoot}`,
`${local.cssGuiRoot}`, `${local.zoneSymbol}`, `${local.phoebus.executable}`,
or `${local.hosts.<name>}`. The validator names any referenced key that is not
configured; unused local keys may be omitted.

The optional `local.monitoring.reconcileIntervalMs` controls how often the
launcher updates the State column (default 5000 ms). `RUNNING` is reserved for
a launcher-owned PID whose process start identity still matches. `SHARED`
means a Phoebus server port is reachable, not that one panel is known open.
Browser and folder rows show `HANDOFF` because those windows are owned by other
applications.

For local multi-launcher acceptance, start `services/hmi-lifecycle-api` and use:

```yaml
local:
  hmiApi:
    baseUrl: http://127.0.0.1:8765/api/lifecycle/v1
    requestTimeoutMs: 2000
    heartbeatIntervalMs: 5000
```

This service is a local launcher-lifecycle contract, not the site EPICS gateway
or evidence of a maintainer-approved lifecycle API. If `baseUrl` is configured
but unreachable, constrained launches fail closed. The sidecar atomically
reserves singleton/write launches before spawn; a successful registration
commits the reservation, while failed launches release it.

LabVIEW rows also have a main-process launch restriction. Until maintainers
resolve whether the rule is one instance, one write-mode instance, or both,
LabVIEW entries default to one instance plus write exclusivity and fail closed
when state is stale or unknown. With the local lifecycle service configured,
the policy includes other live launcher sessions. Without it, enforcement is
session-local.

---

## 1. The block you copy for every GUI

```yaml
  - id: my-unique-id              # short, unique, lowercase-with-dashes
    name: Camera Manager Alena    # what users see and search for
    technology: Cameras           # filter dropdown 1 (see vocabulary below)
    section: L4b; L4c             # filter dropdown 2 (several: separate with ;)
    platform: LabVIEW             # shown in the table (LabVIEW / Phoebus / Web / CSS)
    rmc: RMC403                   # room/machine if relevant, otherwise --
    note: Cam XYZ, Cam ABC        # anything that helps users find/understand it
    target:                       # WHAT actually opens — pick ONE kind, see step 2
      kind: process
      command: /opt/eli/l4-launchers/open-camera-manager-alena.sh
```

Paste it under the `entries:` line of the config file, indented exactly like
the existing entries (2 spaces before the `-`). **YAML is indentation-based:
use spaces, never tabs.**

Field rules:

- **id** — must be unique across the whole file. Lowercase letters, digits,
  dashes. It never changes later (it is used in logs), so pick something
  stable: `l4-cis-vcs`, `camera-manager-alena`.
- **name** — the human name shown in the first column. **Search matches Name
  and Note only**, so put the words people will actually type in one of those
  two fields.
- **technology** — what domain the GUI belongs to. This feeds the
  **Technology** filter dropdown, so use a consistent vocabulary. Current
  values in use: `Vacuum`, `Cameras`, `Timing`, `Pointing`, `Laser`. Reuse an
  existing value if one fits; spelling variants ("vacuum", "Vacuum systems")
  create duplicate dropdown entries.
- **section** — where it belongs (`L4 CIS`, `L4fBT`, `L4b`, `L4c`, `L4`, …).
  Feeds the **Section** filter dropdown, same consistency rule. Several
  sections: `L4b; L4c` (semicolon-separated) or a YAML list `[L4b, L4c]`.
- **platform** — how the GUI is implemented (`LabVIEW`, `Phoebus`, `Web`,
  `CSS`). Informational column only; it is not a filter.
- **rmc / note** — free text. Use `--` if empty. The **note** is searchable —
  a good place for camera names, device IDs, nicknames.

---

## 2. Pick the `target` — what happens when the row is clicked

Exactly one of the six currently supported kinds:

### a) A program / script on the machine (`kind: process`)

```yaml
    target:
      kind: process
      command: /opt/eli/l4-launchers/open-my-gui.sh
```

- `command` should be the **absolute path** to the launch script/wrapper for
  your GUI (ask the control-system maintainers where wrappers live — the
  agreed location is the `security.allowedCommandRoots` directory at the top
  of the config; commands outside it are refused).
- If you do not have a wrapper script yet, write down the exact command you
  normally use to start the GUI in the `note` or in your message to the
  maintainers — they will wrap it.
- Optional extras (usually not needed):

```yaml
      args: ["--layout", "l4-overview"]     # extra command-line arguments
      cwd: /opt/eli/l4-launchers            # working directory
      env: { EPICS_CA_ADDR_LIST: "10.0.0.1" }
      windows:                              # override for Windows machines
        command: 'C:\ELI\launchers\open-my-gui.exe'
```

- **Windows paths:** put them in quotes (`'C:\...'`) so the backslashes
  survive. A `.cmd`/`.bat` script cannot be started directly; that case is for
  the maintainers (documented in CONFIG_SCHEMA.md).

### b) A LabVIEW Developer HMI (`kind: labview-dev`)

```yaml
    target:
      kind: labview-dev
      iocName: '<ioc-name>'
      hostName: '<host-name>'
      iocType: '<ioc-type>'
      exeName: '<exe-name>'
```

The root config must contain the workstation's `local.workspaceRoot` and
`local.zoneSymbol`. The launcher builds the standard
`Common/ELI/IOCs/<iocType>/Builds/GUI Application/<exeName>` path and passes
`hostName`, `iocName`, and `zoneSymbol` as three separate arguments. Do not put
quotes around fields merely because the resulting path contains spaces.

### c) A LabVIEW EPICS HMI (`kind: labview-epics`)

```yaml
    target:
      kind: labview-epics
      guiName: '<gui-name>'
      guiType: '<gui-type>'
      exeName: '<exe-name>'
```

This uses the standard
`Common/ELI/EPICS_GUIs/<guiType>/Builds/GUI Application/<exeName>` path. The
launcher passes `zoneSymbol` first and `guiName` second. This is not the same
argument list as `labview-dev`.

### d) A Phoebus server or panel (`kind: phoebus`)

```yaml
    target:
      kind: phoebus
      resource: panels/main.bob
      app: '<name-returned-by-phoebus-list>'
```

`resource` may be omitted for a server-only action. The workstation's
`local.phoebus.executable` and `local.phoebus.serverPort` must be configured.
The launcher first reuses or starts the server on that port, then invokes the
same executable with `-resource` when a resource is present. Relative resources
resolve below `local.cssGuiRoot`; absolute paths and HTTP(S) resources are also
accepted. `app` is optional and must use a name read from the site's
`phoebus -list` output. `local.phoebus.settingsFile`, when set, is imported only
on the server-creating invocation. Do not add quote characters around paths or
resources in YAML to imitate a shell command.

For the alarm layout, use a separate server-start action only after the site has
provided a saved memento:

```yaml
    target:
      kind: phoebus
      layout: true
```

This requires `local.phoebus.layoutFile`. It is a startup-only flag; the
launcher rejects the request when that port already has a server because it
cannot prove the existing instance loaded the requested layout. Opening three
resources sequentially does not preserve panel placement, size, or focus.

### e) A web page (`kind: web`)

```yaml
    target:
      kind: web
      url: https://sequencer.l4.example/status
```

Opens in the default browser. Only `http://` / `https://` URLs are accepted —
anything else is rejected when the launcher starts.

### f) A folder (`kind: folder`)

```yaml
    target:
      kind: folder
      path: /mnt/l4-shared          # or a Windows share: '\\server\l4-share'
```

Opens in the file manager.

If the command/URL/folder is wrong or missing, nothing silently happens: the
launcher shows a monochrome error banner with the reason (e.g. *"Configured command
does not exist: …"*, *"Folder does not exist or is not reachable: …"*) and the
attempt is written to the launch log.

## Access restrictions (maintainer-owned)

Ordinary catalog contributors should leave `access` unchanged unless the
LabVIEW owner has supplied an approved policy and a concrete read/write launch
mode. Maintainers can set a platform policy once:

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

An individual entry may override those fields. `maxInstances: null` deliberately
removes an inherited instance limit, which is how a policy allowing several
read-only copies but only one writer is represented. Do not change
`launchMode: unknown` to `read` or `write` until the control-system maintainers
define what actually selects write mode. `onUnknownState: allow` weakens the
fail-closed default and belongs only in a reviewed, read-only deployment config.
`onAlreadyRunning: prompt` asks in the main process and logs the operator's
decision. `focus` is not a silent no-op: without a native window identity it
returns an explicit error.

---

## 3. Check your file before sending it

If you have the repository and Node.js installed:

```sh
npm run validate-config -- path/to/your/launcher.yaml
```

This runs the **same parser as the launcher** and prints either a summary
(number of entries, actions) or the exact problem ("Entry 'X' has a process
target without command", "Duplicate launcher id 'y'", "line 42: bad
indentation", …). Fix and re-run until it passes.

No Node.js? Paste the file into any online YAML validator to at least catch
indentation/syntax mistakes, and the launcher itself will show a detailed
error window on startup if something is still wrong.

## 4. Common mistakes (all caught, but save yourself the round-trip)

| Mistake | Symptom |
|---|---|
| Tabs instead of spaces | YAML parse error with a line number |
| Two entries with the same `id` | "Duplicate launcher id '…'" at startup |
| Windows path without quotes | Parse error or a mangled path |
| `kind:` missing/typo in `target` | "unsupported target kind" at startup |
| Wrong path in `command`/`path` | Red banner on click: "…does not exist…" |
| New spelling of an existing technology/section | Duplicate filter entries |

## 5. What to send for the test round

For each of your GUIs, either a filled entry block (preferred) or, minimally,
this list — the maintainers will convert it:

1. Name (as it should appear)
2. Technology + Section (from the vocabularies above, or propose a new value)
3. Platform (LabVIEW / Phoebus / Web / CSS)
4. RMC (if any) and a Note (searchable keywords)
5. **Exactly how it is started today**: the full command line, the URL, or the
   folder path — including the machine/OS it runs on.

Send the result to the launcher maintainers (or open a merge request against
the deployed `launcher.yaml`). After the file is updated, restart the launcher
and your rows appear — there is no separate import step.

For a shared catalog, place only an `entries:` list in the external YAML and
reference it from the root config under `catalog.sources`. Source order matters:
a later source replaces an earlier row with the same `id`, and the launcher logs
the override. A cached or missing source is shown as `CATALOG STALE` in the UI.

---

## 6. Bulk collection: the intake sheet (for maintainers)

To gather a few dozen GUIs at once, hand owners `intake/L4_GUI_INTAKE.csv`
(open it in Excel / LibreOffice / Google Sheets). One row per GUI; the columns
mirror the fields above plus `Target kind`, generic process/web/folder fields,
typed LabVIEW/Phoebus fields, and an `Enabled (yes/no)` decision column. A
`labview-dev` row uses `IOC name`, `Host name`, `IOC type`, and `EXE name`; its
generic command cell is intentionally empty. A `labview-epics` row uses
`GUI name`, `GUI type`, and `EXE name` and also leaves the command cell empty.
A `phoebus` row uses `Phoebus resource URI/path`; leave that field empty only
for a deliberate server-only action.

Convert the completed sheet to YAML deterministically:

```sh
npm run intake-to-yaml -- intake/L4_GUI_INTAKE.csv -o converted.yaml
npm run validate-config -- converted.yaml   # the same validator the app uses
```

- Only rows marked **`Enabled = yes`** are converted. `no` rows are skipped
  (reported); blank template rows are ignored.
- A row with data but no clear kind/name/target, a bad URL, a malformed
  `NAME=value` env cell, or a duplicate id **aborts the whole conversion** with
  a row number and reason. Nothing is guessed — fix the sheet and re-run.
- `Arguments` accept a JSON array (`["--layout","overview"]`) or a
  semicolon-separated list (`--layout; overview`). `Environment requirements`
  are semicolon-separated `NAME=value` pairs.
- Owner / tested-on / result / comments columns are preserved as YAML comments
  above each generated entry, so provenance survives the conversion.

Then merge the generated `entries:` into the deployed `launcher.yaml` (keep that
file's `security:` block, `quickActions`, and `moreActions`), and restart.
