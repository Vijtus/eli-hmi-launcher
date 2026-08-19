# Installing and running the ELI HMI Launcher

Two ways to get the launcher running. Most operators want **Install a release**;
developers and anyone changing the catalog want **Run from source**.

Builds are **unsigned**, so Windows and macOS both show a one-time warning the
first time you open the app. The steps below clear it.

---

## Install a release

Download the artifact for your machine from the
[Releases page](https://github.com/eli-eric/eli-hmi-launcher/releases).

| OS | Download | Notes |
|---|---|---|
| Windows | `ELI HMI Launcher-<version>-x64-setup.exe` | Installs per-user; no admin rights needed |
| Windows (no install) | `ELI HMI Launcher-<version>-x64-portable.exe` | Single file, runs from anywhere |
| macOS (Apple Silicon) | `ELI HMI Launcher-<version>-arm64.dmg` | M1 and later |
| macOS (Intel) | `ELI HMI Launcher-<version>-x64.dmg` | |
| Linux (any distro) | `ELI HMI Launcher-<version>-x86_64.AppImage` | `chmod +x`, then run it |
| Debian / Ubuntu | `eli-hmi-launcher_<version>_amd64.deb` | `sudo apt install ./<file>.deb` |
| Fedora / RHEL / SUSE | `eli-hmi-launcher-<version>.x86_64.rpm` | `sudo dnf install ./<file>.rpm` |
| Linux (no install) | `eli-hmi-launcher-<version>.tar.gz` | Extract and run `eli-hmi-launcher` |

`arm64` builds are published for every platform alongside the `x64` ones.

### Windows

Run the `-setup.exe`. It installs for the current user, so it does **not** ask
for an administrator password, and it lets you change the install directory.

> **"Windows protected your PC"** — this is SmartScreen reacting to an unsigned
> installer, not a detection of anything wrong. Click **More info**, then
> **Run anyway**. You will only see it once per version.

### macOS

Open the `.dmg` and drag the app to Applications.

> **"ELI HMI Launcher is damaged and can't be opened"**, or **"cannot be opened
> because the developer cannot be verified"** — this is Gatekeeper reacting to an
> unsigned, un-notarized app. Either:
>
> - right-click (or Control-click) the app → **Open** → **Open**, or
> - clear the quarantine flag once:
>   ```sh
>   xattr -dr com.apple.quarantine "/Applications/ELI HMI Launcher.app"
>   ```

### Linux

**AppImage** — no installation, works on essentially any distribution:

```sh
chmod +x "ELI HMI Launcher-<version>-x86_64.AppImage"
./"ELI HMI Launcher-<version>-x86_64.AppImage"
```

If it fails with `dlopen(): error loading libfuse.so.2`, install FUSE 2
(`sudo apt install libfuse2` / `sudo dnf install fuse-libs`), or extract and run
without FUSE:

```sh
./"ELI HMI Launcher-<version>-x86_64.AppImage" --appimage-extract
./squashfs-root/eli-hmi-launcher
```

**deb / rpm** — installs to `/opt/ELI HMI Launcher` and adds a desktop entry, so
the launcher appears in the applications menu:

```sh
sudo apt install ./eli-hmi-launcher_<version>_amd64.deb    # Debian/Ubuntu
sudo dnf install ./eli-hmi-launcher-<version>.x86_64.rpm   # Fedora/RHEL
```

These also configure Electron's `chrome-sandbox` helper correctly, which a plain
tarball or source checkout does not.

---

## Point the launcher at your catalog

An installed app ships the **mock** catalog so it is clickable immediately. To
use a real one, drop your `launcher.yaml` in the per-user config directory — no
admin rights, and it takes priority over the bundled file:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\eli-hmi-launcher\launcher.yaml` |
| macOS | `~/Library/Application Support/eli-hmi-launcher/launcher.yaml` |
| Linux | `~/.config/eli-hmi-launcher/launcher.yaml` |

To use a file somewhere else instead, set `ELI_LAUNCHER_CONFIG` to its absolute
path — that overrides everything:

```sh
# Linux / macOS
ELI_LAUNCHER_CONFIG=/etc/eli/launcher.yaml "/opt/ELI HMI Launcher/eli-hmi-launcher"
```
```powershell
# Windows (PowerShell)
$env:ELI_LAUNCHER_CONFIG = "C:\ELI\launcher\launcher.yaml"
& "$env:LOCALAPPDATA\Programs\ELI HMI Launcher\ELI HMI Launcher.exe"
```

Search order, highest priority first:

1. `ELI_LAUNCHER_CONFIG`
2. the per-user path in the table above
3. the config bundled with the app
4. `config/launcher.yaml` beside the executable

An **installed** launcher deliberately ignores the working directory: it is
started from arbitrary places and the config decides which commands get spawned.
A **source checkout** does use `./config/launcher.yaml`, which is what makes
`npm start` work out of the box.

See [`CONFIG_SCHEMA.md`](../CONFIG_SCHEMA.md) for the schema and
[`CONFIG_HOWTO.md`](../CONFIG_HOWTO.md) for a walkthrough.

---

## Diagnosing a machine (portable build)

The **portable** `.exe` records what it finds. Run it from a USB stick on the
machine in question and it writes two files **next to itself**, then shows a
banner in the window pointing at them:

```
ELI-Launcher-<machine>-<timestamp>-report.md      what works and what does not
ELI-Launcher-<machine>-<timestamp>-events.jsonl   every launch and event, live
```

Send **both** files back. The report opens with the line that matters:

```
**24 of 29 entries would launch on this machine.**
```

then lists every entry that would not, with the command it resolved to and why:

| Verdict | Meaning |
|---|---|
| `NOT ON THIS MACHINE` | Resolved fine, but the program is not installed here |
| `REFUSED BY SECURITY POLICY` | Present, but outside `security.allowedCommandRoots` |
| `CONFIG INCOMPLETE` | A required `local.*` value is missing for that entry |

Nothing is launched to produce this — commands are resolved and checked on disk,
and web targets are **not** contacted, so it puts no traffic on a control
network.

If the stick is read-only the files go to the Desktop instead, and failing that
to the per-user data directory. The path in the banner is always the truth.

The installed builds (`setup.exe`, `.deb`, `.rpm`, `.dmg`) do **not** record.
To force recording anywhere, set `ELI_LAUNCHER_FIELD_REPORT=1`, or
`ELI_LAUNCHER_FIELD_REPORT_DIR=<folder>` to choose the destination.

---

## Run from source

Needs **Node 20.19+** and a desktop session. Works identically on all three OSes.

```sh
git clone https://github.com/eli-eric/eli-hmi-launcher.git
cd eli-hmi-launcher
```

```sh
./run.sh          # Linux / macOS
```
```bat
run.cmd           :: Windows
```

Either one installs dependencies on first run (this downloads Electron, roughly
100–200 MB), validates `config/launcher.yaml`, and starts the app. `npm run app`
does the same thing.

Mock launches append to `<OS temp>/eli-hmi-launcher-mock.log`:

```sh
tail -f "${TMPDIR:-/tmp}/eli-hmi-launcher-mock.log"        # Linux / macOS
```
```powershell
Get-Content "$env:TEMP\eli-hmi-launcher-mock.log" -Wait     # Windows
```

### Build installers yourself

```sh
npm run dist          # for the OS you are on
npm run dist:win      # or target one explicitly
npm run dist:mac
npm run dist:linux
npm run pack          # unpacked directory only, much faster
npm run smoke:packaged  # start the packaged build and prove it launches a process
```

Artifacts land in `release/`. Cross-building has real limits: macOS artifacts can
only be produced on macOS, and the `rpm` target needs `rpmbuild` installed
(`sudo apt install rpm`). CI builds all three platforms on their native runners.

---

## Troubleshooting

**"No launcher config found"** — the app could not find a `launcher.yaml`. Put
one in the per-user path above, or set `ELI_LAUNCHER_CONFIG`.

**A configuration error window appears at startup** — the YAML was found but
rejected. The message names the file and the problem. Validate it without
launching:

```sh
npm run validate-config -- /path/to/launcher.yaml
```

**Linux: `The SUID sandbox helper binary was found, but is not configured
correctly`** — only affects source checkouts and the plain tarball; the `.deb`
and `.rpm` handle it. Either run once with `ELECTRON_DISABLE_SANDBOX=1`, or:

```sh
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

**Linux over SSH: the window never appears** — Electron needs a desktop session.
Use `ssh -X`, or run headless with `xvfb-run -a npm run app`.

**Where are the logs?**

| OS | Path |
|---|---|
| Windows | `%APPDATA%\eli-hmi-launcher\logs\launcher.log.jsonl` |
| macOS | `~/Library/Logs/eli-hmi-launcher/launcher.log.jsonl` |
| Linux | `~/.config/eli-hmi-launcher/logs/launcher.log.jsonl` |
