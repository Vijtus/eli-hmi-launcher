// Backs the settings screen: read, save, clear, and a connection test that
// actually performs a clone rather than guessing from a URL.
//
// The test matters more than it looks. Every failure mode here — an untrusted
// certificate, a rejected token, a missing host file — produces a different
// remedy, and an operator who has just typed six fields deserves to be told
// which one is wrong before restarting and hoping.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RepoSettingsInput,
  RepoSettingsSaveResult,
  RepoSettingsTestResult,
  RepoSettingsView,
} from "../../shared/types";
import { redactError } from "./auth";
import { DEFAULT_SUBPATH, ENV, resolveDynamicConfig, type EnvLike } from "./load";
import { defaultDeps, isCertificateError } from "./repo";
import {
  clearSettings,
  loadSettings,
  overriddenByEnv,
  saveSettings,
  type ConfigRepoSettings,
  type SecretStore,
} from "./settings";

export type SettingsServiceDeps = {
  userDataDir: string;
  secrets: SecretStore;
  env: EnvLike;
  hostname: () => string;
};

export function readSettingsView(deps: SettingsServiceDeps): RepoSettingsView {
  const stored = loadSettings(deps.userDataDir, deps.secrets);
  return {
    url: stored.url ?? "",
    username: stored.username ?? "",
    ref: stored.ref ?? "",
    subpath: stored.subpath ?? "",
    hostname: stored.hostname ?? "",
    tokenStored: Boolean(stored.token),
    overriddenByEnv: overriddenByEnv(deps.env, stored),
    secureStorageAvailable: deps.secrets.isEncryptionAvailable(),
    machineName: deps.hostname(),
  };
}

// An empty token field means "keep what is stored". Without this an operator
// who edits the branch name would silently wipe their token, because the field
// renders empty by design — the token is never sent to the renderer.
function withExistingToken(
  deps: SettingsServiceDeps,
  input: RepoSettingsInput,
): ConfigRepoSettings {
  const typed = input.token.trim();
  const token = typed || loadSettings(deps.userDataDir, deps.secrets).token;
  return {
    url: input.url.trim(),
    username: input.username.trim(),
    ref: input.ref.trim(),
    subpath: input.subpath.trim(),
    hostname: input.hostname.trim(),
    ...(token ? { token } : {}),
  };
}

export function saveSettingsFrom(
  deps: SettingsServiceDeps,
  input: RepoSettingsInput,
): RepoSettingsSaveResult {
  const settings = withExistingToken(deps, input);
  const result = saveSettings(deps.userDataDir, deps.secrets, settings);
  const overridden = overriddenByEnv(deps.env, settings);
  const notes: string[] = [];
  if (result.reason) {
    notes.push(result.reason);
  }
  if (overridden.length > 0) {
    notes.push(
      `Saved, but ${overridden.join(" and ")} ${overridden.length === 1 ? "is" : "are"} set in the ` +
        "environment and takes precedence. Remove it there for these values to take effect.",
    );
  }
  return {
    saved: true,
    tokenStored: result.tokenStored || Boolean(settings.token),
    ...(notes.length > 0 ? { message: notes.join(" ") } : {}),
  };
}

export function clearSettingsFor(deps: SettingsServiceDeps): void {
  clearSettings(deps.userDataDir);
}

export async function testSettings(
  deps: SettingsServiceDeps,
  input: RepoSettingsInput,
): Promise<RepoSettingsTestResult> {
  const settings = withExistingToken(deps, input);
  if (!settings.url) {
    return { ok: false, message: "Enter the repository URL first." };
  }
  if (!settings.token) {
    return {
      ok: false,
      message: "Enter the token. A private repository cannot be read without one.",
    };
  }

  // A throwaway cache so a test never disturbs the catalog the launcher is
  // currently running on.
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-config-test-"));
  try {
    const result = await resolveDynamicConfig(
      {
        url: settings.url,
        subpath: settings.subpath || DEFAULT_SUBPATH,
        cacheDir,
        timeoutMs: 20_000,
        offline: false,
        ...(settings.token ? { token: settings.token } : {}),
        ...(settings.username ? { username: settings.username } : {}),
        ...(settings.ref ? { ref: settings.ref } : {}),
        ...(settings.hostname ? { hostnameOverride: settings.hostname } : {}),
      },
      await defaultDeps(),
    );
    const count = result.provenance.entryCount;
    return {
      ok: true,
      message:
        `Connected. Using host file '${result.provenance.hostFile}' for zone ` +
        `'${result.provenance.zone}', which supplies ${count} ${count === 1 ? "entry" : "entries"}.`,
    };
  } catch (error) {
    const message = redactError(error, settings.token, settings.username);
    if (isCertificateError(error)) {
      return {
        ok: false,
        certificateProblem: true,
        message:
          `The server was reached but its certificate is not trusted: ${message} ` +
          "This is not a wrong URL or a bad token. Export the issuing certificate " +
          `authority to a file and set ${ENV.caCerts} to its path, then restart.`,
      };
    }
    return { ok: false, message };
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
