import type { CatalogStatus } from "./types";

export function catalogStalenessMessage(status: CatalogStatus | undefined): string | undefined {
  if (!status?.stale) {
    return undefined;
  }
  const degraded = status.sources.filter((source) => source.stale && source.id !== "inline");
  if (degraded.length === 0) {
    return "CATALOG STALE — one or more catalog sources are degraded.";
  }
  const details = degraded
    .map((source) => `${source.id}: ${source.state}${source.loadedAt ? ` (${source.loadedAt})` : ""}`)
    .join("; ");
  return `CATALOG STALE — ${details}`;
}
