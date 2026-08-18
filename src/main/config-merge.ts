// Deep-merge used to layer the git config repo's zone document (base) under its
// host document (override).
//
// Documented rule, enforced by tests in tests/config-merge.test.ts:
//   - mappings merge key by key, recursively;
//   - scalars replace;
//   - LISTS REPLACE WHOLESALE, they never concatenate. A zone list is a complete
//     catalogue, so concatenating would make removal impossible from a host file;
//   - a key that is absent, or explicitly `null`, does not override. Use an empty
//     list or empty string to clear a value deliberately.

export type MergeableObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is MergeableObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) {
    return base;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    // Scalars and lists replace. Object-vs-scalar mismatches also replace, so a
    // host file can flatten a zone mapping into a scalar if it needs to.
    return override;
  }
  const merged: MergeableObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) {
      continue;
    }
    merged[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return merged;
}

// Convenience wrapper for the common "merge two mappings" case.
export function mergeMappings(base: MergeableObject, override: MergeableObject): MergeableObject {
  const merged = deepMerge(base, override);
  return isPlainObject(merged) ? merged : {};
}
