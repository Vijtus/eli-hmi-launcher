# Local Phoebus acceptance environment

This directory installs and drives the generic Linux Phoebus build used for
CSI-744 local acceptance. It does not supply ELI's site build, alarm service,
application configuration, or saved site layout.

## Install

```sh
tools/phoebus-local/bootstrap.sh
tools/phoebus-local/self-test.sh
tools/phoebus-local/capture-app-list.sh
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

Run the launcher with `config/phoebus-local.yaml`. Its three entries open the
BOB files in `examples/phoebus-local/` against the supplied mock IOC through
the settings in `config/phoebus-local.properties`.

The 2026-08-04 acceptance run observed these real values in Phoebus:

```text
Measured flow        4.435 l/min
Measured level       65 %
Supply temperature   23.50 deg C
```

Those numbers are an execution observation, not fixture constants. Current IOC
values may differ on later runs.

## Alarm layout

Start an isolated authoring session only with an available display:

```sh
DISPLAY=:98 tools/phoebus-local/start-layout-authoring.sh
```

The script reads the installed build's real `-list` output, opens
`alarm_tree`, `alarm_area`, and `alarm_table`, and prints the exact save path.
Arrange the panels in Phoebus and select **Window → Save Layout As…**. Then run
the printed `finish-layout-authoring.sh` command. The finish step only accepts a
non-empty memento newer than that real authoring session and records its digest.

The accepted 2026-08-04 artifact is tracked as
`examples/phoebus-local/local-alarm-layout.memento`, with its generated digest
and runtime lock in the adjacent `.provenance` file. Phoebus restored its three
stages as Alarm Tree upper-left, Alarm Area lower-left, and Alarm Table right;
`reference-screenshots/06-local-alarm-layout-restored.png` records that run.
The disconnected alarm indicators are expected because this repository does
not start Kafka or a Phoebus alarm server.

Do not hand-author or copy an unrelated memento. Opening the local alarm panels
does not demonstrate a connected alarm server; the local properties name
`localhost:9092` and `CSI744_LOCAL` solely so the three UI applications share a
consistent authoring context.
