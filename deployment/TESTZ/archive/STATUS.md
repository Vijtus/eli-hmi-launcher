# CSI-744 implementation status

This file records evidence from four execution hosts. Sections up to and
including "Major design decisions" were produced on the **previous host**.
The "Current-host verification" section at the end was produced on a
**later host** and states which of those results were reproduced there. The
"IOC and HMI API workstation verification" section was produced on a third
host. The "Executable local-contract workstation" section was produced
on a fourth host, and the closing "Post-delivery defect fix session" section was
produced on that same workstation in a later session. None of these records is a
substitute for another.

## Previous-host record

### Section 0 ordering result

| step | result | observed evidence |
|---|---|---|
| 1. Start the local EPICS mockup IOC | **RUNNING** | Native `softIoc` PID 878 reached `iocRun: All initialization complete`. `caget -w 5 L4-NSOPCPA-NL1:TK6:44:DisplayTemperature` returned `32` with exit 0. `camonitor L4-NSOPCPA-NL1:SY3PL50M:32:State` emitted `<undefined> OFF UDF NO_ALARM`. |
| 2. Locate the HMI Python API | **NOT FOUND** | The supplied archive contains zero `.py` files. Local checkout/sibling searches and code search across the 11 accessible GitHub repositories found no candidate HMI REST API source. Search stopped at this point as required. |
| 3. Wire the launcher to the Python API | **NOT REACHED** | Step 2 did not succeed. No API endpoint, payload, authentication, or retry behavior was invented. |
| 4. Fall through to launcher tickets | **REACHED** | Work continued in CSI-846 through CSI-854 order. |

The Python/EPICS performance work order is inactive because the API source is not present.

### Bucket definitions

| bucket | criterion used here |
|---|---|
| **IMPLEMENTED** | Code exists, compiles, has executable tests, and the behavior was observed on this host. |
| **CONSTRUCTED-UNVERIFIABLE** | Code and exact-argv/unit tests exist, but the required Windows, LabVIEW, or Phoebus runtime is absent. |
| **BLOCKED** | The ticket cannot reach its requested site behavior until a named external answer or artifact is supplied. Executable local portions are stated separately and do not move the ticket out of this bucket. |

### Ticket ledger

| ticket | bucket | commit | evidence observed in this session |
|---|---|---|---|
| CSI-846 — local machine configuration | **IMPLEMENTED** | `bf7569c` | `npm test` passed the absent-unused, undefined-key, expansion, port, and reconciliation-interval cases. Both shipped configs passed `npm run validate-config`; the mock reports no required local settings and the example reports each configured local key. |
| CSI-845 — catalog configuration | **IMPLEMENTED** | `8647ab6` | Tests passed for a catalog outside the app directory, unreachable-source warning without crash, cached fallback, deterministic later-source override, and visible staleness. `docs/DECISION-catalog-distribution.md` records the unresolved deployment ownership decision as BLK-006. |
| CSI-843 — LabVIEW Developer launch | **CONSTRUCTED-UNVERIFIABLE** | `3eeace3` | Tests passed for the exact command path containing `Builds\GUI Application`, the three literal argv values, POSIX degradation, required fields, and missing resolved executable. No Windows/LabVIEW runtime exists on this host. |
| CSI-847 — LabVIEW EPICS launch | **CONSTRUCTED-UNVERIFIABLE** | `f987420` | Tests passed for the distinct two-argument order (`zoneSymbol`, then `guiName`), path construction, required fields, and missing executable. No Windows/LabVIEW runtime exists on this host. |
| CSI-844 — Phoebus server mode | **CONSTRUCTED-UNVERIFIABLE** | `2f32f62` | Tests passed for ensure-server/open-resource argv, a real local TCP listener probe, one server spawn under concurrent launch calls, dead-owned-process recreation, and duplicate-start refusal while an owned process is alive. No Phoebus executable or JAR was found. |
| CSI-848 — Phoebus settings and panels | **CONSTRUCTED-UNVERIFIABLE** | `6115d77` | Tests passed with `-settings` present only on server creation across three opens; filesystem and HTTP(S) resources resolve; `?app=` is configurable; no literal quote characters are inserted. Site app names and an executable remain unavailable. |
| CSI-849 — alarm three-panel layout | **BLOCKED** | `4c9fe44` | `-layout <path>` construction and startup-only refusal are unit-tested. BLK-002 requires a human-saved `.memento`; BLK-003 requires site app names from `phoebus -list`. Three sequential resources cannot guarantee panel placement or sizing. |
| CSI-850 — web launch | **IMPLEMENTED** | `e817b60` | Unit tests passed for Electron `shell.openExternal`, launch-time revalidation, and rejection of `javascript:`, `file:`, `data:`, and protocol-relative inputs. A live Electron click handed `https://example.invalid/operator?mode=read` to a controlled `xdg-open`; the row state became `HANDOFF`. |
| CSI-851 — navigation UI | **IMPLEMENTED** | `7acba20`, `ca97f74`, `6600056` | Under Xvfb, Electron reached `document.readyState=complete`, rendered 19 rows and seven headings, filtered Cameras to 3 rows, searched Camera Manager to 2 rows, opened the accessible combobox, and retained one `overflow:auto` table region at 1024×680. Four current screenshots are in `deployment/TESTZ/evidence-screenshots/`. |
| CSI-852 — launch errors | **IMPLEMENTED** | `54ee01a`, `6600056` | Tests passed for missing typed settings, missing LabVIEW executables, missing Phoebus executable, listener timeout, and redacted structured failure logs. A live bad-target click displayed `Configured command does not exist: /mnt/data/jireks-work/Jireks-Task-FULL/Launcher/eli-hmi-launcher-final/eli-hmi-launcher/examples/launchers/does-not-exist.sh`; its dismiss button hid and cleared the banner. |
| CSI-853 — running GUI monitoring and REST registration | **BLOCKED** | `ca97f74` | The local registry, stable process identity, PID-reuse detection, fake-clock reconciliation, stale-state marking, IPC, and renderer state column passed tests. Browser targets are modeled as external handoffs; Phoebus is modeled as shared-server reachability, not one PID per panel. REST registration remains blocked by BLK-001. |
| CSI-854 — access and launch restrictions | **BLOCKED** | `96058e1` | Main-process policy tests passed for singleton and one-writer readings, block/prompt/focus outcomes, fail-closed stale state, trusted configured override, and same-entry launch serialization. Site enforcement remains blocked by BLK-001, BLK-004, BLK-005, and BLK-010. |

**Count read from the table:** 5 IMPLEMENTED, 4 CONSTRUCTED-UNVERIFIABLE, 3 BLOCKED.

### Final command record

`npm ci` did not finish on this host. Its npm debug log records:

```text
http fetch GET https://registry.npmjs.org/serialize-error/-/serialize-error-7.0.1.tgz attempt 1 failed with EAI_AGAIN
npm error Exit handler never called!
[npm ci exit status: 1]
```

The archive-supplied dependency tree was restored after that failed network install. The remaining required commands produced:

```text
$ npm test
# tests 123
# pass 120
# fail 0
# skipped 3
[exit status: 0]

$ npm run typecheck
[exit status: 0]

$ npm run build
17 main modules transformed; main bundle emitted
1 preload module transformed; preload bundle emitted
8 renderer modules transformed; renderer bundle emitted
[exit status: 0]

$ npm run validate-config
OK  config/launcher.yaml
entries: 19; unique ids: 24; catalog stale: false
[exit status: 0]

$ npm run validate-config -- examples/launcher.full.yaml
OK  examples/launcher.full.yaml
entries: 11; unique ids: 16; catalog stale: false
[exit status: 0]

$ npm run verify
# tests 123
# pass 120
# fail 0
# skipped 3
build and both config validations emitted exit 0
[exit status: 0]
```

`.github/workflows/ci.yml` is unchanged and still runs `npm ci` followed by `npm run verify`. Remote CI for these local commits was not observed; this host cannot resolve the npm registry, and the commits were not pushed.

### Live application record

The required Electron launch path was executed under Xvfb:

```text
$ npm start -- --noSandbox --remoteDebuggingPort 9222
renderer readyState: complete
rows: 19
count: 19 of 19 GUIs shown
Cameras filter: 3 of 19 GUIs shown
Camera Manager search: 2 of 19 GUIs shown
mock log: 2026-07-28 10:08:28 Mock launch: L4 CIS VCS
```

Observed error behavior:

```text
Launch failed: Smoke Missing Target — Configured command does not exist: /mnt/data/jireks-work/Jireks-Task-FULL/Launcher/eli-hmi-launcher-final/eli-hmi-launcher/examples/launchers/does-not-exist.sh
```

The dismiss control hid and cleared the error. At a 1024×680 viewport, `body` remained non-scrolling and the table panel retained `overflow:auto`.

### Major design decisions

| decision | confidence | basis |
|---|---|---|
| Local settings are optional until an item references them; errors name the local key and item id. | high | Prevents unused machine configuration from bricking the launcher while rejecting unresolved launch inputs before spawn. |
| Catalog sources are applied in declared order; later sources override duplicate ids with a warning and source attribution. | moderate | Supports layered emergency overrides, but maintainers still own the authoritative distribution decision. |
| LabVIEW Developer and EPICS arguments use separate builders. | high | Their argument counts and orders differ; sharing only path helpers avoids accidental semantic coupling. |
| On POSIX, LabVIEW paths use native joining and make no claim to map Windows drives. | high | This permits deterministic tests without fabricating a Windows filesystem. |
| Phoebus reuse combines a localhost TCP probe, launcher-owned PID state, and a per-port creation lock. | high for duplicate prevention; moderate for identifying an externally started listener | A TCP listener proves reachability but not process identity. |
| Phoebus settings are passed only on server creation. | high | Re-passing them on resource opens would re-import settings. |
| Three sequential Phoebus resource opens are not accepted as a layout replacement. | high | They do not specify placement, dimensions, or focus. |
| Web HMIs remain external-browser handoffs rather than embedded BrowserViews. | moderate | It preserves OS browser/session/certificate ownership and avoids adding another renderer surface. |
| A process is `RUNNING` only when PID and stable start identity still match. | high | PID-only checks cannot detect reuse. |
| Browser and Phoebus runtime states are explicit non-PID models. | high | A browser tab and a Phoebus panel do not map one-to-one to launcher child PIDs. |
| REST no-op operations report `disabled`, never success. | high | No API contract exists. |
| Unknown or stale policy state fails closed; any override must come from trusted main-process configuration. | high | Renderer-only or implicit overrides would bypass the restriction at the enforcement boundary. |

## Current-host verification

Produced on a later host. Nothing in this section is inferred from the
previous host's record.

### Environment

| item | value |
|---|---|
| OS | Ubuntu 24.04.4 LTS, kernel 6.18.5, x86_64 |
| Node / npm | v22.22.2 / 10.9.7 |
| Electron | 40.10.0 (Chromium 144.0.7559.236) |
| account | root (uid 0); a non-root account was also used, see below |
| display | Xvfb :99, 1280x900x24 |

### Section 0 on this host

| step | result | basis |
|---|---|---|
| 1. Start the local EPICS mockup IOC | **NOT AVAILABLE** | The handoff archive contains no IOC image and no `laser-mockup-ioc-image.zip`. `softIoc`, `caget`, and `camonitor` were not run here and no claim is made about them. |
| 2. Locate the HMI Python API | **NOT AVAILABLE** | No `.py` files and no contract in the archive. |
| 3. Wire the launcher to the Python API | **NOT REACHED** | Step 2 did not succeed. |
| 4. Fall through to launcher tickets | **REACHED** | Continuation work stayed on evidence-backed launcher tasks. |

The previous host's `caget`/`camonitor` output remains that host's evidence only.

### Archive and repository integrity

```text
sha256sum -c SHA256SUMS.txt   -> 491 OK, 0 failed
git fsck --full               -> [exit status: 0], no output
git rev-parse HEAD            -> b24cc6ce36364959867333a7c309926477b71e56
git rev-list --count HEAD     -> 15
git status --short            -> clean
```

### Required commands, as run here

```text
$ npm ci
added 134 packages, and audited 135 packages in 29s
found 0 vulnerabilities
[exit status: 0]

$ npm test
# tests 123
# pass 120
# fail 0
# skipped 3
[exit status: 0]

$ npm run typecheck
[exit status: 0]

$ npm run build
17 main modules transformed; 1 preload module; 8 renderer modules
[exit status: 0]

$ npm run validate-config
OK  config/launcher.yaml
entries: 19
[exit status: 0]

$ npm run validate-config -- examples/launcher.full.yaml
OK  examples/launcher.full.yaml
entries: 11
[exit status: 0]

$ npm run verify
# tests 123
# pass 120
# fail 0
# skipped 3
build and both config validations emitted exit 0
[exit status: 0]
```

`npm ci` succeeded here. That resolves the previous host's dependency-install
limitation only; it is not evidence of runtime behavior and moved no ticket
between buckets. `package-lock.json` was unmodified by it (`git status --short`
was clean immediately afterwards).

### The three skipped tests

Tests 85-87 in `tests/launch-validation.test.ts` skip when `process.getuid()`
returns 0, because root bypasses POSIX permission bits. Re-running the same
suite as a non-root account executed them:

```text
$ su <non-root-account> -c "npm test"
# tests 123
# pass 123
# fail 0
# skipped 0
[exit status: 0]

ok 85 - command paths below an inaccessible directory are rejected
ok 86 - working directories must be traversable
ok 87 - folder targets must be readable and traversable
```

### Live application record on this host

The built `out/` bundle was run under Xvfb and driven over the Chrome DevTools
Protocol, so each item below is an assertion on renderer state rather than a
visual impression.

```text
renderer readyState : complete
rows                : 19
headings            : Name, Technology, Section, Platform, RMC, State, Note
search "Camera Manager" : 2 of 19 GUIs shown   (reset -> 19 of 19)
Technology = Cameras    : 3 of 19 GUIs shown
combobox open           : aria-expanded false -> true; listbox hidden -> false
mock launch             : /tmp/eli-hmi-launcher-mock.log
                          2026-07-28 11:39:02 Mock launch: L4 CIS VCS
missing target          : banner role="alert"
                          Launch failed: Smoke Missing Target - Configured command
                          does not exist: <resolved path>/does-not-exist.sh
dismiss                 : banner hidden=true and text cleared
web target              : xdg-open called with https://example.invalid/operator?mode=read
runtime state (process) : unobserved -> STOPPED ("process does not exist")
runtime state (web)     : handed-off, model external-handoff,
                          runningInstances 0, totalInstances 1
viewport 1024x680       : documentScrolls false; html/body overflow-y hidden;
                          one scrolling region, section.table-panel (1008 > 528)
```

The web and missing-target rows came from a smoke config held outside the
repository; it contains no site data and was not committed.

### Changes made on this host

| ticket | commit | change |
|---|---|---|
| CSI-851 | `e114dda` | The combobox control reused its mount element's id, so `technology-filter` and `section-filter` each appeared twice in the rendered DOM. Ids are now derived by `deriveComboboxIds()` and namespaced under the mount id. Checked after rebuild: no duplicate ids; computed accessible name unchanged at `Technology Select`; listbox still opens; Cameras still filters to 3 of 19. |
| CSI-854 | `38a2794` | The launch IPC handler reported and logged `ok: true` unconditionally after the access policy resolved, including on a `launched: false` focus outcome. `describeUnperformedLaunch()` now names that outcome and the handler returns a failure before the success log. Focus is still not claimed to work; BLK-010 stays open. The path is unreachable today because main never injects `focusExisting`. |

After both changes:

```text
$ npm test
# tests 129
# pass 126
# fail 0
# skipped 3
[exit status: 0]

$ npm run typecheck
[exit status: 0]

$ npm run build
[exit status: 0]
```

### Bucket outcome on this host

No ticket changed bucket. No Windows/LabVIEW host, Phoebus site build, HMI
Python API, alarm memento, or maintainer answer became available, so the
CONSTRUCTED-UNVERIFIABLE and BLOCKED entries keep their previous
classification. The count read from the ticket ledger is unchanged:
**5 IMPLEMENTED, 4 CONSTRUCTED-UNVERIFIABLE, 3 BLOCKED**.

For CSI-850, CSI-851, and CSI-852 the requested behavior was observed on this
host as well as the previous one; the table above is the current-host evidence
for those rows.

### Design decisions made on this host

| decision | confidence | basis |
|---|---|---|
| Combobox element ids are namespaced under the mount id rather than reusing it. | high | Two elements sharing one id is invalid HTML and made `getElementById(<mount id>)` resolve to the wrapper. The accessible name was measured before and after and is unchanged. |
| A policy outcome that launched nothing is reported as a failure naming the reason, not as a launch. | moderate | It keeps the launch record honest and stays fail-closed. Moderate rather than high because a future supported focus mechanism may warrant a third outcome instead of a failure, which is a decision for whoever answers BLK-010. |
| The committer identity for this session differs from the previous host's. | high | It keeps current-host authorship distinguishable in `git log`. |

## IOC and HMI API workstation verification

Produced on a third host on 2026-07-29. Nothing in this section is inferred
from either earlier host's record.

### Environment

| item | value |
|---|---|
| OS | Debian, kernel 6.1.0-43-amd64, x86_64 |
| account | `vijtus`, uid 1000 |
| Node / npm | v24.14.1 / 11.11.0 |
| Docker | 29.2.1 |
| launcher branch / HEAD | `main` / `6d597ee128ff46903567d1b39558e6599a61e9be` |

### Section 0 on this host

| step | result | basis |
|---|---|---|
| 1. Start the local EPICS mockup IOC | **RUNNING** | The supplied ZIP's SHA-256 passed. Docker image `laser-mockup-ioc:ready` loaded and logged `iocRun: All initialization complete` under host networking. |
| 2. Locate the HMI Python API | **FOUND** | Sibling checkout `eli-eric/eli-hmi`, canonical branch `dev`, contains `backend/python-websocket-server`, a FastAPI + aioca EPICS gateway. The tested checkout was at `62055331b5867526eed61df496a99cb0c178a54d`; its backend has no diff from `dev` at `53e83cd28cc5d3073e0e32778f87232361848f75`. |
| 3. Run the Python API against the local IOC | **REACHED** | The API returned HTTP 200 and value `32.0` from the mock IOC. The launcher was not wired to this gateway because its existing HMI API interface is for launcher lifecycle registration, which this gateway does not expose. |
| 4. Fall through to launcher tickets | **REACHED** | The inherited launcher suite and configs were reproduced; no ticket implementation was changed. |

Required Channel Access proof:

```text
$ caget -w 5 L4-NSOPCPA-NL1:TK6:44:DisplayTemperature
L4-NSOPCPA-NL1:TK6:44:DisplayTemperature 32
[exit status: 0]

$ camonitor L4-NSOPCPA-NL1:SY3PL50M:32:State
L4-NSOPCPA-NL1:SY3PL50M:32:State <undefined> OFF UDF NO_ALARM
[stopped after the initial value; exit status: 124]
```

The host did not have CA client commands installed, so both commands were run
from the supplied image on the same host network with
`EPICS_CA_AUTO_ADDR_LIST=NO` and `EPICS_CA_ADDR_LIST=127.0.0.1`.

### HMI Python API measurement

The production Dockerfile could not reach its company-only Harbor base image
(`10.2.0.45:443` timed out). The pinned requirements were instead installed in
an isolated workspace virtualenv, and the source was run unchanged on
`127.0.0.1:8000`.

| phase | samples | p50 | p95 |
|---|---:|---:|---:|
| cold CA search/connect | 30 | 31.713 ms | 31.885 ms |
| post-connect CA read | 30 | 0.340 ms | 0.396 ms |
| warm aioca read | 30 | 0.250 ms | 0.302 ms |
| warm aioca write | 20 | 0.057 ms | 0.078 ms |
| serialization plus JSON | 1000 | 0.0169 ms | 0.0174 ms |
| HTTP health-route baseline | 30 | 1.340 ms | 1.977 ms |
| HTTP EPICS read end to end | 30 | 2.284 ms | 2.682 ms |
| HTTP EPICS write end to end | 20 | 1.971 ms | 2.382 ms |

The write measurement performed 20 direct aioca and 20 HTTP API writes of the
existing value `0` to the documented mock record
`L4-NSOPCPA-NL1:PS5059:22:SetTriggeringDelay`. A `caget` returned `0` before
and after. No production latency target or slow production request was
available, so no optimization was made.

The gateway implements EPICS reads, monitors, and writes. It does not implement
the launcher's lifecycle `register`, `heartbeat`, `deregister`, or `query`
contract. BLK-001 is narrowed to that missing ownership and contract rather
than closed.

### Launcher command record

```text
$ npm ci
added 134 packages
[exit status: 0]

$ npm test
# tests 129
# pass 129
# fail 0
# skipped 0
[exit status: 0]

$ npm run typecheck
[exit status: 0]

$ npm run build
17 main modules transformed; 1 preload module; 8 renderer modules
[exit status: 0]

$ npm run validate-config
OK  config/launcher.yaml
entries: 19; unique ids: 24; catalog stale: false
[exit status: 0]

$ npm run validate-config -- examples/launcher.full.yaml
OK  examples/launcher.full.yaml
entries: 11; unique ids: 16; catalog stale: false
[exit status: 0]

$ npm run verify
# tests 129
# pass 129
# fail 0
# skipped 0
typecheck, build, and both config validations emitted exit 0
[exit status: 0]
```

### Live launcher record

The launcher was started under Xvfb with a local DevTools port. Renderer state
was read through the DevTools protocol:

```text
readyState : complete
title      : L4 Launcher
rows       : 19
headings   : Name, Technology, Section, Platform, RMC, State, Note
count text : 19 of 19 GUIs shown
mock click : L4 CIS VCS
mock log   : 2026-07-29 16:10:18 Mock launch: L4 CIS VCS
```

### Bucket outcome on this host

The EPICS test bench and EPICS gateway became available, but no Windows with
LabVIEW, site Phoebus build, alarm memento, launcher lifecycle registration
contract, or maintainer policy answer became available. No ticket changed
bucket. The count read from the ticket ledger remains **5 IMPLEMENTED,
4 CONSTRUCTED-UNVERIFIABLE, 3 BLOCKED**.

### Design decisions made on this host

| decision | confidence | basis |
|---|---|---|
| Do not optimize the EPICS gateway from the local benchmark alone. | high | Warm HTTP reads measured 2.284 ms p50 and 2.682 ms p95 against a local 89-record scalar mock, while no production latency target or slow production trace was supplied. |
| Treat the EPICS gateway and launcher lifecycle registration API as separate contracts until an owner says otherwise. | high | The discovered source exposes PV read/write/monitor endpoints but no launcher registration, heartbeat, deregistration, or discovery endpoints. |

## Executable local-contract workstation

Produced on a fourth host on 2026-08-04. This section records the behavior
executed here and keeps local contract evidence separate from unresolved site
claims.

### Environment and Section 0

| item | value |
|---|---|
| OS / account | Debian, x86_64; `vijtus`, uid 1000 |
| Node / npm / Electron | v24.14.1 / 11.11.0 / 40.10.0 |
| IOC | `laser-mockup-ioc:ready`, Docker host networking |
| Phoebus | locked ORNL 4.7.4-SNAPSHOT build dated 2026-07-20 |
| Java | locked Temurin JDK 25.0.3 |
| display | isolated Xvfb :91, 1280x900x24, JWM |

The required Channel Access checks were repeated by the acceptance runner from
the IOC image on the host network:

```text
$ caget -w 5 L4-NSOPCPA-NL1:TK6:44:DisplayTemperature
L4-NSOPCPA-NL1:TK6:44:DisplayTemperature 32
[exit status: 0]

$ camonitor L4-NSOPCPA-NL1:SY3PL50M:32:State
L4-NSOPCPA-NL1:SY3PL50M:32:State <undefined> OFF UDF NO_ALARM
[stopped after the initial value; exit status: 124]
```

### Ticket ledger on this host

| ticket | bucket | evidence observed here |
|---|---|---|
| CSI-843 — LabVIEW Developer launch | **CONSTRUCTED-UNVERIFIABLE** | The exact `Common/ELI/IOCs/Camera IOC/Builds/GUI Application/Developer Contract.exe` path ran as a POSIX fixture through Electron. Its NUL-delimited receipt preserved the three literal argv fields, including shell metacharacters, and the row became `RUNNING`. NI LabVIEW and Windows were not executed. |
| CSI-844 — Phoebus server mode | **IMPLEMENTED** | Electron started the locked Phoebus product JAR once on port 14918, applied the startup settings/layout argv, reused that listener for three resource launches, and rendered the rows as `SHARED`. The runner identified and stopped the owned Java listener and proved the port closed. |
| CSI-845 — catalog configuration | **IMPLEMENTED** | The inherited executable catalog tests remain green; no site distribution decision was inferred. |
| CSI-846 — local machine configuration | **IMPLEMENTED** | `tests/acceptance/config/launcher.yaml` joined workspace, CSS root, Phoebus, lifecycle, monitoring, and both command allow-list roots. The real parser reported 5 rows, 1 action, 6 unique ids, and 2 restricted launches. |
| CSI-847 — LabVIEW EPICS launch | **CONSTRUCTED-UNVERIFIABLE** | The exact `Common/ELI/EPICS_GUIs/Operator Panels/Builds/GUI Application/EPICS Contract.exe` POSIX fixture ran through Electron with the distinct `[zoneSymbol, guiName]` argv and reached `RUNNING`. NI LabVIEW and Windows were not executed. |
| CSI-848 — Phoebus settings and panels | **IMPLEMENTED** | Real `-list` output contained `display_runtime`, `alarm_tree`, `alarm_table`, and `alarm_area`. One audited server argv carried `-settings`; three audited follow-up argv omitted it and opened `temperature.bob`, `state.bob`, and `flow.bob`. Native window titles were observed after each open. The tracked live screenshot shows chiller flow `4.435`, level `65`, and supply temperature `23.50`. |
| CSI-849 — alarm three-panel layout | **BLOCKED** | The locked Phoebus runtime saved a real memento containing `alarm_tree`, `alarm_area`, and `alarm_table`, and a fresh process restored the three measured stages. `No Alarm Server Connection` is expected locally. The site-created memento, site application names, and alarm backend remain BLK-002/BLK-003. |
| CSI-850 — web launch | **IMPLEMENTED** | Existing web launch tests remained green; this local-contract run did not replace the earlier live browser-handoff evidence. |
| CSI-851 — navigation UI | **IMPLEMENTED** | The combined launcher rendered five rows with the seven expected columns; both fixtures showed `RUNNING` and all three BOB rows showed `SHARED`. `deployment/TESTZ/evidence-screenshots/07-local-acceptance-launcher.png` records the state. |
| CSI-852 — launch errors | **IMPLEMENTED** | Existing typed diagnostic and redaction tests remained green; the acceptance run added no site values or weakened failure handling. |
| CSI-853 — running GUI monitoring and REST registration | **BLOCKED** | A real HTTP adapter and coordinator registered six local runtime records with the loopback FastAPI sidecar, reported `hmiApi.status=connected`, heartbeated them, and left zero entries after graceful Electron quit. The executable version-1 sidecar is local-only; BLK-001 still asks for the site owner and contract. |
| CSI-854 — access and launch restrictions | **BLOCKED** | The local sidecar granted/conflicted/released reservations across two independent adapters. The standalone production-module smoke separately exercised singleton and writer denials; the Electron run exercised constrained first-launch reservation and commit, not an IPC denial. BLK-004/BLK-005 still define the missing site write-mode signal and intended rule. |

**Count read from this table:** 7 IMPLEMENTED, 2 CONSTRUCTED-UNVERIFIABLE,
3 BLOCKED.

### Local acceptance record

`npm run acceptance:local` exited 0 and wrote ignored run evidence below
`.local/acceptance/20260804T111826Z.jkeH32/`. The runner performed these checks
in one owned-resource lifecycle:

1. Reused and verified the matching IOC container, then ran the two required CA
   commands.
2. Started the loopback lifecycle sidecar and passed its grant/conflict,
   registration/query, and deregistration smoke.
3. Started the built Electron launcher with the combined config and issued six
   production IPC launches: alarm layout first, both LabVIEW fixtures, then the
   three BOB displays.
4. Observed lifecycle registration for all six ids, exact LabVIEW PID/argv
   receipts, exact Phoebus argv, launcher runtime states, and a PNG capture.
5. Closed Electron through its renderer, observed an empty lifecycle query,
   stopped run-owned processes only after their PID/start-identity receipts
   matched, restored the tracked memento in a fresh Phoebus process, asserted
   all three native alarm window titles, captured it, and closed its listener.

The tracked visual evidence is:

- `deployment/TESTZ/evidence-screenshots/05-local-phoebus-live.png`
- `deployment/TESTZ/evidence-screenshots/06-local-alarm-layout-restored.png`
- `deployment/TESTZ/evidence-screenshots/07-local-acceptance-launcher.png`

### Command record

```text
$ npm test
# tests 156
# pass 156
# fail 0
# skipped 0
[exit status: 0]

$ npm run typecheck
[exit status: 0]

$ npm run build
18 main modules transformed; 1 preload module; 8 renderer modules
[exit status: 0]

$ PYTHONPATH=<handoff FastAPI site-packages> /usr/bin/python3 -m pytest tests/acceptance/fixtures/lifecycle-api/tests
14 passed, 1 deprecation warning
[exit status: 0]

$ npm run validate-config -- tests/acceptance/config/phoebus.yaml
3 entries; 1 action; 4 unique ids
[exit status: 0]

$ npm run validate-config -- tests/acceptance/config/launcher.yaml
5 entries; 1 action; 6 unique ids
[exit status: 0]

$ npm run acceptance:local
Local acceptance passed.
[exit status: 0]

$ npm run verify
# tests 156; # pass 156; # fail 0; # skipped 0
typecheck, build, and both bundled config validations emitted exit 0
[exit status: 0]
```

### Design decisions made on this host

| decision | confidence | basis |
|---|---|---|
| Keep the executable lifecycle sidecar separate from the EPICS read/write gateway and label its wire contract local-only. | high for separation; moderate for the version-1 shape | The measured gateway has no lifecycle routes. The local shape is executable but has no site-owner approval. |
| Use atomic server-side reservations, short leases, sequenced idempotent mutations, and fail-closed unavailable state in the local lifecycle contract. | high | Query-then-spawn races across launchers; leases recover abandoned sessions; tests and a live HTTP smoke exercised conflict and cleanup. |
| Convert filesystem resources to `file:` URIs before adding Phoebus `app` query parameters. | high | The real runtime treated a query appended directly to a filesystem path as part of the filename. |
| Delay the first resource request for 8000 ms after this locked Phoebus listener appears; apply the same conservative delay to cross-process reuse and skip it for known-ready owned reuse. | high for this build; unknown for the site build | The real TCP listener accepted a request before JavaFX installed its resource handler, and another launcher cannot know when an external listener started. The delay is configured only in local acceptance. |
| Treat POSIX `.exe` fixtures as launch-contract evidence and not LabVIEW runtime evidence. | high | They prove path/argv/spawn/registry/policy behavior but contain no NI code. |
| Treat the locally saved memento as mechanism evidence and not the site alarm layout. | high | It uses a local alarm root with no alarm server and no site maintainer approval. |

No commit was pushed, no pull request was opened, and no remote CI result was
created by this workstation run.

## Post-delivery defect fix session

Produced on 2026-08-04 on the same Debian workstation as the "Executable
local-contract workstation" section, in a later session. It records three narrow
fixes to the defects that `AGENT-PROMPT.md` lists as deliberately left unfixed.
No site input became available, so no ticket changed bucket.

### Environment

| item | value |
|---|---|
| OS / account | Debian, kernel 6.1.0-43-amd64, x86_64; `vijtus`, uid 1000 |
| Node / npm / Electron | v24.14.1 / 11.11.0 / 40.10.0 |
| IOC / Phoebus / JDK | `laser-mockup-ioc:ready`; locked Phoebus 4.7.4-SNAPSHOT; locked Temurin JDK 25.0.3 (cached from the prior session) |

Section 0 was re-proven by the acceptance runner from the IOC image on the host
network:

```text
$ caget -w 5 L4-NSOPCPA-NL1:TK6:44:DisplayTemperature
L4-NSOPCPA-NL1:TK6:44:DisplayTemperature 32
[exit status: 0]

$ camonitor L4-NSOPCPA-NL1:SY3PL50M:32:State
L4-NSOPCPA-NL1:SY3PL50M:32:State <undefined> OFF UDF NO_ALARM
[stopped after the initial value; exit status: 124]
```

### Changes made in this session

| defect (AGENT-PROMPT.md) | ticket | commit | change |
|---|---|---|---|
| #1 bare PID liveness | CSI-844 | `ef0d397` | `PhoebusServerManager` captures the server start identity via the shared `inspectProcess` dependency after spawn and compares it on each liveness check, replacing `process.kill(pid, 0)`. Indeterminate identity falls back to existence so a needed server is never wrongly refused. `SpawnReceipt.startIdentity` added; the `isProcessAlive` injection point is unchanged. Six unit cases added. |
| #2 `ps -o lstart=` granularity | CSI-853 | `1b7cb79` | Non-Linux POSIX identity adds `comm` (`ps -o lstart= -o comm=`) so a PID reused by a different executable is detected; the same-second/same-executable limitation is documented. New `tests/process-inspector.test.ts` forces the `ps` path. |
| #3 `run.sh` install | infra | `e14d3b4` | `npm install` → `npm ci`, matching `.github/workflows/ci.yml` and work order section 7. |

### Command record

The as-delivered tree was reproduced first, then the fixes were applied and the
suite plus acceptance were re-run.

```text
$ npm ci
added 134 packages; package-lock.json unmodified
[exit status: 0]

$ npm test            # after the three fixes
# tests 165
# pass 165
# fail 0
# skipped 0
[exit status: 0]

$ npm run typecheck
[exit status: 0]

$ npm run build
18 main modules transformed; 1 preload module; 8 renderer modules
[exit status: 0]

$ PYTHONPATH=<handoff venv site-packages> python3 -m pytest tests/acceptance/fixtures/lifecycle-api/tests
14 passed, 1 deprecation warning
[exit status: 0]

$ npm run verify
# tests 165; # pass 165; # fail 0; # skipped 0
typecheck, build, and both config validations emitted exit 0
[exit status: 0]

$ npm run acceptance:local   # run as delivered, and again after the fixes
Local acceptance passed.
[exit status: 0]
```

The post-fix acceptance run wrote ignored evidence under
`.local/acceptance/20260804T122913Z.VXU58g/`. Its `summary.json` records
`cagetExitStatus: 0`, `camonitorExitStatus: 124`, six production launch IPC calls
with lifecycle deregistration, one reused Phoebus server exposing each BOB native
title, and the provenance-matched memento restoring all three native alarm window
titles. This is the evidence that the Phoebus liveness change did not regress live
server reuse.

### Bucket outcome on this host

No Windows/LabVIEW host, site Phoebus build, HMI lifecycle registration contract,
site alarm memento, or maintainer answer became available. The three fixes are
code-quality corrections and moved no ticket between buckets. The count read from
the "Executable local-contract workstation" ticket ledger is unchanged:
**7 IMPLEMENTED, 2 CONSTRUCTED-UNVERIFIABLE, 3 BLOCKED**.

### Design decisions made in this session

| decision | confidence | basis |
|---|---|---|
| Phoebus owned-server liveness compares OS start identity, mirroring `runtime-registry.ts`, and falls back to existence when identity is indeterminate. | high | It removes the PID-reuse refusal hazard without adding a failure mode; the live acceptance reuse path was re-observed passing. |
| Non-Linux POSIX identity adds `comm`, but the same-second/same-executable case stays a documented limitation rather than an invented guarantee. | high for the different-executable case; explicit limitation otherwise | `ps` start time is whole-second and no portable sub-second source exists, while Linux and Windows already use finer identity. |

No commit was pushed, no pull request was opened, and no remote CI result was
created in this session.

## Realistic local Phoebus panel session

Produced on 2026-08-06 on the same Debian workstation. This session turns the
three minimal BOB connectivity fixtures into a locally executable operator-style
mock. It does not claim ELI visual approval, site alarm connectivity, or
test-zone acceptance.

### IOC and panel coverage

The exact `/usr/EPICS/db/laser.db` was streamed from the supplied
`laser-mockup-ioc:ready` image. It contains 89 records. The three BOB resources
now expose 84 distinct records; four internal fanout/helper records and the
unused combined unit-22 delay command are deliberately omitted. Structured PVs
use a display-local `CP=L4-NSOPCPA-NL1` macro.

The supplied database was observed with two local-acceptance defects:

1. Static input records seeded with `VAL` remained UDF until first processing.
2. `SetFlashlamps` used `FLNK` instead of transferring its selected value to
   `FlashlampsCMD`, and `FlashlampsCMD2` had no closed-loop source. A RUN request
   changed `SetFlashlamps` but left the 14 state records at STANDBY.

`tests/acceptance/phoebus/prepare-mock-ioc.sh` now processes the static records and
repairs `SetFlashlamps.OUT`, `FlashlampsCMD2.DOL`, and
`FlashlampsCMD2.OMSL` in IOC memory. It logs every write and does not modify the
ZIP or image. Its postconditions observed here were:

```text
AI_NL2_CHILLER_13_LEVEL        45 LOW MINOR
SI_NL2_FL_22_CH1               STANDBY
SI_NL2_FL_28_CH2               STANDBY
Local mock IOC preparation passed.
```

### Live behavior observed

The locked Phoebus 4.7.4-SNAPSHOT runtime parsed and displayed all three BOBs
against the native `softIoc` binary extracted from the supplied image. The
following writes were performed through the visible Phoebus widgets, not with
direct `caput`, and the displayed/CA readbacks followed:

```text
all 14 legacy flashlamps       STANDBY -> RUN -> STANDBY
PS5059:22 channel-1 state      STANDBY -> RUN -> STANDBY
PS5059:22 channel-1 delay      50 -> 77 -> 50
```

Electron then loaded `tests/acceptance/config/phoebus.yaml`, started one locked Phoebus
server on port 14918, and opened `temperature.bob`, `state.bob`, and `flow.bob`.
The invocation audit contained one server/settings call and three resource
calls; all three launcher rows rendered `SHARED`. Visual evidence is tracked as
`deployment/TESTZ/evidence-screenshots/08-local-realistic-overview.png` through
`11-local-realistic-launcher.png`.

### Command record

```text
$ npm run verify
# tests 165
# pass 165
# fail 0
# skipped 0
build, four config validations, and Phoebus asset smoke passed
[exit status: 0]
```

The Docker daemon was inactive and requires an interactive sudo password on
this workstation, so the container-orchestrated `npm run acceptance:local` was
not repeated. Its new Docker-mode mock-preparation hook passed shell/static
validation, and its `docker exec` argument path was exercised through a
container-compatible harness against the same native IOC. The launcher/Phoebus
behavior was then executed against the image's native EPICS binaries. This
limitation does not replace the earlier 2026-08-04 container acceptance record.

### Bucket outcome

CSI-844 and CSI-848 remain IMPLEMENTED with stronger local evidence. CSI-849
still requires the approved ELI/test-zone layout and alarm configuration; a
local mock does not supply that approval. The overall count remains **7
IMPLEMENTED, 2 CONSTRUCTED-UNVERIFIABLE, 3 BLOCKED**. The internal GitLab
project/branch for site panel ownership is not present in this checkout.
