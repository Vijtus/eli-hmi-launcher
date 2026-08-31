// Config-repo settings entered through the launcher instead of the environment.
//
// Setting six environment variables with `setx` is a reasonable thing to ask of
// a deployment script and an unreasonable thing to ask of an operator standing
// at a control-room workstation. This module lets the same settings be typed
// into the application and kept for next time.
//
// The token is encrypted at rest through the platform's own facility --
// DPAPI on Windows, Keychain on macOS, libsecret on Linux -- so it is bound to
// the user account and is not readable by simply opening the file. That is
// strictly better than an environment variable, which every process the user
// starts inherits and can read.
//
// Everything else is stored in clear text on purpose: a URL and a branch name
// are not secrets, and being able to read them with an editor is worth more than
// the illusion of protecting them.
//
// PRECEDENCE: the environment always wins. A machine configured by a deployment
// script must not be silently overridden by something typed here months ago, and
// the reverse would make an unattended rollout unpredictable. The UI reports
// which fields the environment is currently overriding rather than pretending
// the stored value is in effect.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ENV, type EnvLike } from "./load";

const SETTINGS_FILE = "config-repo-settings.json";

// The subset of Electron's safeStorage this module needs, injected so the whole
// thing is testable without an Electron runtime.
export type SecretStore = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type ConfigRepoSettings = {
  url?: string | undefined;
  username?: string | undefined;
  token?: string | undefined;
  ref?: string | undefined;
  subpath?: string | undefined;
  hostname?: string | undefined;
};

type StoredShape = {
  version: 1;
  url?: string;
  username?: string;
  ref?: string;
  subpath?: string;
  hostname?: string;
  // base64 of safeStorage.encryptString, or omitted when no token is stored.
  tokenEncrypted?: string;
  // Set when encryption was unavailable and the token could not be kept. The
  // token is never written in clear text as a fallback.
  tokenUnavailable?: boolean;
};

export function settingsPath(userDataDir: string): string {
  return path.join(userDataDir, SETTINGS_FILE);
}

function readStored(userDataDir: string): StoredShape | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(userDataDir), "utf8")) as StoredShape;
    return parsed && parsed.version === 1 ? parsed : undefined;
  } catch {
    // Absent, unreadable or corrupt all mean the same thing to the caller: there
    // is nothing stored. A broken file must not stop the launcher starting.
    return undefined;
  }
}

export function loadSettings(userDataDir: string, secrets: SecretStore): ConfigRepoSettings {
  const stored = readStored(userDataDir);
  if (!stored) {
    return {};
  }
  let token: string | undefined;
  if (stored.tokenEncrypted) {
    try {
      token = secrets.decryptString(Buffer.from(stored.tokenEncrypted, "base64"));
    } catch {
      // Decryption fails when the file was written by another user account or
      // the OS keyring changed. Treat it as "no token" rather than failing the
      // whole load; the UI can ask for it again.
      token = undefined;
    }
  }
  return {
    ...(stored.url ? { url: stored.url } : {}),
    ...(stored.username ? { username: stored.username } : {}),
    ...(stored.ref ? { ref: stored.ref } : {}),
    ...(stored.subpath ? { subpath: stored.subpath } : {}),
    ...(stored.hostname ? { hostname: stored.hostname } : {}),
    ...(token ? { token } : {}),
  };
}

export type SaveResult = { tokenStored: boolean; reason?: string };

export function saveSettings(
  userDataDir: string,
  secrets: SecretStore,
  settings: ConfigRepoSettings,
): SaveResult {
  mkdirSync(userDataDir, { recursive: true });
  const next: StoredShape = { version: 1 };
  if (settings.url) next.url = settings.url.trim();
  if (settings.username) next.username = settings.username.trim();
  if (settings.ref) next.ref = settings.ref.trim();
  if (settings.subpath) next.subpath = settings.subpath.trim();
  if (settings.hostname) next.hostname = settings.hostname.trim();

  let result: SaveResult = { tokenStored: false };
  const token = settings.token?.trim();
  if (token) {
    if (secrets.isEncryptionAvailable()) {
      next.tokenEncrypted = secrets.encryptString(token).toString("base64");
      result = { tokenStored: true };
    } else {
      // Refuse to write it in clear. The caller surfaces this so the operator
      // knows the token has to come from the environment on this machine.
      next.tokenUnavailable = true;
      result = {
        tokenStored: false,
        reason:
          "This system offers no secure storage, so the token was not saved. " +
          "Everything else was. Supply the token through " +
          `${ENV.token} instead.`,
      };
    }
  }

  const file = settingsPath(userDataDir);
  const temporary = `${file}.tmp`;
  // Written 0600 where the platform honours it: the encrypted token is bound to
  // this account anyway, but there is no reason to leave it world-readable.
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(file, readFileSync(temporary), { mode: 0o600 });
  try {
    unlinkSync(temporary);
  } catch {
    // A leftover temp file is untidy, not a failure.
  }
  return result;
}

export function clearSettings(userDataDir: string): void {
  try {
    unlinkSync(settingsPath(userDataDir));
  } catch {
    // Already gone.
  }
}

// Which stored fields the environment is currently overriding. The UI shows
// these so a value that is saved but not in effect is visible rather than
// mysterious.
export function overriddenByEnv(env: EnvLike, settings: ConfigRepoSettings): string[] {
  const pairs: Array<[keyof ConfigRepoSettings, string]> = [
    ["url", ENV.url],
    ["username", ENV.username],
    ["token", ENV.token],
    ["ref", ENV.ref],
    ["subpath", ENV.subpath],
    ["hostname", ENV.hostname],
  ];
  return pairs
    .filter(([key, name]) => settings[key] && (env[name] ?? "").trim().length > 0)
    .map(([, name]) => name);
}

// Produces an environment for readDynamicConfigEnv with the stored settings
// filled in underneath whatever the real environment already provides. The
// caller passes the result straight through, so no resolution logic changes and
// there is exactly one place where the two sources meet.
export function environmentWithSettings(env: EnvLike, settings: ConfigRepoSettings): EnvLike {
  const merged: EnvLike = { ...env };
  const fill = (name: string, value: string | undefined): void => {
    if (value && !(merged[name] ?? "").trim()) {
      merged[name] = value;
    }
  };
  fill(ENV.url, settings.url);
  fill(ENV.username, settings.username);
  fill(ENV.token, settings.token);
  fill(ENV.ref, settings.ref);
  fill(ENV.subpath, settings.subpath);
  fill(ENV.hostname, settings.hostname);
  return merged;
}
