// Obtain or reuse the configuration repository at startup.
//
// Transport: isomorphic-git over HTTPS. A pure-JS client was chosen over
// shelling out to `git` so the HMI workstations need no `git` installation, and
// so the token can be held in memory only (see auth.ts). No child
// process is spawned, so the token cannot appear in a process table.
//
// Clone when the cache is absent; otherwise fetch and
// hard-reset (`checkout --force`) to the configured ref. Any local git error on
// an existing cache discards the cache and re-clones exactly once. Clones are
// shallow (`depth: 1`, `singleBranch`) because no history is needed; a branch,
// a tag, and a bare commit SHA all work under depth 1.
//
// A network failure with a usable cache is a warning,
// not a failure -- the control room starts on the last-known-good commit and the
// staleness (commit SHA + fetch timestamp) is surfaced to the caller. Only the
// combination "no cache AND network failure" throws.

import { mkdirSync, readFileSync, rmSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAuthCallback, redactError, redactSecret, type GitAuthCredentials } from "./auth";

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 1; // 2 attempts total
export const RETRY_BACKOFF_MS = 500;
const STATE_FILE = "fetch-state.json";
const WORKTREE_DIR = "repo";

export type ConfigRepoOptions = {
  url: string;
  token?: string | undefined;
  username?: string | undefined;
  ref?: string | undefined;
  cacheDir: string;
  timeoutMs?: number | undefined;
  offline?: boolean | undefined;
  retries?: number | undefined;
};

export type ConfigRepoState = {
  url: string;
  ref: string;
  commitSha: string;
  fetchedAt: string;
};

export type ConfigRepoResult = {
  repoDir: string;
  ref: string;
  commitSha: string;
  fetchedAt: string;
  source: "fresh" | "cached";
  warnings: string[];
};

// The subset of the isomorphic-git surface this module uses. Injectable so the
// offline test matrix can drive every branch without a network or a real repo.
export type GitLike = {
  clone(args: Record<string, unknown>): Promise<unknown>;
  fetch(args: Record<string, unknown>): Promise<{ fetchHead?: string | null | undefined }>;
  checkout(args: Record<string, unknown>): Promise<unknown>;
  resolveRef(args: Record<string, unknown>): Promise<string>;
  currentBranch(args: Record<string, unknown>): Promise<string | void | undefined>;
};

export type HttpLike = { request: (request: Record<string, unknown>) => Promise<unknown> };

export type ConfigRepoDeps = {
  git: GitLike;
  http: HttpLike;
  fs: unknown;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export class ConfigRepoNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ConfigRepoNetworkError";
  }
}

export class FetchDeadlineExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Config repo network operation exceeded the ${timeoutMs} ms budget.`);
    this.name = "FetchDeadlineExceededError";
  }
}

// ---------------------------------------------------------------------------
// Default dependencies. Imported lazily so nothing loads isomorphic-git when the
// feature is switched off (no ELI_LAUNCHER_CONFIG_REPO_URL) or under unit tests.
// ---------------------------------------------------------------------------

export async function defaultDeps(): Promise<ConfigRepoDeps> {
  const [git, http, fs] = await Promise.all([
    import("isomorphic-git"),
    import("isomorphic-git/http/node"),
    import("node:fs"),
  ]);
  return {
    git: (git.default ?? git) as unknown as GitLike,
    http: (http.default ?? http) as unknown as HttpLike,
    fs: fs.default ?? fs,
  };
}

// ---------------------------------------------------------------------------
// Bound network work so an unreachable repository cannot stall startup.
// ---------------------------------------------------------------------------

// isomorphic-git's node HTTP client documents its `signal` field as "Reserved
// for future use (canceling a request)" and does not honour it, so there is no
// built-in cancellation. The budget is enforced two ways: a per-socket timeout
// handed to the underlying client, and an outer deadline that both rejects the
// caller and latches this wrapper closed so any in-flight operation fails on its
// next request instead of running on unbounded.
type Budget = { expired: boolean };

function budgetedHttp(http: HttpLike, timeoutMs: number, budget: Budget): HttpLike {
  return {
    request: (request: Record<string, unknown>) => {
      if (budget.expired) {
        return Promise.reject(new FetchDeadlineExceededError(timeoutMs));
      }
      const fetchOptions = { ...(request["fetchOptions"] as object | undefined), timeout: timeoutMs };
      return http.request({ ...request, fetchOptions });
    },
  };
}

async function withDeadline<T>(timeoutMs: number, budget: Budget, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      budget.expired = true;
      reject(new FetchDeadlineExceededError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const NETWORK_ERROR_NAMES = new Set([
  "HttpError",
  "SmartHttpError",
  "UserCanceledError",
  "FetchDeadlineExceededError",
  "ConfigRepoNetworkError",
]);

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

// A TLS trust failure is neither a network fault nor a credentials fault: the
// host was reached and answered, and the token was never even offered. It means
// Node does not trust the certificate chain — which at a site with an internal
// CA is the normal first-run state, because Node carries its own root list and
// does not read the operating system's certificate store that the browser uses.
//
// Classified separately so the remedy can name the thing that actually fixes it.
// Reporting "check the URL, the ref, and the access token" for this sends an
// operator to inspect three settings that are all already correct.
const CERTIFICATE_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function isCertificateError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    code?: string;
    message?: string;
    cause?: unknown;
    data?: { code?: string };
  };
  if (candidate.code && CERTIFICATE_ERROR_CODES.has(candidate.code)) {
    return true;
  }
  if (candidate.data?.code && CERTIFICATE_ERROR_CODES.has(candidate.data.code)) {
    return true;
  }
  // isomorphic-git wraps the underlying failure, so the TLS code is often only
  // reachable through `cause` rather than on the error that surfaces here.
  if (candidate.cause && candidate.cause !== error && isCertificateError(candidate.cause)) {
    return true;
  }
  return /self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer|certificate has expired|altname|CERT_/i.test(
    candidate.message ?? "",
  );
}

export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: string; code?: string; message?: string; data?: { code?: string } };
  if (candidate.name && NETWORK_ERROR_NAMES.has(candidate.name)) {
    return true;
  }
  if (candidate.code && NETWORK_ERROR_CODES.has(candidate.code)) {
    return true;
  }
  const message = candidate.message ?? "";
  return /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|socket hang up|network|timed out|timeout/i.test(message);
}

// ---------------------------------------------------------------------------
// Cache bookkeeping.
// ---------------------------------------------------------------------------

export function worktreeDir(cacheDir: string): string {
  return path.join(cacheDir, WORKTREE_DIR);
}

function stateFilePath(cacheDir: string): string {
  return path.join(cacheDir, STATE_FILE);
}

// Use restrictive cache permissions where POSIX mode bits are available.
// the cache holds no secret, only public configuration.
function ensureCacheDir(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
}

export function readState(cacheDir: string): ConfigRepoState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(cacheDir), "utf8")) as Partial<ConfigRepoState>;
    if (!parsed.commitSha || !parsed.fetchedAt || !parsed.ref) {
      return undefined;
    }
    return {
      url: parsed.url ?? "",
      ref: parsed.ref,
      commitSha: parsed.commitSha,
      fetchedAt: parsed.fetchedAt,
    };
  } catch {
    return undefined;
  }
}

// Atomic tmp+rename, mirroring writeCatalogCache in config.ts so a crash mid-write
// can never leave a half-written state file behind.
function writeState(cacheDir: string, state: ConfigRepoState): void {
  ensureCacheDir(cacheDir);
  const target = stateFilePath(cacheDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Ignore cleanup failure; the original write error is the useful one.
    }
    throw error;
  }
}

function hasWorktree(cacheDir: string): boolean {
  try {
    return statSync(path.join(worktreeDir(cacheDir), ".git")).isDirectory();
  } catch {
    return false;
  }
}

function discardCache(cacheDir: string): void {
  rmSync(worktreeDir(cacheDir), { recursive: true, force: true });
  rmSync(stateFilePath(cacheDir), { force: true });
}

// ---------------------------------------------------------------------------
// Clone / update.
// ---------------------------------------------------------------------------

type Attempt = {
  deps: ConfigRepoDeps;
  dir: string;
  url: string;
  ref: string | undefined;
  onAuth: (() => GitAuthCredentials) | undefined;
  http: HttpLike;
};

async function doClone(attempt: Attempt): Promise<void> {
  const { deps, dir, url, ref, onAuth, http } = attempt;
  await deps.git.clone({
    fs: deps.fs,
    http,
    dir,
    url,
    depth: 1,
    singleBranch: true,
    noTags: false,
    ...(ref ? { ref } : {}),
    ...(onAuth ? { onAuth } : {}),
  });
}

async function doUpdate(attempt: Attempt): Promise<void> {
  const { deps, dir, url, ref, onAuth, http } = attempt;
  const result = await deps.git.fetch({
    fs: deps.fs,
    http,
    dir,
    url,
    depth: 1,
    singleBranch: true,
    tags: false,
    ...(ref ? { ref } : {}),
    ...(onAuth ? { onAuth } : {}),
  });
  const checkoutRef = result?.fetchHead ?? ref;
  await deps.git.checkout({
    fs: deps.fs,
    dir,
    force: true,
    ...(checkoutRef ? { ref: checkoutRef } : {}),
  });
}

async function resolveHead(deps: ConfigRepoDeps, dir: string): Promise<string> {
  return deps.git.resolveRef({ fs: deps.fs, dir, ref: "HEAD" });
}

async function resolveRefName(
  deps: ConfigRepoDeps,
  dir: string,
  configured: string | undefined,
  previous: string | undefined,
): Promise<string> {
  if (configured) {
    return configured;
  }
  if (previous) {
    return previous;
  }
  try {
    const branch = await deps.git.currentBranch({ fs: deps.fs, dir, fullname: false });
    return typeof branch === "string" && branch ? branch : "HEAD";
  } catch {
    return "HEAD";
  }
}

async function runWithRetries<T>(
  attempts: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  operation: (budget: Budget) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const budget: Budget = { expired: false };
    try {
      return await withDeadline(timeoutMs, budget, () => operation(budget));
    } catch (error) {
      lastError = error;
      // Only a network-shaped failure is worth repeating; a bad ref or a corrupt
      // object store will fail identically on the next attempt.
      if (!isNetworkError(error) || attempt === attempts - 1) {
        throw error;
      }
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  throw lastError;
}

export async function ensureConfigRepo(
  options: ConfigRepoOptions,
  deps: ConfigRepoDeps,
): Promise<ConfigRepoResult> {
  const cacheDir = options.cacheDir;
  const dir = worktreeDir(cacheDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const attempts = Math.max(1, (options.retries ?? DEFAULT_RETRIES) + 1);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const onAuth = createAuthCallback(options.token, options.username);
  const warnings: string[] = [];
  const previous = readState(cacheDir);
  const cached = hasWorktree(cacheDir);

  const useCache = (reason: string): ConfigRepoResult => {
    if (!cached || !previous) {
      throw new ConfigRepoNetworkError(
        `Config repo '${redactSecret(options.url, options.token, options.username)}' is unreachable and no usable local cache exists ` +
          `at '${cacheDir}'. Cause: ${reason}. ` +
          `Remedy: restore network access to the config repo, or deploy a local config file and unset ` +
          `ELI_LAUNCHER_CONFIG_REPO_URL.`,
      );
    }
    warnings.push(
      `Config repo '${redactSecret(options.url, options.token, options.username)}' could not be refreshed; using the cached ` +
        `configuration from commit ${previous.commitSha} fetched at ${previous.fetchedAt}. ` +
        `Cause: ${reason}.`,
    );
    return {
      repoDir: dir,
      ref: previous.ref,
      commitSha: previous.commitSha,
      fetchedAt: previous.fetchedAt,
      source: "cached",
      warnings,
    };
  };

  if (options.offline) {
    return useCache("offline mode is enabled (ELI_LAUNCHER_CONFIG_OFFLINE)");
  }

  ensureCacheDir(cacheDir);

  const attemptFor = (budget: Budget): Attempt => ({
    deps,
    dir,
    url: options.url,
    ref: options.ref,
    onAuth,
    http: budgetedHttp(deps.http, timeoutMs, budget),
  });

  const finish = async (): Promise<ConfigRepoResult> => {
    const commitSha = await resolveHead(deps, dir);
    const ref = await resolveRefName(deps, dir, options.ref, previous?.ref);
    const fetchedAt = now().toISOString();
    writeState(cacheDir, { url: options.url, ref, commitSha, fetchedAt });
    return { repoDir: dir, ref, commitSha, fetchedAt, source: "fresh", warnings };
  };

  if (cached) {
    try {
      await runWithRetries(attempts, timeoutMs, sleep, (budget) => doUpdate(attemptFor(budget)));
      return await finish();
    } catch (error) {
      if (isNetworkError(error)) {
        return useCache(redactError(error, options.token, options.username));
      }
      // Anything else on an existing cache is treated as local corruption or a
      // ref that no longer resolves: discard and re-clone exactly once.
      warnings.push(
        `Local config repo cache at '${dir}' was unusable and has been discarded before re-cloning. ` +
          `Cause: ${redactError(error, options.token, options.username)}.`,
      );
      discardCache(cacheDir);
      ensureCacheDir(cacheDir);
    }
  }

  try {
    await runWithRetries(attempts, timeoutMs, sleep, (budget) => doClone(attemptFor(budget)));
  } catch (error) {
    if (isNetworkError(error)) {
      return useCache(redactError(error, options.token, options.username));
    }
    const where = `Config repo '${redactSecret(options.url, options.token, options.username)}' could not be cloned into '${dir}'. `;
    const cause = `Cause: ${redactError(error, options.token, options.username)}. `;
    if (isCertificateError(error)) {
      throw new Error(
        where +
          cause +
          "The server was reached and answered, so this is a trust problem rather than a wrong URL or a bad " +
          "token. Node carries its own list of certificate authorities and does not read the operating " +
          "system's store, so a certificate the browser accepts can still be rejected here. " +
          "Remedy: export the issuing CA to a file and set NODE_EXTRA_CA_CERTS to its path, or set " +
          "NODE_OPTIONS=--use-system-ca to read the system store instead, then restart the launcher. " +
          "On Windows open a new terminal first, because setx only affects windows opened afterwards. " +
          "Do not disable certificate verification to work around this.",
      );
    }
    throw new Error(
      where +
        cause +
        `Remedy: check ELI_LAUNCHER_CONFIG_REPO_URL, ELI_LAUNCHER_CONFIG_REPO_REF, and the access token.`,
    );
  }
  return finish();
}
