import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const execFile = promisify(execFileCallback);

const UPSTREAM_REPOSITORY = "https://github.com/electron/electron.git";
const MIRROR_STRATEGY = "mirror-upstream-markdown";
const INCLUDED_GLOB = "docs/**/*.md";
const EXCLUDED_CONTENT = ["Rendered website HTML", "Website CSS/JS assets", "Images and non-Markdown assets", "docs/fiddles examples"];

type DirectoryEntry = {
  name: string;
  fileCount: number;
};

type QuickLink = {
  label: string;
  target: string;
};

type Manifest = {
  totalMarkdownFiles: number;
  topLevelDirectories: DirectoryEntry[];
  topLevelFiles: string[];
  quickLinks: QuickLink[];
};

type Metadata = {
  sourceRepository: string;
  sourceTag: string;
  syncedAt: string;
  strategy: string;
  included: string[];
  excluded: string[];
  markdownFileCount: number;
  topLevelDirectories: string[];
};

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const localDocsRoot = join(repoRoot, "docs");
  const mirrorRoot = join(localDocsRoot, "electron");
  const metadataPath = join(localDocsRoot, ".electron-docs-mirror.json");
  const offlineIndexPath = join(localDocsRoot, "README.md");
  const scratchRoot = await mkdtemp(join(tmpdir(), "electron-docs-"));
  const checkoutRoot = join(scratchRoot, "electron");

  try {
    const sourceTag = await resolveLatestStableTag();

    await cloneDocsTree(sourceTag, checkoutRoot);

    const sourceDocsRoot = join(checkoutRoot, "docs");
    await rm(mirrorRoot, { recursive: true, force: true });
    await mkdir(mirrorRoot, { recursive: true });
    await copyMarkdownTree(sourceDocsRoot, mirrorRoot);
    await rewriteAbsoluteDocsLinks(mirrorRoot);

    const manifest = await buildManifest(mirrorRoot);
    const metadata: Metadata = {
      sourceRepository: UPSTREAM_REPOSITORY,
      sourceTag,
      syncedAt: new Date().toISOString(),
      strategy: MIRROR_STRATEGY,
      included: [INCLUDED_GLOB],
      excluded: EXCLUDED_CONTENT,
      markdownFileCount: manifest.totalMarkdownFiles,
      topLevelDirectories: manifest.topLevelDirectories.map((entry) => entry.name),
    };

    await mkdir(localDocsRoot, { recursive: true });
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(offlineIndexPath, renderOfflineIndex(metadata, manifest));

    console.log(`Synced Electron docs ${sourceTag} into ${relative(repoRoot, mirrorRoot)}`);
    console.log(`Mirrored ${manifest.totalMarkdownFiles} Markdown files.`);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

async function resolveLatestStableTag(): Promise<string> {
  const { stdout } = await execGit(["ls-remote", "--refs", "--tags", UPSTREAM_REPOSITORY, "v*"]);

  const tags = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t")[1])
    .filter((ref): ref is string => ref !== undefined)
    .map((ref) => ref.replace("refs/tags/", ""))
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort(compareSemverTags);

  const latestTag = tags.at(-1);

  if (!latestTag) {
    throw new Error("Unable to resolve a stable Electron tag from upstream.");
  }

  return latestTag;
}

async function cloneDocsTree(sourceTag: string, checkoutRoot: string): Promise<void> {
  await execGit(["clone", "--depth", "1", "--branch", sourceTag, "--filter=blob:none", "--sparse", UPSTREAM_REPOSITORY, checkoutRoot]);

  await execGit(["-C", checkoutRoot, "sparse-checkout", "set", "docs"]);
}

async function copyMarkdownTree(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "fiddles") {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyMarkdownTree(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const content = await readFile(sourcePath, "utf8");
    await writeFile(targetPath, content);
  }
}

async function rewriteAbsoluteDocsLinks(mirrorRoot: string): Promise<void> {
  const markdownFiles = await collectMarkdownFiles(mirrorRoot);

  for (const filePath of markdownFiles) {
    const original = await readFile(filePath, "utf8");
    const updated = original.replace(
      /\]\((\/docs(?:\/latest)?\/[^)#\s]+)(#[^)\s]+)?\)/g,
      (_, absoluteTarget: string, hash: string = "") => {
        const normalizedTarget = absoluteTarget.replace(/^\/docs\/latest\//, "").replace(/^\/docs\//, "");
        const targetPath = join(mirrorRoot, normalizedTarget);
        let relativeTarget = relative(dirname(filePath), targetPath).replaceAll("\\", "/");

        if (!relativeTarget.startsWith(".")) {
          relativeTarget = `./${relativeTarget}`;
        }

        return `](${relativeTarget}${hash})`;
      },
    );

    if (updated !== original) {
      await writeFile(filePath, updated);
    }
  }
}

async function buildManifest(mirrorRoot: string): Promise<Manifest> {
  const entries = await readdir(mirrorRoot, { withFileTypes: true });
  const topLevelDirectories: DirectoryEntry[] = [];
  const topLevelFiles: string[] = [];
  let totalMarkdownFiles = 0;

  for (const entry of entries) {
    const entryPath = join(mirrorRoot, entry.name);

    if (entry.isDirectory()) {
      const fileCount = await countMarkdownFiles(entryPath);
      totalMarkdownFiles += fileCount;
      topLevelDirectories.push({ name: entry.name, fileCount });
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      totalMarkdownFiles += 1;
      topLevelFiles.push(entry.name);
    }
  }

  topLevelDirectories.sort((left, right) => left.name.localeCompare(right.name));
  topLevelFiles.sort((left, right) => left.localeCompare(right));

  return {
    totalMarkdownFiles,
    topLevelDirectories,
    topLevelFiles,
    quickLinks: await buildQuickLinks(mirrorRoot),
  };
}

async function buildQuickLinks(mirrorRoot: string): Promise<QuickLink[]> {
  const candidates: QuickLink[] = [
    { label: "Mirrored upstream index", target: "README.md" },
    { label: "Introduction", target: "tutorial/introduction.md" },
    { label: "API: app", target: "api/app.md" },
    { label: "Glossary", target: "glossary.md" },
    { label: "Breaking changes", target: "breaking-changes.md" },
    { label: "Development index", target: "development/README.md" },
  ];
  const quickLinks: QuickLink[] = [];

  for (const candidate of candidates) {
    const fullPath = join(mirrorRoot, candidate.target);

    if (await pathExists(fullPath)) {
      quickLinks.push(candidate);
    }
  }

  return quickLinks;
}

function renderOfflineIndex(metadata: Metadata, manifest: Manifest): string {
  const directoryLines = manifest.topLevelDirectories.map((entry) => `- ${entry.name}: ${entry.fileCount} Markdown files`);
  const topLevelFileLines = manifest.topLevelFiles.map((fileName) => `- ${fileName}`);
  const quickLinkLines = manifest.quickLinks.map((entry) => `- [${entry.label}](./electron/${entry.target})`);

  return [
    "# Electron Docs Mirror",
    "",
    "Offline Markdown mirror of the official Electron documentation.",
    "",
    "## Mirror metadata",
    "",
    `- Source repository: ${metadata.sourceRepository}`,
    `- Source tag: ${metadata.sourceTag}`,
    `- Synced at: ${metadata.syncedAt}`,
    `- Strategy: ${metadata.strategy}`,
    `- Included: ${metadata.included.join(", ")}`,
    `- Excluded: ${metadata.excluded.join(", ")}`,
    `- Markdown files mirrored: ${manifest.totalMarkdownFiles}`,
    "",
    "## Quick links",
    "",
    ...quickLinkLines,
    "",
    "## Top-level directories",
    "",
    ...directoryLines,
    "",
    "## Top-level Markdown files",
    "",
    ...(topLevelFileLines.length > 0 ? topLevelFileLines : ["- None"]),
    "",
  ].join("\n");
}

async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await collectMarkdownFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(entryPath);
    }
  }

  return results;
}

async function countMarkdownFiles(rootDir: string): Promise<number> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);

    if (entry.isDirectory()) {
      count += await countMarkdownFiles(entryPath);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      count += 1;
    }
  }

  return count;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function compareSemverTags(left: string, right: string): number {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

async function execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile("git", args, { maxBuffer: 20 * 1024 * 1024 });
  return result as { stdout: string; stderr: string };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
