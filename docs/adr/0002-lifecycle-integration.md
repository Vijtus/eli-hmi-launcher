# ADR 0002: Shared lifecycle coordination

- Status: Accepted
- Date: 2026-08-27

## Context

TESTZ field work prototyped launcher registration, reservations, heartbeats, discovery, and cleanup against a loopback FastAPI service. The same field evidence records that the production owner, base URL, authentication scheme, endpoint paths, payloads, heartbeat/idempotency semantics, retry behavior, and unavailable behavior were not approved. The discovered EPICS gateway exposes a different contract and has no launcher lifecycle endpoints.

Keeping a production client for a service whose contract is invented locally would turn experimental infrastructure into a permanent product dependency. It would also make launch policy appear stronger than it is.

## Decision

ELI HMI Launcher does not implement a shared lifecycle REST client until an external production contract is approved. `RuntimeRegistry` is the only source of runtime state for launch policy, so instance restrictions apply to processes observed by the current launcher session.

The loopback implementation is retained under `deployment/TESTZ/archive/lifecycle-prototype/` as historical engineering evidence. It is not an acceptance fixture, supported service, configuration schema, or implied future API.

## Consequences

The launcher cannot reliably detect a constrained HMI that was started before the current launcher session or by another launcher/machine. This is an explicit deployment limitation rather than a hidden fallback.

If shared coordination becomes a requirement, reintroduce it only after the service owner supplies an approved contract. The implementation should then have contract/integration tests for reservations, liveness, cleanup, authentication, timeouts, retries, and unavailable-state policy before it enters the product path.
