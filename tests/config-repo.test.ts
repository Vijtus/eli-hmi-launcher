import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureConfigRepo,
  isCertificateError,
  isNetworkError,
  readState,
  worktreeDir,
  type ConfigRepoDeps,
  type GitLike,
} from "../src/main/catalog/repo.ts";

const TOKEN = "ghp_SUPERSECRETTOKEN123456789";

class NetworkDown extends Error {
  constructor() {
    super("connect ECONNREFUSED 127.0.0.1:1");
    this.name = "HttpError";
  }
}

type FakeGitOptions = {
  onClone?: () => void;
  onFetch?: () => void;
  sha?: string;
};

// A fake standing in for isomorphic-git. `clone` materializes a plausible
// worktree so the caller's cache-presence checks behave exactly as they would
// against the real client.
function fakeGit(options: FakeGitOptions = {}): { git: GitLike; calls: string[] } {
  const calls: string[] = [];
  let sha = options.sha ?? "a".repeat(40);
  const git: GitLike = {
    async clone(args) {
      calls.push("clone");
      options.onClone?.();
      const dir = String(args["dir"]);
      mkdirSync(path.join(dir, ".git"), { recursive: true });
      mkdirSync(path.join(dir, "launcher", "host"), { recursive: true });
      writeFileSync(path.join(dir, "launcher", "host", "box.yaml"), "zone: Z\n");
      return undefined;
    },
    async fetch(args) {
      calls.push("fetch");
      options.onFetch?.();
      void args;
      return { fetchHead: sha };
    },
    async checkout() {
      calls.push("checkout");
      return undefined;
    },
    async resolveRef() {
      return sha;
    },
    async currentBranch() {
      return "main";
    },
  };
  return { git, calls };
}

function deps(git: GitLike, overrides: Partial<ConfigRepoDeps> = {}): ConfigRepoDeps {
  return {
    git,
    http: { request: async () => ({}) },
    fs: {},
    now: () => new Date("2026-08-18T10:00:00.000Z"),
    sleep: async () => undefined,
    ...overrides,
  };
}

function tempCache(): string {
  return mkdtempSync(path.join(os.tmpdir(), "eli-config-repo-"));
}

test("an absent cache is cloned, and the fetch state is recorded", async () => {
  const cacheDir = tempCache();
  try {
    const { git, calls } = fakeGit();
    const result = await ensureConfigRepo(
      { url: "https://git.example.org/config.git", cacheDir, token: TOKEN },
      deps(git),
    );
    assert.deepEqual(calls, ["clone"]);
    assert.equal(result.source, "fresh");
    assert.equal(result.commitSha, "a".repeat(40));
    assert.equal(result.ref, "main");
    assert.equal(result.fetchedAt, "2026-08-18T10:00:00.000Z");
    assert.equal(result.repoDir, worktreeDir(cacheDir));
    assert.deepEqual(readState(cacheDir), {
      url: "https://git.example.org/config.git",
      ref: "main",
      commitSha: "a".repeat(40),
      fetchedAt: "2026-08-18T10:00:00.000Z",
    });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the token is never written to the cache directory", async () => {
  const cacheDir = tempCache();
  try {
    await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir, token: TOKEN }, deps(fakeGit().git));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(cacheDir);
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.ok(!readFileSync(file, "utf8").includes(TOKEN), `token leaked into ${file}`);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an existing cache is fetched and hard-reset, never re-cloned", async () => {
  const cacheDir = tempCache();
  try {
    const first = fakeGit();
    await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir }, deps(first.git));
    const second = fakeGit({ sha: "b".repeat(40) });
    const result = await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir }, deps(second.git));
    assert.deepEqual(second.calls, ["fetch", "checkout"]);
    assert.equal(result.source, "fresh");
    assert.equal(result.commitSha, "b".repeat(40));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an unreachable remote falls back to the cached commit with a warning", async () => {
  const cacheDir = tempCache();
  try {
    await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir }, deps(fakeGit().git));
    const offline = fakeGit({ onFetch: () => { throw new NetworkDown(); } });
    const result = await ensureConfigRepo(
      { url: "https://git.example.org/c.git", cacheDir, retries: 0 },
      deps(offline.git),
    );
    assert.equal(result.source, "cached");
    assert.equal(result.commitSha, "a".repeat(40));
    assert.equal(result.fetchedAt, "2026-08-18T10:00:00.000Z");
    assert.match(result.warnings[0] ?? "", /could not be refreshed; using the cached configuration/);
    assert.match(result.warnings[0] ?? "", /commit a{40} fetched at 2026-08-18T10:00:00\.000Z/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an unreachable remote with no cache fails hard with a remedy", async () => {
  const cacheDir = tempCache();
  try {
    const offline = fakeGit({ onClone: () => { throw new NetworkDown(); } });
    await assert.rejects(
      ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir, retries: 0 }, deps(offline.git)),
      (error: Error) => {
        assert.match(error.message, /unreachable and no usable local cache exists/);
        assert.match(error.message, /Remedy: restore network access/);
        return true;
      },
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a corrupted cache is discarded and re-cloned exactly once", async () => {
  const cacheDir = tempCache();
  try {
    await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir }, deps(fakeGit().git));
    // Simulate a torn object store: fetch fails with a non-network error.
    let fetchCalls = 0;
    const corrupt = fakeGit({
      onFetch: () => {
        fetchCalls += 1;
        const error = new Error("Could not find object.");
        error.name = "NotFoundError";
        throw error;
      },
    });
    const result = await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir }, deps(corrupt.git));
    assert.equal(fetchCalls, 1, "a corrupt cache must not be retried over the network");
    assert.deepEqual(corrupt.calls, ["fetch", "clone"]);
    assert.equal(result.source, "fresh");
    assert.match(result.warnings[0] ?? "", /was unusable and has been discarded before re-cloning/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("offline mode uses the cache without touching the network", async () => {
  const cacheDir = tempCache();
  try {
    await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir }, deps(fakeGit().git));
    const untouched = fakeGit({
      onFetch: () => assert.fail("offline mode must not fetch"),
      onClone: () => assert.fail("offline mode must not clone"),
    });
    const result = await ensureConfigRepo(
      { url: "https://git.example.org/c.git", cacheDir, offline: true },
      deps(untouched.git),
    );
    assert.equal(result.source, "cached");
    assert.deepEqual(untouched.calls, []);
    assert.match(result.warnings[0] ?? "", /offline mode is enabled/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("offline mode with no cache fails rather than starting unconfigured", async () => {
  const cacheDir = tempCache();
  try {
    await assert.rejects(
      ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir, offline: true }, deps(fakeGit().git)),
      /no usable local cache exists/,
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a bad ref fails immediately and is not retried", async () => {
  const cacheDir = tempCache();
  try {
    let attempts = 0;
    const badRef = fakeGit({
      onClone: () => {
        attempts += 1;
        const error = new Error("Could not find nope.");
        error.name = "NotFoundError";
        throw error;
      },
    });
    await assert.rejects(
      ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir, ref: "nope" }, deps(badRef.git)),
      (error: Error) => {
        assert.match(error.message, /could not be cloned into/);
        assert.match(error.message, /ELI_LAUNCHER_CONFIG_REPO_REF/);
        return true;
      },
    );
    assert.equal(attempts, 1, "a bad ref will fail identically on a retry");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a network failure is retried up to the configured ceiling and no further", async () => {
  const cacheDir = tempCache();
  try {
    let attempts = 0;
    const flaky = fakeGit({ onClone: () => { attempts += 1; throw new NetworkDown(); } });
    await assert.rejects(
      ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir, retries: 2 }, deps(flaky.git)),
      /no usable local cache exists/,
    );
    assert.equal(attempts, 3, "retries: 2 means 3 attempts total");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a retried network failure that later succeeds yields a fresh result", async () => {
  const cacheDir = tempCache();
  try {
    let attempts = 0;
    const flaky = fakeGit({
      onClone: () => {
        attempts += 1;
        if (attempts === 1) throw new NetworkDown();
      },
    });
    const result = await ensureConfigRepo(
      { url: "https://git.example.org/c.git", cacheDir, retries: 1 },
      deps(flaky.git),
    );
    assert.equal(attempts, 2);
    assert.equal(result.source, "fresh");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a hanging remote is abandoned at the timeout instead of blocking startup", async () => {
  const cacheDir = tempCache();
  try {
    const hanging = fakeGit({});
    // Settles well after the deadline rather than never. A promise that never
    // settles starves the test runner: once the event loop drains with it still
    // pending, node:test reports "Promise resolution is still pending but the
    // event loop has already resolved" and cancels every sibling test in the file.
    hanging.git.clone = () => new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    await assert.rejects(
      ensureConfigRepo(
        { url: "https://git.example.org/c.git", cacheDir, timeoutMs: 120, retries: 0 },
        deps(hanging.git),
      ),
      /unreachable and no usable local cache exists/,
    );
    assert.ok(Date.now() - started < 5000, "the deadline must bound startup cost");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the HTTP wrapper latches closed once the deadline has passed", async () => {
  const cacheDir = tempCache();
  try {
    // The operation keeps running after the deadline (isomorphic-git cannot be
    // cancelled), so the wrapper must reject its NEXT request instead. This
    // deferred lets the test observe that request, which by design happens after
    // ensureConfigRepo has already rejected.
    // Boxed: resolving a promise WITH a promise adopts it, which would rethrow
    // here instead of handing the test the rejected promise to assert on.
    let announce: (outcome: { attempt: Promise<unknown> }) => void = () => undefined;
    const laterRequest = new Promise<{ attempt: Promise<unknown> }>((resolve) => {
      announce = resolve;
    });
    const git = fakeGit().git;
    git.clone = async (args) => {
      const http = args["http"] as { request: (r: Record<string, unknown>) => Promise<unknown> };
      await new Promise((resolve) => setTimeout(resolve, 150));
      const attempt = http.request({ url: "https://git.example.org/info/refs" });
      announce({ attempt });
      // The race in ensureConfigRepo has already abandoned this call, so swallow
      // the latch rejection here; the test asserts on it via `announce`.
      await attempt.catch(() => undefined);
      return undefined;
    };
    await assert.rejects(
      ensureConfigRepo(
        { url: "https://git.example.org/c.git", cacheDir, timeoutMs: 60, retries: 0 },
        deps(git),
      ),
      /no usable local cache exists/,
    );
    await assert.rejects((await laterRequest).attempt, /exceeded the 60 ms budget/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the per-request socket timeout is handed to the HTTP client", async () => {
  const cacheDir = tempCache();
  try {
    const seen: Record<string, unknown>[] = [];
    const git = fakeGit().git;
    const original = git.clone.bind(git);
    git.clone = async (args) => {
      const http = args["http"] as { request: (r: Record<string, unknown>) => Promise<unknown> };
      await http.request({ url: "https://git.example.org/info/refs" });
      return original(args);
    };
    await ensureConfigRepo(
      { url: "https://git.example.org/c.git", cacheDir, timeoutMs: 4321 },
      deps(git, { http: { request: async (r) => { seen.push(r); return {}; } } }),
    );
    assert.deepEqual(seen[0]?.["fetchOptions"], { timeout: 4321 });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a half-written state file is treated as no cache at all", async () => {
  const cacheDir = tempCache();
  try {
    mkdirSync(path.join(worktreeDir(cacheDir), ".git"), { recursive: true });
    writeFileSync(path.join(cacheDir, "fetch-state.json"), "{ not json");
    assert.equal(readState(cacheDir), undefined);
    const offline = fakeGit({ onFetch: () => { throw new NetworkDown(); } });
    await assert.rejects(
      ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir, retries: 0 }, deps(offline.git)),
      /no usable local cache exists/,
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the cache directory is created with restrictive permissions on POSIX", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-config-perm-"));
  const cacheDir = path.join(root, "nested", "config-repo");
  try {
    await ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir }, deps(fakeGit().git));
    const mode = require("node:fs").statSync(cacheDir).mode & 0o777;
    assert.equal(mode, 0o700, `expected 0700, got ${mode.toString(8)}`);
    assert.ok(existsSync(path.join(cacheDir, "fetch-state.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("network errors are classified by name, code, and message", () => {
  assert.equal(isNetworkError(new NetworkDown()), true);
  assert.equal(isNetworkError(Object.assign(new Error("x"), { code: "ENOTFOUND" })), true);
  assert.equal(isNetworkError(new Error("socket hang up")), true);
  assert.equal(isNetworkError(Object.assign(new Error("nope"), { name: "NotFoundError" })), false);
  assert.equal(isNetworkError(undefined), false);
});

// Reported from a control-room workstation against an internal GitLab: the clone
// failed with "self signed certificate in certificate chain" and the launcher
// told the operator to check the URL, the ref and the access token. All three
// were correct, and none of them could have fixed it.
test("a certificate failure is not mistaken for a network or credentials fault", () => {
  const reported = new Error("self signed certificate in certificate chain");
  assert.equal(isCertificateError(reported), true);
  assert.equal(isNetworkError(reported), false);

  assert.equal(
    isCertificateError(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })),
    true,
  );
  assert.equal(
    isCertificateError(Object.assign(new Error("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })),
    true,
  );
  // isomorphic-git wraps the underlying failure rather than rethrowing it.
  assert.equal(
    isCertificateError(
      Object.assign(new Error("clone failed"), {
        cause: Object.assign(new Error("inner"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      }),
    ),
    true,
  );
  assert.equal(isCertificateError(new Error("connect ECONNREFUSED 10.2.5.12:443")), false);
  assert.equal(isCertificateError(new Error("401 Unauthorized")), false);
  assert.equal(isCertificateError(undefined), false);
});

test("a certificate failure names the setting that actually fixes it", async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-config-repo-cert-"));
  try {
    const untrusted = fakeGit({
      onClone: () => {
        throw new Error("self signed certificate in certificate chain");
      },
    });
    await assert.rejects(
      ensureConfigRepo({ url: "https://git.example.org/c.git", cacheDir, retries: 0 }, deps(untrusted.git)),
      (error: Error) => {
        assert.match(error.message, /NODE_EXTRA_CA_CERTS/);
        assert.match(error.message, /trust problem rather than a wrong URL or a bad token/);
        assert.doesNotMatch(error.message, /Remedy: check ELI_LAUNCHER_CONFIG_REPO_URL/);
        return true;
      },
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
