import type { LauncherRow } from "./types";

export type LauncherFilters = {
  search: string;
  technology: string;
  section: string;
};

export type MultiValueFilterKey = "technology" | "section";

const filterOptionCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function matchesLauncherSearch(row: LauncherRow, search: string): boolean {
  const query = normalize(search);
  if (!query) {
    return true;
  }

  // Deliberately restricted to the two free-text fields requested by users.
  // Technology and Section are handled only by their dedicated dropdowns.
  return normalize(row.name).includes(query) || normalize(row.note).includes(query);
}

export function matchesLauncherFilters(
  row: LauncherRow,
  technology: string,
  section: string,
): boolean {
  const technologyMatches = !technology || row.technology.includes(technology);
  const sectionMatches = !section || row.section.includes(section);
  return technologyMatches && sectionMatches;
}

export function filterLauncherRows(rows: LauncherRow[], filters: LauncherFilters): LauncherRow[] {
  return rows.filter(
    (row) =>
      matchesLauncherSearch(row, filters.search) &&
      matchesLauncherFilters(row, filters.technology, filters.section),
  );
}

export function getUniqueMultiValues(rows: LauncherRow[], key: MultiValueFilterKey): string[] {
  const values = new Set<string>();

  for (const row of rows) {
    for (const value of row[key]) {
      if (value && value !== "--") {
        values.add(value);
      }
    }
  }

  return [...values].sort(
    (left, right) =>
      filterOptionCollator.compare(left, right) ||
      left.localeCompare(right, "en"),
  );
}
