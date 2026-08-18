// Integration tests against the real git smart-HTTP protocol, served locally by
// `git http-backend`. No test contacts github.com or any other remote host.
//
// The launcher runtime never shells out to git; this suite uses the git binary
// only to BUILD and SERVE the fixture, and skips entirely when it is absent.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TOKEN_PASSWORD } from "../src/main/config-repo-auth.ts";
import {
  defaultDeps,
  ensureConfigRepo,
  worktreeDir,
  type ConfigRepoDeps,
} from "../src/main/config-repo.ts";
import { hasGitHttpBackend, startGitHttpServer } from "./helpers/git-http-server.ts";

const TOKEN = "ghp_SUPERSECRETTOKEN123456789";
const BASIC = `Basic ${Buffer.from(`${TOKEN}:${TOKEN_PASSWORD}`, "utf8").toString("base64")}`;
const skip = hasGitHttpBackend() ? false : "git http-backend is not installed";

const HOST_YAML = "zone: TESTZ\nP4-workspace: D:\\ws\ncss-install: C:\\CSS Phoebus\\product-5.0.2\n";
const ZONE_YAML = "labview-dev:\n  - ioc-name: Camera Manager\n    host: RMC00-001\n    ioc-type: Camera Manager\n    exe: CMD.exe\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.org", "-c", "user.name=Test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Builds <root>/serve/config.git (bare) from a working tree, plus a `v1.0` tag.
function buildFixture(): { root: string; serveDir: string; sha: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-git-fixture-"));
  const source = path.join(root, "source");
  const serveDir = path.join(root, "serve");
  mkdirSync(path.join(source, "launcher", "host"), { recursive: true });
  mkdirSync(path.join(source, "launcher", "zone"), { recursive: true });
  mkdirSync(serveDir, { recursive: true });
  writeFileSync(path.join(source, "launcher", "host", "TESTZ-Deploy.yaml"), HOST_YAML);
  writeFileSync(path.join(source, "launcher", "zone", "TESTZ.yaml"), ZONE_YAML);
  git(source, "init", "-q", "-b", "main", ".");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "fixture");
  git(source, "tag", "v1.0");
  const sha = git(source, "rev-parse", "HEAD").trim();
  git(root, "clone", "-q", "--bare", source, path.join(serveDir, "config.git"));
  return { root, serveDir, sha };
}

function commitMore(root: string, serveDir: string, text: string): string {
  const source = path.join(root, "source");
  writeFileSync(path.join(source, "launcher", "zone", "TESTZ.yaml"), text);
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "update");
  git(source, "push", "-q", path.join(serveDir, "config.git"), "main");
  return git(source, "rev-parse", "HEAD").trim();
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

async function deps(): Promise<ConfigRepoDeps> {
  return defaultDeps();
}

test("first run clones over real smart HTTP using an in-memory token", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: BASIC });
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    const result = await ensureConfigRepo(
      { url: server.url("config.git"), token: TOKEN, ref: "main", cacheDir },
      await deps(),
    );
    assert.equal(result.source, "fresh");
    assert.equal(result.commitSha, fixture.sha);
    assert.equal(result.ref, "main");
    assert.equal(
      readFileSync(path.join(result.repoDir, "launcher", "host", "TESTZ-Deploy.yaml"), "utf8"),
      HOST_YAML,
    );
    assert.ok(server.requests.length > 0, "the real protocol must have been exercised");
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// NFR1 evidence, asserted rather than described.
test("the token never reaches .git/config or any cached file", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: BASIC });
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    const result = await ensureConfigRepo(
      { url: server.url("config.git"), token: TOKEN, ref: "main", cacheDir },
      await deps(),
    );

    const gitConfig = readFileSync(path.join(result.repoDir, ".git", "config"), "utf8");
    assert.ok(!gitConfig.includes(TOKEN), ".git/config must not contain the token");
    assert.match(gitConfig, /url = http:\/\/127\.0\.0\.1:\d+\/config\.git/);
    assert.ok(!/@/.test(gitConfig.split("\n").find((line) => line.includes("url =")) ?? ""));

    for (const file of filesUnder(cacheDir)) {
      const contents = readFileSync(file);
      assert.ok(!contents.includes(TOKEN), `token leaked into ${file}`);
      assert.ok(
        !contents.includes(Buffer.from(`${TOKEN}:${TOKEN_PASSWORD}`).toString("base64")),
        `encoded token leaked into ${file}`,
      );
    }
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a second run fetches and hard-resets instead of re-cloning", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: BASIC });
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    const options = { url: server.url("config.git"), token: TOKEN, ref: "main", cacheDir };
    const first = await ensureConfigRepo(options, await deps());
    assert.equal(first.commitSha, fixture.sha);

    const updated = commitMore(fixture.root, fixture.serveDir, `${ZONE_YAML}web:\n`);
    // A local edit must be discarded by the hard reset.
    writeFileSync(path.join(first.repoDir, "launcher", "zone", "TESTZ.yaml"), "tampered: true\n");

    const second = await ensureConfigRepo(options, await deps());
    assert.equal(second.source, "fresh");
    assert.equal(second.commitSha, updated);
    assert.notEqual(second.commitSha, first.commitSha);
    assert.match(
      readFileSync(path.join(second.repoDir, "launcher", "zone", "TESTZ.yaml"), "utf8"),
      /ioc-name: Camera Manager/,
    );
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an unreachable remote falls back to the cached commit", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: BASIC });
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    const options = { url: server.url("config.git"), token: TOKEN, ref: "main", cacheDir };
    await ensureConfigRepo(options, await deps());
    await server.close(); // the git server is now down

    const cached = await ensureConfigRepo({ ...options, timeoutMs: 2000, retries: 0 }, await deps());
    assert.equal(cached.source, "cached");
    assert.equal(cached.commitSha, fixture.sha);
    assert.match(cached.warnings[0] ?? "", /using the cached configuration from commit/);
    // The staleness signal an operator needs.
    assert.ok(cached.fetchedAt);
    assert.equal(
      readFileSync(path.join(cached.repoDir, "launcher", "host", "TESTZ-Deploy.yaml"), "utf8"),
      HOST_YAML,
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a corrupted cache is discarded and re-cloned", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: BASIC });
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    const options = { url: server.url("config.git"), token: TOKEN, ref: "main", cacheDir };
    await ensureConfigRepo(options, await deps());

    // Replace the object store with a FILE, leaving .git in place so the cache
    // still looks present. Unlike simply deleting objects (which a fetch would
    // silently repopulate), this cannot be recovered from in place, so it drives
    // the discard-and-re-clone path rather than the ordinary update path.
    const objects = path.join(worktreeDir(cacheDir), ".git", "objects");
    rmSync(objects, { recursive: true, force: true });
    writeFileSync(objects, "not a directory\n");

    const recovered = await ensureConfigRepo(options, await deps());
    assert.equal(recovered.source, "fresh");
    assert.equal(recovered.commitSha, fixture.sha);
    assert.ok(
      recovered.warnings.some((warning) => /unusable and has been discarded before re-cloning/.test(warning)),
      `expected a discard warning, got ${JSON.stringify(recovered.warnings)}`,
    );
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a ref may be pinned to a tag or a bare commit SHA under a shallow clone", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir);
  try {
    for (const ref of ["v1.0", fixture.sha]) {
      const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
      try {
        const result = await ensureConfigRepo({ url: server.url("config.git"), ref, cacheDir }, await deps());
        assert.equal(result.commitSha, fixture.sha, `ref ${ref} should resolve to the fixture commit`);
        assert.equal(result.ref, ref);
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    }
  } finally {
    await server.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a bad ref fails with a named, token-free error", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: BASIC });
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    await assert.rejects(
      ensureConfigRepo(
        { url: server.url("config.git"), token: TOKEN, ref: "no-such-ref", cacheDir },
        await deps(),
      ),
      (error: Error) => {
        assert.match(error.message, /could not be cloned into/);
        assert.match(error.message, /ELI_LAUNCHER_CONFIG_REPO_REF/);
        assert.ok(!error.message.includes(TOKEN), "the error must not carry the token");
        return true;
      },
    );
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an anonymous clone works against a repo that needs no token (FR1)", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir); // no auth required
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    const result = await ensureConfigRepo(
      { url: server.url("config.git"), token: undefined, ref: "main", cacheDir },
      await deps(),
    );
    assert.equal(result.source, "fresh");
    assert.equal(result.commitSha, fixture.sha);
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a missing token against a private repo fails without leaking anything", { skip }, async () => {
  const fixture = buildFixture();
  const server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: BASIC });
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-git-cache-"));
  try {
    await assert.rejects(
      ensureConfigRepo(
        { url: server.url("config.git"), token: undefined, ref: "main", cacheDir, retries: 0 },
        await deps(),
      ),
      (error: Error) => {
        assert.ok(!error.message.includes(TOKEN));
        return true;
      },
    );
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
