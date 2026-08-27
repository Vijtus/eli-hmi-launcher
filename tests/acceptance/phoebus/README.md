# Local Phoebus acceptance environment

This directory installs and drives the generic Linux Phoebus build used for
local Phoebus acceptance. It does not supply ELI's site build, alarm service,
application configuration, or saved site layout.

## Install

```sh
tests/acceptance/phoebus/bootstrap.sh
tests/acceptance/phoebus/self-test.sh
tests/acceptance/phoebus/capture-app-list.sh
```

The bootstrap downloads the official ORNL `phoebus-linux.zip` and Temurin JDK
25 archives into ignored `.local/phoebus/` storage. `artifacts.lock` pins the
observed byte sizes and SHA-256 digests because the source URLs are mutable
nightly aliases. A cached or freshly downloaded mismatch is rejected.

`--refresh-lock` is an explicit trust-boundary operation: it downloads the
current aliases and replaces `artifacts.lock`. Review that diff before using or
committing it. `--reinstall` preserves a mismatched prior runtime as a dated
`.previous.*` directory before installing the locked artifacts.

The tracked `phoebus.sh` invokes the extracted `product-*.jar` directly and in
the foreground. The upstream script is deliberately not used because it adds
`-server 4918` and backgrounds Java. Set `ELI_PHOEBUS_ARGV_AUDIT_DIR` to an
output directory when exact NUL-delimited invocation evidence is required.

Design decisions:

- Exact digest pinning around the mutable official nightly alias: moderate
  confidence. It makes the tested bytes repeatable but still requires a
  maintainer to review each future refresh.
- Direct product-JAR execution with the bundled JDK: high confidence. The real
  three-panel run preserved the requested port/settings/resource argv and kept
  one foreground Java owner.
- Port `14918`: high confidence as a local-only acceptance value. It makes no
  statement about the unresolved site port.

## Launcher and displays

Run the launcher with `tests/acceptance/config/phoebus.yaml`. Its three entries open the
BOB files in `tests/acceptance/assets/` against the supplied mock IOC through
the settings in `tests/acceptance/config/phoebus.properties`.

The panels deliberately use a `CP=L4-NSOPCPA-NL1` display macro so the verified
local prefix is explicit and can later be replaced by test-zone configuration.
They expose 84 distinct operator-facing PVs from the image's 89-record
`laser.db`; four internal fanout/helper records and the unused combined unit-22
delay command are not presented as normal controls.

| resource | local purpose |
|---|---|
| `temperature.bob` | Laser/regenerator overview: connection, interlocks, state, measurements, and structured device errors. |
| `flow.bob` | Primary plus four legacy chillers, engineering units, level/flow visualization, and the real mock `AI_NL2_CHILLER_13_LEVEL` LOW/MINOR alarm. |
| `state.bob` | Unit-22/unit-28 state and delay controls, global mock controls, and the seven-by-two legacy flashlamp matrix. |

Every panel carries `LOCAL MOCK IOC` labeling. Readbacks use display-only
widgets. Writable widgets are limited by the asset self-test to explicit
`:SET`, `SetFlashlamps`, `SET_DELAY`, `FLASHLAMPS_RUN`, and
`FLASHLAMPS_STANDBY` command records.

### Prepare the supplied mock

The image seeds static input records with `VAL`, leaving them UDF until first
processing. Its `SetFlashlamps`/`FlashlampsCMD2` links also fail to transfer the
selected enum value through the full fanout. Prepare a running local container
before opening the panels:

```sh
tests/acceptance/phoebus/prepare-mock-ioc.sh --docker-container <container-name>
ELI_LAUNCHER_CONFIG="$PWD/tests/acceptance/config/phoebus.yaml" npm start
```

The preparation step processes the seeded readbacks, repairs three link fields
in IOC memory, initializes commands to STANDBY/50, logs every `caput`, proves
the chiller-13 LOW/MINOR alarm, and verifies both ends of the global fanout. It
does not alter the supplied ZIP or image. `npm run acceptance:local` invokes it
automatically and retains the audit as `mock-ioc-preparation.log`.

The 2026-08-06 interactive run observed these values in the real locked
Phoebus runtime:

```text
Measured flow        4.435 l/min
Measured level       65 %
Supply temperature   23.50 deg C
Chiller 13 level     45 % LOW MINOR
```

The same run used the actual BOB controls to change all 14 legacy flashlamps
from STANDBY to RUN and back, change unit-22 channel-1 delay from 50 to 77 and
back, and change its structured state from STANDBY to RUN and back. The
readbacks followed each write. Screenshots 08-10 in `deployment/TESTZ/evidence-screenshots/`
record the final restored state; screenshot 11 records the launcher with all
three resources in `SHARED` state. These are local mock observations, not site
or test-zone acceptance.

## Alarm layout

Start an isolated authoring session only with an available display:

```sh
DISPLAY=:98 tests/acceptance/phoebus/start-layout-authoring.sh
```

The script reads the installed build's real `-list` output, opens
`alarm_tree`, `alarm_area`, and `alarm_table`, and prints the exact save path.
Arrange the panels in Phoebus and select **Window → Save Layout As…**. Then run
the printed `finish-layout-authoring.sh` command. The finish step only accepts a
non-empty memento newer than that real authoring session and records its digest.

The accepted 2026-08-04 artifact is tracked as
`tests/acceptance/assets/local-alarm-layout.memento`, with its generated digest
and runtime lock in the adjacent `.provenance` file. Phoebus restored its three
stages as Alarm Tree upper-left, Alarm Area lower-left, and Alarm Table right;
`deployment/TESTZ/evidence-screenshots/06-local-alarm-layout-restored.png` records that run.
The disconnected alarm indicators are expected because this repository does
not start Kafka or a Phoebus alarm server.

Do not hand-author or copy an unrelated memento. Opening the local alarm panels
does not demonstrate a connected alarm server; the local properties name
`localhost:9092` and `CSI744_LOCAL` solely so the three UI applications share a
consistent authoring context.
