# Archived lifecycle prototype

This loopback service is retained as historical TESTZ prototype evidence. The production launcher no longer implements this unapproved wire contract.
It is separate from the `eli-hmi` EPICS read/write gateway and is not evidence
that a site lifecycle API exists or accepts this wire shape.

The deployment baseline is Python 3.12. The implementation also runs on Python
3.11 so it can be exercised on the current handoff workstation.

```sh
python -m venv .venv
.venv/bin/pip install -r deployment/TESTZ/archive/lifecycle-prototype/requirements.txt
.venv/bin/python deployment/TESTZ/archive/lifecycle-prototype/lifecycle_api.py
```

The default listener is `127.0.0.1:8765`, with API root
`http://127.0.0.1:8765/api/lifecycle/v1`. Set
`ELI_HMI_LIFECYCLE_TOKEN` to require a bearer token. A non-loopback value in
`ELI_HMI_LIFECYCLE_BIND` is refused unless that token is set.

State is deliberately in memory. Launcher entries have a 15-second server-time
lease and reservations have a 10-second lease, so a crashed client stops
blocking later launches without requiring persistent cleanup.

Version 1 exposes:

- `PUT /api/lifecycle/v1/sessions/{sessionId}/entries/{entryId}`
- `POST /api/lifecycle/v1/sessions/{sessionId}/heartbeat`
- `DELETE /api/lifecycle/v1/sessions/{sessionId}/entries/{entryId}`
- `GET /api/lifecycle/v1/entries`
- `POST /api/lifecycle/v1/reservations`
- `DELETE /api/lifecycle/v1/reservations/{reservationId}`
- `GET /api/lifecycle/v1/health/live`

Mutations carry a session sequence and operation UUID. The launcher serializes
mutations, reuses the same operation identity for transient retries, and backs
off at 1/2/4/8/15 seconds with bounded jitter. Invalid 4xx configuration is
probed every 30 seconds instead of using the fast retry path.

Local design decisions:

| decision | confidence | basis |
|---|---|---|
| Keep lifecycle coordination separate from the EPICS gateway. | high | The discovered gateway exposes PV operations and no launcher registration contract. |
| Bind loopback by default and require a token for a supported public bind. | high | Lifecycle state controls whether constrained HMIs may launch. |
| Use leases and no persistence for the local sidecar. | high | Expiry handles crashed acceptance clients without creating deployment state. |
| Use this version-1 JSON shape only for local acceptance. | moderate | It is executable and tested, but no site owner has approved it. |
| Reserve constrained launches atomically in the service. | high | Query-then-spawn alone races across two launcher processes. |

Run the service tests with:

```sh
python -m pytest deployment/TESTZ/archive/lifecycle-prototype/tests
```
