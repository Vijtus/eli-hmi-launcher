# Installing, running and configuring the launcher at TESTZ

Written for the control-room workstation `TESTZ-OPR04`. Everything here was done
on that machine, not inferred.

---

## 1. Install

Two ways. Pick one.

### Portable — nothing installed

Copy `ELI.HMI.Launcher-0.4.0-x64-portable.exe` and `launcher.yaml` into the same
folder, anywhere — a USB stick, the Desktop, `C:\Tools\`. Double-click the `.exe`.

Use this when trying a new build, or on a machine you would rather not change.
It writes its diagnostic report next to itself, which is what makes it the right
choice when something is wrong.

### Installed — for a machine that keeps it

Run `ELI.HMI.Launcher-0.4.0-x64-setup.exe`. It is a wizard, not a one-click
installer, and installs per-user, so it does not ask for administrator rights.
The default location is

    %LOCALAPPDATA%\Programs\eli-hmi-launcher\

and the wizard lets you change it. It also creates a Desktop and Start Menu
shortcut. Installing over an existing copy removes the old one first.

Windows will show a blue SmartScreen box on first run, because the build is not
code-signed. Click **More info**, then **Run anyway**. Once, per version.

---

## 2. Put the configuration where it survives upgrades

This is the step people get wrong, and it costs an afternoon when they do.

    copy  launcher.yaml  to  %APPDATA%\eli-hmi-launcher\launcher.yaml

Paste `%APPDATA%` into the Explorer address bar to get there. Create the
`eli-hmi-launcher` folder if it does not exist.

**Do not put it in the install folder.** It works, but the next version deletes
it. The launcher tells you when this has happened: the strip at the top of the
window reads `CONFIG (built in, not editable)` instead of naming your file.

For the portable build there is no `%APPDATA%` step — `launcher.yaml` simply
sits beside the `.exe`.

### If you see this on startup

    Root config uses obsolete `appName`; use `siteName`

An old `launcher.yaml` is still in `%APPDATA%`. Overwrite it with the one from
this release. The key was renamed; old and new files are not interchangeable in
either direction.

---

## 3. First run — what you should see

The window lists every entry with a search box and filters. On TESTZ-OPR04 that
is 12 rows: 3 Phoebus, 7 LabVIEW, 2 web, plus a **Phoebus** button top-right and
a **More…** menu.

Click a row to launch it. Nothing else is needed.

Check the strip at the top of the window. It should name the file you just
copied. If it says `CONFIG (built in, not editable)`, go back to step 2.

### The Phoebus rows need one more thing, for now

`Power Meters` and `Centroids` open panels that are **not in the css-gui
repository**. Until they are committed, copy them onto the machine by hand:

    copy  deployment/TESTZ/panels/TESTZ  to  C:\Workspaces\css-gui\panel\

so that you end up with `C:\Workspaces\css-gui\panel\TESTZ\pm.bob`.

`Phoebus (no panel)` needs none of this. Use it to tell "Phoebus or the .ini is
broken" apart from "one panel is missing" — it was passing while both panels
still failed.

---

## 4. Changing the configuration

Edit `%APPDATA%\eli-hmi-launcher\launcher.yaml`, save, restart the launcher.
There is no reload button; restarting takes a second.

### The machine-specific block

Everything that differs between workstations is in one place at the top:

```yaml
siteName: TESTZ

local:
  workspaceRoot: C:\Workspaces\TESTZ_dev_TESTZ-OPR04
  cssGuiRoot: C:\Workspaces\css-gui
  zoneSymbol: TESTZ
  phoebus:
    installRoot: C:\CSS Phoebus\product-5.0.2
    settingsFile: C:\Workspaces\css-gui\settings\TESTZ.ini
    serverPort: 4918
```

`workspaceRoot` is the workspace **root**, not the `Deployment` folder inside it.
The launcher appends `Common\ELI\IOCs\<ioc-type>\Builds\GUI Application\<exe>`
itself. Pointing it one level too deep makes every LabVIEW row fail as "not on
this machine".

`installRoot` is the Phoebus **directory**, not `phoebus.bat`.

### Adding a web link

The simplest possible edit. Anywhere in `entries:`:

```yaml
  - id: web-elog
    name: Elog
    technology: [--]
    section: [TESTZ]
    platform: Web
    rmc: --
    note: shift log
    target: { kind: web, url: 'https://elog.example.org/' }
```

`id` must be unique across the whole file, including the quick action and the
More… menu. A duplicate is refused at load with the offending id named:
`contains duplicate entry id 'phoebus-power-meters'`.

`technology` and `section` accept either a single value or a list. The shipped
file uses lists (`[Diagnostics]`) because an entry can belong to more than one
filter group; `technology: Diagnostics` is equally valid for a single one.

### Adding a Phoebus panel

```yaml
  - id: phoebus-vacuum
    name: Vacuum Overview
    technology: [Vacuum]
    section: [TESTZ]
    platform: Phoebus
    rmc: --
    note: vacuum.bob
    target: { kind: phoebus, resource: panel/TESTZ/vacuum.bob, app: display_runtime }
```

`resource:` is relative to `cssGuiRoot`. So the example above resolves to
`C:\Workspaces\css-gui\panel\TESTZ\vacuum.bob`.

For plain Phoebus with nothing open, use `target: { kind: phoebus }`.

### Adding a LabVIEW GUI

```yaml
  - id: cm-rmc00-005
    name: Camera Manager
    technology: [Cameras]
    section: [TESTZ]
    platform: LabVIEW
    rmc: RMC00-005
    note: --
    target:
      kind: labview-dev
      iocName: Camera Manager
      hostName: RMC00-005
      iocType: Camera Manager
      exeName: CM.exe
```

The path is assembled from `workspaceRoot` + `iocType` + `exeName`, so you never
write a full path. `exeName` is `CM.exe` — not `CMD.exe`.

### Checking a change before restarting

If the repository is checked out on the machine:

```sh
npm run validate-config -- "%APPDATA%\eli-hmi-launcher\launcher.yaml"
```

It prints `OK` plus a summary, or names the exact key and line that is wrong.
Faster than restarting and guessing.

---

## 5. The security block — read before editing

```yaml
security:
  allowedCommandRoots:
    - ${local.workspaceRoot}
    - ${local.cssGuiRoot}
    - ${local.phoebus.installRoot}
  allowBareCommands: false
```

Nothing outside these three directory trees can be launched. If you add an entry
pointing somewhere else, it is refused, and the report says
`REFUSED BY SECURITY POLICY` rather than pretending the file is missing.

That is deliberate: this file is the trust root. A catalog pulled from the config
repository **cannot** widen this list, so a compromised or mistaken repository
cannot make the launcher run arbitrary programs. Widen it here, on purpose, or
not at all.

---

## 6. When something does not work

Run the **portable** build. It writes a folder next to itself:

    ELI-Launcher-testz-opr04-<date>_<time>\
      report.md        what it found, what it launched, what happened after
      events.jsonl     the same as a machine-readable log
      launch-*.log     captured output from each program

`report.md` opens with a headline like **15 of 15 entries would launch on this
machine**, then a section for each entry that would not, with the resolved path
and the reason. Further down, `What is actually on this machine` lists what it
actually found — that section is what identified the missing `.bob` panels.

Credential-shaped values are stripped from captured output before anything is
written, so the folder is safe to send.

Wait about 15 seconds after your last click before closing the window. Each
launch is watched for 10 seconds and results are written on the way out; closing
early truncates the report.

### Reading the launch results

`RUNNING` means the process was still alive ten seconds later. It is not proof
the *right* program opened — compare against what appeared on screen.

`STARTED` is normal for Phoebus. Phoebus runs as a server: the second and later
launches hand a resource to the instance already running and exit immediately,
so the launched process is long gone by the ten-second mark.

---

## 7. Where the configuration is heading

Today `launcher.yaml` is copied onto each machine by hand. The launcher can
instead clone it from `gitlab.eli-beams.eu/lcs/eli-hmi-config` at startup,
layering `zone/TESTZ.yaml` (shared) over `host/TESTZ-OPR04.yaml` (per-machine),
so a catalog change becomes a commit rather than a file copied to every
workstation.

Confirmed on 2026-08-27 that TESTZ-OPR04 reaches that GitLab and clones the
repository successfully, despite having no internet access. What is still
missing there is the host file and the filled-in `css:`/`web:` groups — both are
prepared under `deployment/TESTZ/config-repo/`.

When it is set up, these environment variables switch it on:

```
ELI_LAUNCHER_CONFIG_REPO_URL       https://gitlab.eli-beams.eu/lcs/eli-hmi-config.git
ELI_LAUNCHER_CONFIG_REPO_USERNAME  a GitLab username
ELI_LAUNCHER_CONFIG_REPO_TOKEN     a read-only deploy token
ELI_LAUNCHER_CONFIG_REPO_SUBPATH   launcher
```

`security:` and `access:` stay in the local file regardless. Git is built into
the launcher, so the machine does not need git installed.

---

## Reference

Full schema and precedence rules: [../../docs/configuration.md](../../docs/configuration.md).
Failure modes in more detail: [../../docs/troubleshooting.md](../../docs/troubleshooting.md).
