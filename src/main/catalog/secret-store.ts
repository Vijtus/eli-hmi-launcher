// Electron's safeStorage behind the SecretStore shape, so everything that
// touches settings stays testable without an Electron runtime.
//
// safeStorage encrypts through the platform: DPAPI on Windows, Keychain on
// macOS, and libsecret/kwallet on Linux. On a Linux box with no keyring running
// it reports itself unavailable, which the caller must handle rather than
// falling back to writing the token in clear.

import { safeStorage } from "electron";
import type { SecretStore } from "./settings";

export function electronSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        // Called before the app is ready, or on a build without the module.
        return false;
      }
    },
    encryptString: (plainText: string) => safeStorage.encryptString(plainText),
    decryptString: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
  };
}
