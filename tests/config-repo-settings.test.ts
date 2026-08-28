import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearSettings,
  environmentWithSettings,
  loadSettings,
  overriddenByEnv,
  saveSettings,
  settingsPath,
  type SecretStore,
} from "../src/main/catalog/settings.ts";
import { ENV } from "../src/main/catalog/load.ts";

const TOKEN = "glpat-EXAMPLETOKENVALUE123456";

// Stands in for Electron's safeStorage. The "encryption" only has to be
// reversible and unlike the input, so the tests can tell ciphertext from
// plaintext when asserting that nothing readable reaches the disk.
function fakeSecrets(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf) => {
      const raw = buf.toString("utf8");
      if (!raw.startsWith("enc:")) {
        throw new Error("not encrypted by this store");
      }
      return raw.slice(4);
    },
  };
}

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "eli-settings-"));
}

test("nothing stored reads back as no settings rather than failing", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(loadSettings(dir, fakeSecrets()), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings survive a save and load, token included", () => {
  const dir = tempDir();
  try {
    const result = saveSettings(dir, fakeSecrets(), {
      url: "https://gitlab.example.org/lcs/config.git",
      username: "oauth2",
      token: TOKEN,
      subpath: "launcher",
      hostname: "BOX-01",
    });
    assert.equal(result.tokenStored, true);
    assert.deepEqual(loadSettings(dir, fakeSecrets()), {
      url: "https://gitlab.example.org/lcs/config.git",
      username: "oauth2",
      subpath: "launcher",
      hostname: "BOX-01",
      token: TOKEN,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The whole point of using safeStorage rather than a plain file.
test("the token never reaches the disk in readable form", () => {
  const dir = tempDir();
  try {
    saveSettings(dir, fakeSecrets(), { url: "https://x.example/c.git", token: TOKEN });
    const onDisk = readFileSync(settingsPath(dir), "utf8");
    assert.ok(!onDisk.includes(TOKEN), "token was written in clear text");
    assert.match(onDisk, /tokenEncrypted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Refusing is the right answer: writing it in clear "so it works" would be a
// silent downgrade the operator never agreed to.
test("with no secure storage the token is refused, not written in clear", () => {
  const dir = tempDir();
  try {
    const result = saveSettings(dir, fakeSecrets(false), {
      url: "https://x.example/c.git",
      username: "oauth2",
      token: TOKEN,
    });
    assert.equal(result.tokenStored, false);
    assert.match(result.reason ?? "", /no secure storage/i);
    assert.match(result.reason ?? "", new RegExp(ENV.token));

    const onDisk = readFileSync(settingsPath(dir), "utf8");
    assert.ok(!onDisk.includes(TOKEN));
    // Everything that is not secret is still saved.
    assert.equal(loadSettings(dir, fakeSecrets(false)).username, "oauth2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Happens when the file is copied to another machine or another user account.
test("a token that cannot be decrypted is dropped, not fatal", () => {
  const dir = tempDir();
  try {
    saveSettings(dir, fakeSecrets(), { url: "https://x.example/c.git", token: TOKEN });
    const foreign: SecretStore = {
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(p),
      decryptString: () => {
        throw new Error("decryption failed");
      },
    };
    const loaded = loadSettings(dir, foreign);
    assert.equal(loaded.token, undefined);
    assert.equal(loaded.url, "https://x.example/c.git", "the rest must still load");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt settings file does not stop the launcher starting", () => {
  const dir = tempDir();
  try {
    writeFileSync(settingsPath(dir), "{ this is not json");
    assert.deepEqual(loadSettings(dir, fakeSecrets()), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing removes the file and is safe to repeat", () => {
  const dir = tempDir();
  try {
    saveSettings(dir, fakeSecrets(), { url: "https://x.example/c.git", token: TOKEN });
    clearSettings(dir);
    clearSettings(dir);
    assert.deepEqual(loadSettings(dir, fakeSecrets()), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A machine configured by a deployment script must not be quietly overridden by
// something typed into the window months earlier.
test("the environment wins over stored settings", () => {
  const merged = environmentWithSettings(
    { [ENV.url]: "https://from-env.example/c.git" },
    { url: "https://from-ui.example/c.git", username: "oauth2", token: TOKEN },
  );
  assert.equal(merged[ENV.url], "https://from-env.example/c.git");
  // Fields the environment does not set are still filled from the stored ones.
  assert.equal(merged[ENV.username], "oauth2");
  assert.equal(merged[ENV.token], TOKEN);
});

test("a blank environment variable does not count as set", () => {
  const merged = environmentWithSettings({ [ENV.url]: "   " }, { url: "https://from-ui.example/c.git" });
  assert.equal(merged[ENV.url], "https://from-ui.example/c.git");
});

test("stored values that the environment overrides are reported, not hidden", () => {
  const overridden = overriddenByEnv(
    { [ENV.url]: "https://from-env.example/c.git", [ENV.token]: "t" },
    { url: "https://from-ui.example/c.git", token: TOKEN, username: "oauth2" },
  );
  assert.deepEqual(overridden.sort(), [ENV.token, ENV.url].sort());
});

test("nothing is reported as overridden when the environment is empty", () => {
  assert.deepEqual(overriddenByEnv({}, { url: "https://x.example/c.git", token: TOKEN }), []);
});
