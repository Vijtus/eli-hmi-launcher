# Decision: HMI catalog distribution

## Decision required

The launcher now accepts an inline `entries:` list plus ordered filesystem/UNC
catalog sources. Later sources override duplicate entry ids; each override is
logged. A successful source is cached in the launcher user-data directory. If a
source is unreachable or invalid, the cache is used and the UI shows
`CATALOG STALE`; without a usable cache, that source contributes no rows and the
launcher still opens.

## Options

| Option | Operational trade-off | Failure mode |
|---|---|---|
| Per-machine catalog edited locally | No network dependency; easy initial setup. Drift is inevitable, review is weak, and workstation replacement loses local changes. | Different operators see different launchers. |
| Live shared filesystem/UNC catalog | One edit reaches every workstation. Simple with existing file-share controls. Startup and freshness depend on DNS, share availability, permissions, and file integrity. | Cache serves older entries; UI reports staleness. |
| Versioned catalog distributed to local disk by configuration management | Reviewable history, deterministic rollback, no runtime share dependency, and consistent local startup. Requires an existing deployment agent/process. | A failed deployment leaves the prior local version; deployment monitoring must detect lag. |
| HTTP catalog service | Central governance and telemetry, but introduces an API, authentication, TLS/certificate handling, retries, and another service to operate. The current filesystem loader does not implement this option. | Service outage requires the same cache semantics plus an API contract. |

## Outcome (2026-08)

A fifth option was implemented: **a versioned git configuration repository
(`eli-eric/eli-hmi-config`) cloned by the launcher at startup**, selected by
hostname into `launcher/host/` and `launcher/zone/`. It keeps the reviewable
history and deterministic rollback of the configuration-management option without
requiring a deployment agent, and reuses the cache-and-degrade semantics already
built for filesystem sources: an unreachable git server starts the launcher on the
last-known-good commit and reports `CATALOG STALE` with the commit SHA and fetch
timestamp.

It is opt-in per machine via `ELI_LAUNCHER_CONFIG_REPO_URL`; machines without it
keep using local and filesystem sources unchanged. See README.md > Git-backed
configuration, and BLK-006.

The trade-off accepted: startup now depends on git-server reachability for
*freshness* (never for *starting*), and the config repo becomes an artefact whose
write access must be controlled — which is why `security:` is deliberately not
overlayable from it.

## Recommendation

Use a versioned catalog distributed to a fixed local path by the site's existing
configuration-management mechanism. Keep an optional shared UNC source only for
controlled trials or emergency overrides. This separates authoring/review from
launcher runtime and avoids making every operator launch depend on a network
share. **Confidence: moderate** because the available material does not identify
the site's deployment tooling or ownership model.

## Maintainer question

Which source is authoritative for production: **(A)** a versioned catalog copied
to each workstation by configuration management, **(B)** a live shared
filesystem/UNC path, or **(C)** another mechanism with an owner and update SLA?
Also specify the authoritative path and who approves catalog changes.
