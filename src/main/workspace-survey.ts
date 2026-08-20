import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// A bounded look at what is actually on the machine, so a field report can
// answer "where do the GUIs really live?" instead of only "was the configured
// path right?". Configured paths are a guess until someone has looked; this
// looks, once, and writes down what it saw.
//
// Every limit below exists because this runs on an operator's machine while
// they wait: a workspace can be enormous, and a diagnostic must never be the
// reason the launcher feels broken.
// ---------------------------------------------------------------------------

export type SurveyLimits = {
  maxDepth: number;
  maxEntries: number;
  maxExecutables: number;
  deadlineMs: number;
};

// Depth 10 because the observed TESTZ layout puts a real-time build at
// TESTZone/Deployment/Resource/Host/<host>/Builds/c/ni-rt/startup/<name>.rtexe,
// which is nine levels below the workspace root. Six missed it entirely.
export const DEFAULT_SURVEY_LIMITS: SurveyLimits = {
  maxDepth: 10,
  maxEntries: 20_000,
  maxExecutables: 500,
  deadlineMs: 25_000,
};

export type SurveyResult = {
  root: string;
  exists: boolean;
  /** Directories directly under the root, for orienting quickly. */
  topLevel: string[];
  /** Every executable found, relative to the root. */
  executables: string[];
  /** True when a limit stopped the walk before it finished. */
  truncated: boolean;
  reason?: string;
};

const EXECUTABLE_SUFFIXES = [".exe", ".bat", ".cmd", ".sh", ".rtexe"];

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

export async function surveyRoot(
  root: string,
  limits: SurveyLimits = DEFAULT_SURVEY_LIMITS,
): Promise<SurveyResult> {
  const result: SurveyResult = {
    root,
    exists: false,
    topLevel: [],
    executables: [],
    truncated: false,
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

  result.topLevel.sort();
  result.executables.sort();
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
