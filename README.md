# ELI HMI Launcher (L4) — MVP

Minimal, config-driven launcher for L4 control-system GUIs. It is an Electron
desktop app with a vanilla-TypeScript renderer styled with Pico CSS: a flat,
searchable, filterable table that reflects an external YAML configuration.
Clicking a row launches a GUI. Top-right quick actions cover Data Browser and
Alarm System; a **More…**
menu covers Sequencer, Safety Diagnostics, Network Shared Folder, and future
services. The interface uses a fixed, high-contrast black-and-white palette and
does not follow the operating-system color scheme.

The renderer only displays/filters and sends a launch **id** over IPC. The main
(Node) process owns config loading, validation, security enforcement, and
launching, including instance/write-mode access checks. The renderer never
receives or sends raw commands or resolved access policies.

Version: `0.4.0`. This implementation run used Node `v22.16.0`; Electron 40 requires a currently supported Node toolchain for development.

---

## Run

```sh
npm ci
npm start          # electron-vite dev
```

The default `config/launcher.yaml` is wired to **mock launchers** so everything
is clickable immediately without real LabVIEW/Phoebus paths. Mock process
launches append to `<OS-temp>/eli-hmi-launcher-mock.log`.

```sh
# Linux/macOS
tail -f "${TMPDIR:-/tmp}/eli-hmi-launcher-mock.log"
# Windows (PowerShell)
Get-Content "$env:TEMP\eli-hmi-launcher-mock.log" -Wait
```

## Build / typecheck / validate

```sh
npm test                             # regression tests for filtering, launch validation, UI palette, and config
npm run typecheck                    # tsc -b (main+preload+shared+scripts, and renderer)
npm run build                        # electron-vite build -> ./out
npm run check                        # typecheck + build in one go
npm run validate-config              # validate config/launcher.yaml with the real parser
npm run validate-config -- <path>    # validate a specific YAML (exit 1 on error)
npm run intake-to-yaml -- <csv>      # convert a completed intake sheet to YAML entries
npm run smoke:hmi-lifecycle           # exercise the loopback lifecycle HTTP contract
npm run smoke:labview-contract        # execute exact-path POSIX launch fixtures
npm run smoke:phoebus-local           # validate wrapper argv and local BOB assets
npm run acceptance:local              # run the IOC + lifecycle + Electron + Phoebus acceptance
npm run verify                       # tests + build + four config validations + Phoebus assets
```

## Executable local acceptance

`npm run acceptance:local` exercises the joined local stack through the built
Electron main process. It verifies the supplied IOC with the required `caget`
and `camonitor`, prepares the static mock records and in-memory flashlamp
fanout with a complete `caput` audit, starts the loopback lifecycle sidecar, applies the tracked
alarm layout first, launches both LabVIEW contract fixtures and three Phoebus
BOBs through IPC, captures lifecycle/runtime/argv evidence, and then restores
the memento in a fresh Phoebus process. It stops only processes that it started
or identified from run-specific receipts.

Prerequisites are Linux, Docker access, `npm ci`, the loaded
`laser-mockup-ioc:ready` image, `Xvfb`, `scrot`, `xwininfo`, `lsof`, `jq`, and a
Python interpreter with the dependencies from
`services/hmi-lifecycle-api/requirements.txt`. JWM is used when available.
Bootstrap installs the SHA-256-locked Phoebus/JDK artifacts under ignored
`.local/phoebus/`; the initial download is about 487 MB. If the Python is not in
the standard local paths, set `ELI_HMI_LIFECYCLE_PYTHON` to its executable.

Each run creates an exclusive ignored directory below
`.local/acceptance/<UTC timestamp>.<random suffix>/`,
including literal CA output, JSON launch/lifecycle records, exact NUL-delimited
argv captures, logs, window trees, and screenshots. The tracked sample images
are `reference-screenshots/05-local-phoebus-live.png`,
`06-local-alarm-layout-restored.png`, and
`07-local-acceptance-launcher.png`. The expanded operator-style mock is recorded
in `08-local-realistic-overview.png`, `09-local-realistic-cooling.png`,
`10-local-realistic-timing-control.png`, and
`11-local-realistic-launcher.png`.

This acceptance config contains explicit local contracts. The `.exe` files are
POSIX fixtures, not NI LabVIEW binaries. The lifecycle sidecar is not the
unresolved site lifecycle API, and the memento uses a local alarm root without
a site alarm server. See `STATUS.md` and `BLOCKERS.md` for the ticket buckets.

## Collecting real GUI entries from L4 users

`intake/L4_GUI_INTAKE.csv` is a blank collection sheet. Maintainers hand it to
GUI owners, who fill one row per GUI (name, technology, section, how it starts).
Convert completed rows to YAML deterministically:

```sh
npm run intake-to-yaml -- intake/L4_GUI_INTAKE.csv -o converted.yaml
npm run validate-config -- converted.yaml   # same validator the app uses
```

Only rows marked `Enabled = yes` are converted; invalid rows abort with
row-numbered errors (the converter never guesses values). Merge the resulting
`entries:` into the deployed `launcher.yaml`. See **CONFIG_HOWTO.md** §6.

## Point at a different config

```sh
# Linux/macOS
ELI_LAUNCHER_CONFIG=/absolute/path/to/launcher.yaml npm start
# Windows (PowerShell)
$env:ELI_LAUNCHER_CONFIG="C:\ELI\launcher\launcher.yaml"; npm start
```

If `ELI_LAUNCHER_CONFIG` is unset, the app searches (in order) the current
working directory, the app path, the packaged resources dir, and the executable
dir — each for `config/launcher.yaml`.

---

## Git-backed configuration (config repo)

The launcher can take its machine and zone configuration from a git repository
instead of hand-maintained local files. On startup it clones or updates that repo,
picks the file matching its own hostname, follows the `zone:` key in that file to
the matching zone file, and folds both into the config model.

**The feature is off unless `ELI_LAUNCHER_CONFIG_REPO_URL` is set.** With it unset
the launcher behaves exactly as it did before, so this can be rolled out one
machine at a time.

The launcher is **read-only** against the config repo. It never commits, pushes,
or writes to the remote.

### Repo layout

```
<repo-root>/
└── launcher/                     # ELI_LAUNCHER_CONFIG_REPO_SUBPATH, default "launcher"
    ├── host/                     # one file per machine
    │   ├── TESTZ-Deploy.yaml
    │   └── L4-Operator-01.yaml
    └── zone/                     # one file per zone
        ├── TESTZ.yaml
        └── L4.yaml
```

A host file carries this machine's paths and names the zone it belongs to:

```yaml
zone: TESTZ                                   # -> local.zoneSymbol, and selects zone/TESTZ.yaml
P4-workspace: D:\Workspaces\Perforce\TESTZ_dev  # -> local.workspaceRoot
css-gui: D:\Workspaces\css-gui                # -> local.cssGuiRoot
css-install: C:\CSS Phoebus\product-5.0.2     # -> local.phoebus.installRoot
hmi-server: testz-deploy20:8082               # -> local.hosts."hmi-server"
local:                                        # optional: any native launcher setting
  phoebus:
    serverPort: 4918
```

A zone file carries the launchable HMIs, grouped by platform:

```yaml
labview-dev:                    # -> target kind: labview-dev
  - ioc-name: Camera Manager
    host: RMC00-001             # also shown in the launcher's RMC column
    ioc-type: Camera Manager
    exe: CMD.exe
labview-epics:                  # -> target kind: labview-epics
  - gui-name: Vacuum Overview
    gui-type: Vacuum
    exe: Vacuum.exe
css:                            # -> target kind: phoebus
  - name: Cooling Overview
    resource: cooling.bob       # or `layout: true`; `app:` refines a resource
web:                            # -> target kind: web
  - name: Operator Logbook
    url: https://logbook.example.org
zone: TESTZ                     # optional metadata, not an HMI group
local: {}                       # optional zone-wide defaults, overridden by the host file
```

An empty group (`css:` with nothing after it) is valid. Optional per-item
`id`, `technology`, `section`, `note`, and `platform` keys override the defaults.
Entry ids are generated deterministically (`labview-dev-<ioc-name>-<host>`), so
one IOC name may appear on several hosts without colliding.

> **Confirm before production:** only `labview-dev` has real data in
> `eli-eric/eli-hmi-config` today. The item keys for `labview-epics`, `css`, and
> `web` above are our proposal, chosen to mirror the launcher's existing target
> types, and need maintainer sign-off.

### Environment variables

| Name | Purpose | Required | Default | Example |
|---|---|---|---|---|
| `ELI_LAUNCHER_CONFIG_REPO_URL` | HTTPS URL of the config repo. **Unset = feature off.** | To enable | *(unset)* | `https://github.com/eli-eric/eli-hmi-config.git` |
| `ELI_LAUNCHER_CONFIG_REPO_TOKEN` | HTTPS credential. Unset ⇒ anonymous clone is attempted. | No | *(unset)* | `ghp_…` |
| `ELI_LAUNCHER_CONFIG_REPO_REF` | Branch, tag, or commit SHA to pin to. | No | remote default branch | `main`, `v1.4.0`, `f40748b…` |
| `ELI_LAUNCHER_CONFIG_REPO_SUBPATH` | Directory inside the repo holding `host/` and `zone/`. | No | `launcher` | `launcher` |
| `ELI_LAUNCHER_CONFIG_CACHE_DIR` | Where the checkout is cached. | No | `<userData>/config-repo`; `<tmp>/eli-hmi-launcher-config-repo` for CLI tools | `C:\ProgramData\ELI\config-repo` |
| `ELI_LAUNCHER_CONFIG_HOSTNAME` | Override the machine identity (VMs, containers, testing). | No | OS hostname | `TESTZ-Deploy` |
| `ELI_LAUNCHER_CONFIG_FETCH_TIMEOUT_MS` | Network budget per attempt. | No | `10000` | `20000` |
| `ELI_LAUNCHER_CONFIG_OFFLINE` | Skip the network; use the cache only. | No | `0` | `1` |

`ELI_LAUNCHER_CONFIG` (the existing local config path) is unchanged and still
required — see *Precedence* below.

### Resolution order

```
1. obtain the repo      cache absent  -> clone --depth 1 --single-branch <ref>
                        cache present -> fetch + checkout --force <ref>
                        git error     -> discard cache, re-clone once
                        network error -> use cache (STALE) or fail if none

2. find the host file   <subpath>/host/, case-insensitive scan
                        try FQDN            e.g. testz-deploy.eli.example.cz
                        then short name     e.g. testz-deploy
                        no match            -> HARD FAIL, naming what exists

3. find the zone file   read `zone:` from the host file (required)
                        <subpath>/zone/, case-insensitive scan
                        no match            -> HARD FAIL, listing available zones

4. merge                zone `local:`   (base)
                        host kebab keys (override)
                        host `local:`   (override, wins)

5. apply                merged values  -> the launcher's `local:` model
                        zone HMI groups -> entries, as a catalog source
```

Names are matched **case-insensitively** so the same repo resolves identically on
Windows and Linux — `TESTZ-Deploy.yaml` matches a hostname of `testz-deploy`. Two
files whose names differ only by case are rejected as ambiguous.

### Merge rules

- Mappings merge **key by key, recursively**.
- Scalars replace.
- **Lists replace wholesale — they never concatenate.** A zone list is a complete
  catalogue, so appending would make removal from a host file impossible.
- A key that is absent or explicitly `null` does **not** override. Use an empty
  list or empty string to clear a value deliberately.

### Precedence

| Setting | Winner |
|---|---|
| `local:` machine values | **config repo** (host file beats zone file beats `config/launcher.yaml`) |
| `entries:` | **config repo** zone file beats inline entries and filesystem catalogs |
| `security:`, `access:` | **local `config/launcher.yaml` only — never the config repo** |
| `appName`, `quickActions`, `moreActions` | local `config/launcher.yaml` only |

`security:` is intentionally not overlayable. The config file is a trust root that
decides which commands may be spawned; letting a pushable repo relax
`allowedCommandRoots` would turn write access to that repo into code execution on
every workstation. This is why `config/launcher.yaml` is still required.

### Failure modes

| Situation | Launcher behaviour | Operator-visible signal |
|---|---|---|
| Repo reachable, everything resolves | Starts normally | `Config repo resolved` log, `source: fresh` |
| Network down, cache present | **Starts on the cached commit** | `CATALOG STALE` badge; warn log with commit SHA + fetch timestamp |
| Network down, no cache, no local config | Refuses to start | Config error window naming the URL, cache path, and remedy |
| Local cache corrupted | Discards it and re-clones once | Warning log; starts normally |
| Hostname has no host file | Refuses to start | Error naming hostname tried, files present, and the remedy |
| Host file has no `zone:` key | Refuses to start | Error naming the file and the missing key |
| `zone:` names a missing zone file | Refuses to start | Error listing available zones |
| Malformed YAML / missing required key | Refuses to start | Error naming file, key, and remedy |
| Bad ref (branch/tag/SHA) | Refuses to start (no retry) | Error naming `ELI_LAUNCHER_CONFIG_REPO_REF` |
| Remote hangs | Abandoned after the timeout | Falls back to cache, or the error above |

Startup cost is bounded: one 10 s attempt plus one retry (500 ms backoff), so the
worst case is about **20.5 s** before the launcher either starts on cache or shows
the error window. It never hangs indefinitely.

### Cache

Default `<userData>/config-repo`, created `0700` (no-op on Windows):

```
<cache>/repo/              the shallow checkout
<cache>/fetch-state.json   {url, ref, commitSha, fetchedAt}, written atomically
```

The cache holds only configuration, never the token.

### Token handling

The token is passed to the git client through an in-memory callback and becomes
an `Authorization` header for the duration of each request. It is **not** written
into the remote URL in `.git/config`, **not** passed as a command-line argument
(no child process is spawned — the git client is pure JavaScript), and **not**
logged: every error string, including the git client's own, is redacted first.

### Troubleshooting: "the launcher started with stale config"

`CATALOG STALE` in the UI means the config repo could not be refreshed and the
launcher fell back to the last good commit. Work down this list:

1. **Find the evidence.** Open the launch log (path is printed at startup;
   `<userData>/logs/launcher.log.jsonl`) and look for `Config repo resolved`.
   `"source":"cached"` confirms the fallback, and `commitSha` + `fetchedAt` tell
   you how old the configuration is.
2. **Check the obvious switch.** Is `ELI_LAUNCHER_CONFIG_OFFLINE` set to `1` on
   this machine? That forces the cache and skips the network entirely.
3. **Reproduce it without the UI:**
   ```sh
   npm run dump-config
   ```
   It prints the same resolution with the reason on stderr, secrets redacted.
4. **Check reachability** of `ELI_LAUNCHER_CONFIG_REPO_URL` from *this* machine.
   Proxy, DNS, and firewall rules are the usual causes.
5. **Check the credential.** An expired or revoked token looks like an auth
   failure in the warning. If the repo is public, unset the token and retry.
6. **Check the ref.** A branch or tag deleted upstream fails the fetch; confirm
   `ELI_LAUNCHER_CONFIG_REPO_REF` still exists.
7. **Confirm the machine identity.** `Config repo resolved` reports `hostname`
   and `hostnameSource`. If the machine was renamed, either add the new host file
   upstream or set `ELI_LAUNCHER_CONFIG_HOSTNAME`.
8. **Force a clean fetch** as a last resort — delete the cache directory
   (`cacheDir` in the log) and restart. The launcher will re-clone.

If the launcher refuses to start instead, the error window names the file, the
key, and the remedy; steps 4–7 apply the same way.

### Migration from local config files

The git path is **opt-in per machine**. Nothing changes until
`ELI_LAUNCHER_CONFIG_REPO_URL` is set on that machine.

- **Machines not yet migrated** keep using `config/launcher.yaml` exactly as
  before. That path is **not deprecated**.
- **Migrated machines** still need `config/launcher.yaml`, because `security:`,
  `access:`, `appName`, and the quick/more actions are read only from it. What the
  config repo replaces is the `local:` block and the machine's HMI entries.
- Any `local:` values left in the local file are overridden by the config repo, so
  they can be pruned after migration rather than before.
- **Rollback** is unsetting `ELI_LAUNCHER_CONFIG_REPO_URL` and restarting. No
  cached state has to be cleaned up first.

---

## How to test the UI

- **Row click** (or focus a row and press **Enter**/**Space**): launches that GUI.
- **Data Browser** / **Alarm System** buttons (top right): quick-action launches.
- **More…**: opens the services menu. **Esc** or a click outside closes it.
- **Search**: matches **Name** and **Note** only. Technology and Section are
  covered by the dropdowns instead.
- **Technology / Section** dropdowns: filter the table. Options are derived
  from the loaded config. An empty result shows a clear empty state. These are
  custom accessible comboboxes (ARIA listbox), not native `<select>`s, so the
  closed, focused, and open states render identically on Linux, Windows, and
  macOS. Full keyboard support: open with **Enter/Space/↓**, move with
  **↑/↓/Home/End**, type-ahead to jump, **Enter** to choose, **Esc** to close.
- A **successful launch shows nothing** — the user clicks and the GUI opens.
  A **failed launch** (missing or non-executable command, invalid working
  directory, unmounted folder, command outside the allow-list, …) shows a
  black-and-white, dismissible error banner with the reason.
- The **State** column is session-local. `RUNNING` requires a launcher-owned PID
  and matching process start identity; `SHARED` means the configured Phoebus
  server port is reachable; `HANDOFF` means Electron passed a browser/folder
  request to another application. These labels are not interchangeable.
- LabVIEW entries default to one launcher-observed instance and fail closed on
  stale or unknown state. Main serializes two rapid requests for the same id.
  This cannot detect an HMI started outside the launcher session until the HMI
  API integration supplies external state.

> Process targets have a short startup grace window. A missing executable or an
> immediate non-zero wrapper exit is reported as a failure. After that window,
> the local registry periodically reconciles process identity. Browser tabs and
> individual Phoebus panels remain unobservable because they do not map 1:1 to
> launcher-owned child PIDs.

Because there is intentionally no success UI, the authoritative signals for
testing are the launched GUI itself, the mock log above, and the structured
launch log below (which records every attempt, success or failure).

---

## Diagnostics: structured launch log

Independently of the mock scripts, every launch attempt is appended as one JSON
object per line (JSONL) to a log in the OS app-logs directory:

- Linux: `~/.config/eli-hmi-launcher/logs/launcher.log.jsonl`
- Windows: `%APPDATA%\eli-hmi-launcher\logs\launcher.log.jsonl`
- macOS: `~/Library/Logs/eli-hmi-launcher/launcher.log.jsonl`

Each launch record contains: timestamp, `id`, `label`, `kind`, the resolved
`command`+`args` / `url` / `path`, `ok`, `error` (on failure), and `durationMs`.
Failures retain their resolved argv so path and quoting faults can be diagnosed.
The target environment is never written. Values following credential-like
flags (`token`, `password`, `secret`, API keys, authorization) and matching URL
query parameters are replaced with `[REDACTED]`. Do not place opaque secrets in
unlabelled argv positions. Config-load success/failure is also logged. Example:

```json
{"ts":"2026-…Z","type":"launch","id":"camera-manager-alena","label":"Camera Manager Alena","kind":"process","command":"/opt/eli/l4-launchers/open-camera-manager-alena.sh","args":[],"ok":true,"durationMs":12}
```

---

## Configuration & security (summary)

Full reference: **CONFIG_SCHEMA.md**. The essentials:

- The config file is a **trust root**. `process` targets run with the launcher
  user's privileges. Anyone who can write the file (or its directory) can make
  every workstation that loads it run arbitrary commands.
- Deploy the config **read-only** to non-privileged users. On POSIX the launcher
  **refuses to load a world-writable config** unless
  `security.allowInsecureConfigPermissions: true`.
- Constrain process launches with the `security` block:
  - `allowedCommandRoots`: a resolved process `command` containing a path must
    live under one of these dirs (enforced at launch, symlinks resolved).
  - `allowBareCommands`: set `false` to reject bare PATH-resolved names.
- Web targets are HTTP(S)-only (validated at load). Folder opens report a clear
  error if the path is missing/unmounted.
- Duplicate ids across entries + quickActions + moreActions are rejected at load.
- Launch access policies resolve from platform defaults to per-item overrides
  and are enforced in main before spawn. LabVIEW defaults to `maxInstances: 1`;
  write exclusivity is modeled, but its site-specific mode signal remains a
  blocker. Unknown or stale state defaults to fail-closed.
- Malformed config **fails visibly**: the app opens an error window explaining
  the problem instead of exiting silently.
- When `local.hmiApi.baseUrl` is present, main coordinates leases, heartbeats,
  external state, and atomic launch reservations through the versioned local
  lifecycle adapter. With no URL, the adapter reports `disabled` and performs
  no lifecycle request. The bundled service is for local acceptance; the site
  owner and contract remain BLK-001.

`config/launcher.yaml` is the runnable mock config.
`config/launcher.example-real.yaml` is the deployment template (strict security
posture, placeholder paths).
`config/local-acceptance.yaml` is the executable Linux contract configuration;
it is not a deployment template.

**Adding your GUIs to the launcher (for L4 users):** see **CONFIG_HOWTO.md** —
a short, copy-paste guide for filling in entries without reading the full
schema reference.

---

## Scope (v1)

In: L4 flat table, search over name/note, Technology + Section filters,
row-click launch, quick actions, More menu, Pico CSS standard controls, six
typed targets, ordered external catalogs, machine-local configuration, Phoebus
server reuse, session-local runtime state, OS command overrides, config
variables, main-process access policies, security allow-list, launch logging,
regression tests, and CI.

Blocked or undecided site integration is listed in `BLOCKERS.md`, including the
HMI Python REST contract, alarm memento, Phoebus app names, write-mode meaning,
and real L4 values. In-app config editing, database storage, telemetry, and an
auto-updater are not part of this work order.

---

## UI component library

The renderer imports `@picocss/pico` locally through the build; it does not
depend on a CDN at runtime. Pico provides the standard input, button, dropdown,
and table foundations. Launcher CSS centrally overrides Pico's color tokens with
only `#000000` and `#ffffff`, so theme defaults and system accent colors cannot
leak into any interaction state. `styles.css` then adds the launcher layout,
single-scroll model, compact sizing, and accessible filter combobox without
reimplementing Pico's standard controls.

The two filter dropdowns are a custom accessible combobox (`combobox.ts`,
ARIA "select-only combobox" pattern) rather than a native `<select>`, because a
native select's popup list is drawn by the OS and cannot be themed consistently
across platforms. The combobox draws its own listbox from the same Pico
variables, keeping every state consistently black and white, and keeps full
keyboard and screen-reader semantics (`role="combobox"`/`listbox"`/`option"`,
`aria-expanded`, `aria-activedescendant`, `aria-selected`).

## Logo

The header uses a **text wordmark** (`L4 LAUNCHER`). No official ELI/L4 image
logo was supplied with this work, and none was invented. If maintainers provide
an official asset, drop it in and replace the `<h1>` wordmark, preserving its
aspect ratio. See `BLOCKERS.md`.
