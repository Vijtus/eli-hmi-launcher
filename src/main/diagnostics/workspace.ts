import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// A bounded workspace survey helps diagnostics locate launchable artifacts
// without making startup depend on traversing an arbitrarily large tree.

export type SurveyLimits = {
  maxDepth: number;
  maxEntries: number;
  maxExecutables: number;
  deadlineMs: number;
};

// Real-time build artifacts can be deeply nested. The entry cap prevents an
// unbounded walk; the deadline is the primary guard against delaying startup.
export const DEFAULT_SURVEY_LIMITS: SurveyLimits = {
  maxDepth: 12,
  maxEntries: 400_000,
  maxExecutables: 1_500,
  deadlineMs: 60_000,
};

export type SurveyResult = {
  root: string;
  exists: boolean;
  /** Directories directly under the root, for orienting quickly. */
  topLevel: string[];
  /** Every executable found, relative to the root. */
  executables: string[];
  /** Phoebus panels, plots and layouts found, relative to the root. */
  panels: string[];
  /** True when a limit stopped the walk before it finished. */
  truncated: boolean;
  /** How many directory entries were examined, so truncation is quantified. */
  scanned: number;
  reason?: string;
};

const EXECUTABLE_SUFFIXES = [".exe", ".bat", ".cmd", ".sh", ".rtexe"];

// Phoebus panels and plots are not executables, but "where is that .bob?" is the
// same question as "where is that .exe?" and gets the same wrong answer from a
// configured path nobody has checked. Phoebus reports a missing panel itself,
// but it cannot tell anyone where the file actually is.
const PANEL_SUFFIXES = [".bob", ".plt", ".memento", ".opi"];

// Directories that are always noise in a LabVIEW/Perforce workspace and can be
// enormous. Skipping them is what keeps the walk inside its deadline.
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  "data",
  "__pycache__",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

function isExecutable(name: string): boolean {
  const lower = name.toLowerCase();
  return EXECUTABLE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isPanel(name: string): boolean {
  const lower = name.toLowerCase();
  return PANEL_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export async function surveyRoot(
  root: string,
  limits: SurveyLimits = DEFAULT_SURVEY_LIMITS,
): Promise<SurveyResult> {
  const result: SurveyResult = {
    root,
    exists: false,
    topLevel: [],
    executables: [],
    panels: [],
    truncated: false,
    scanned: 0,
  };

  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      result.reason = "exists but is not a directory";
      return result;
    }
    result.exists = true;
  } catch (error) {
    result.reason =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "does not exist on this machine"
        : `not accessible (${(error as NodeJS.ErrnoException).code ?? "unknown"})`;
    return result;
  }

  const deadline = Date.now() + limits.deadlineMs;
  let seen = 0;

  // Breadth-first, so the shallow structure — the part a human needs to orient
  // — is recorded even if a deep branch exhausts the budget.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    if (Date.now() > deadline) {
      result.truncated = true;
      result.reason = `stopped after ${limits.deadlineMs / 1000}s`;
      break;
    }
    if (seen >= limits.maxEntries) {
      result.truncated = true;
      result.reason = `stopped after ${limits.maxEntries} entries`;
      break;
    }

    const current = queue.shift() as { dir: string; depth: number };
    let items;
    try {
      items = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue; // An unreadable subdirectory is not worth failing the survey over.
    }

    for (const item of items) {
      seen += 1;
      const full = path.join(current.dir, item.name);
      if (item.isDirectory()) {
        if (current.depth === 0) {
          result.topLevel.push(item.name);
        }
        if (SKIP_DIRECTORIES.has(item.name) || current.depth + 1 > limits.maxDepth) {
          continue;
        }
        queue.push({ dir: full, depth: current.depth + 1 });
      } else if (isPanel(item.name)) {
        if (result.panels.length < limits.maxExecutables) {
          result.panels.push(path.relative(root, full));
        }
      } else if (isExecutable(item.name)) {
        if (result.executables.length < limits.maxExecutables) {
          result.executables.push(path.relative(root, full));
        } else if (!result.truncated) {
          // Keep walking so topLevel stays complete, but stop growing the list;
          // a report nobody can read is not a diagnostic.
          result.truncated = true;
          result.reason = `listed the first ${limits.maxExecutables} executables`;
        }
      }
    }
  }

  result.scanned = seen;
  result.topLevel.sort();
  result.executables.sort();
  result.panels.sort();
  return result;
}

export async function surveyRoots(
  roots: string[],
  limits: SurveyLimits = DEFAULT_SURVEY_LIMITS,
): Promise<SurveyResult[]> {
  const unique = [...new Set(roots.filter((root) => root.trim()))];
  const results: SurveyResult[] = [];
  for (const root of unique) {
    results.push(await surveyRoot(root, limits));
  }
  return results;
}
