# ADR 0001: Catalog distribution and local trust

Status: accepted

## Decision

Use the local `launcher.yaml` as the security/bootstrap trust root and the Git-backed host/zone repository as the preferred centralized operational configuration mechanism.

Retain `catalog.sources` as a separate, narrower mechanism for deployments that intentionally distribute entry catalogs through local/mounted/UNC YAML files.

Remove the former startup behavior that ran `git pull` in the directory containing the root `launcher.yaml`.

## Rationale

The Git-backed repository already provides the operational capabilities needed for centralized deployments: bounded refresh, cached/offline operation, authentication redaction, hostname resolution, zone defaults, host overrides, catalog adaptation, and provenance.

Updating the root config checkout through Git creates a second refresh mechanism and makes the local executable trust policy vulnerable to the same publication path as operational catalog content. Keeping security/access local and applying remote content only through a typed overlay is simpler and preserves the trust boundary.

Filesystem `catalog.sources` serves a materially different deployment mode. It is entry-only, ordered, supports mounted/UNC paths, and has its own last-known-good cache. Removing it would break supported file-distributed/offline catalog deployments without simplifying the Git mechanism itself.

## Precedence

For machine values supplied by the Git repository: zone defaults are merged first, then host-derived values/host `local` overrides.

For catalog entries: inline root entries are lowest precedence; listed `catalog.sources` apply in order; Git zone entries are appended last and therefore win duplicate IDs.

`security` and `access` are never sourced from Git host/zone data.

## Consequences

- A deployment can later move `deployment/TESTZ/` and its config repository material to a separate repository without changing launcher source layout.
- There remains more than one catalog input mode, but each has a distinct deployment purpose rather than overlapping Git implementations.
- Operators must protect the local launcher YAML because it authorizes execution.
