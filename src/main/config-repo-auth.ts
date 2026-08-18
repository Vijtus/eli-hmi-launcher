// Token plumbing and redaction for the git config repo.
//
// NFR1 — token hygiene. The token is supplied to isomorphic-git through an
// in-memory `onAuth` callback, which turns it into an `Authorization: Basic`
// header for the duration of the request only. It therefore never reaches:
//   - the process table / argv (no child process is spawned at all);
//   - the remote URL written to `.git/config` (isomorphic-git stores the clean
//     URL it was handed);
//   - any log line (every string leaving this module passes through
//     `redactSecret`, including git's own error text).
// tests/config-repo-auth.test.ts asserts each of those.

export const REDACTED = "[REDACTED]";

// GitHub, Gitea and Forgejo accept a personal access token as the HTTP Basic
// *username*, with a constant filler as the password half (never a real secret).
export const TOKEN_PASSWORD = "x-oauth-basic";

// Some forges need the other arrangement — a real username with the token as the
// password. GitLab deploy tokens are issued as a username/token pair and cannot
// authenticate the GitHub way at all; a GitLab personal or project access token
// works with any username (`oauth2` is the documented one), and a Bitbucket app
// password is paired with the account name. Setting
// ELI_LAUNCHER_CONFIG_REPO_USERNAME switches to that arrangement.
//
// Token auth over HTTPS is not subject to interactive 2FA on any of these forges:
// the token is itself the second factor, so an unattended control-room machine
// never needs a prompt.

export type GitAuthCredentials = {
  username: string;
  password: string;
};

export type AuthCallback = () => GitAuthCredentials;

// Returns `undefined` when no token is configured, so the caller omits `onAuth`
// entirely and isomorphic-git performs an anonymous clone (FR1).
export function createAuthCallback(
  token: string | undefined,
  username?: string | undefined,
): AuthCallback | undefined {
  const trimmedToken = token?.trim();
  if (!trimmedToken) {
    return undefined;
  }
  const trimmedUsername = username?.trim();
  if (trimmedUsername) {
    return () => ({ username: trimmedUsername, password: trimmedToken });
  }
  return () => ({ username: trimmedToken, password: TOKEN_PASSWORD });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every encoding of the token that could plausibly appear in an error string or
// an HTTP header echo. `username` must be supplied wherever it was used to build
// the credential, because the Basic blob is then base64(username:token) and
// carries the token in a form none of the others match.
function secretForms(token: string, username?: string | undefined): string[] {
  const forms = new Set<string>([token]);
  forms.add(Buffer.from(token, "utf8").toString("base64"));
  forms.add(Buffer.from(`${token}:${TOKEN_PASSWORD}`, "utf8").toString("base64"));
  forms.add(Buffer.from(`${token}:`, "utf8").toString("base64"));
  forms.add(encodeURIComponent(token));
  const trimmedUsername = username?.trim();
  if (trimmedUsername) {
    forms.add(Buffer.from(`${trimmedUsername}:${token}`, "utf8").toString("base64"));
  }
  // Base64 of a Basic header is often line-wrapped or padded off; also cover the
  // unpadded form so a truncated echo is still caught.
  for (const form of [...forms]) {
    const unpadded = form.replace(/=+$/, "");
    if (unpadded !== form && unpadded.length > 8) {
      forms.add(unpadded);
    }
  }
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

// Replaces every form of the token with `[REDACTED]`. Also strips userinfo from
// any URL in the text, so a `https://user:pass@host/...` string cannot leak even
// when the credential is not the configured token.
export function redactSecret(
  text: string,
  token: string | undefined,
  username?: string | undefined,
): string {
  let result = text;
  const trimmed = token?.trim();
  if (trimmed && trimmed.length >= 4) {
    for (const form of secretForms(trimmed, username)) {
      result = result.replace(new RegExp(escapeRegExp(form), "g"), REDACTED);
    }
  }
  // https://<userinfo>@host -> https://[REDACTED]@host
  result = result.replace(/(\bhttps?:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`);
  // Authorization: Basic <blob>
  result = result.replace(/\b(authorization\s*[:=]\s*)(?:basic|bearer|token)\s+\S+/gi, `$1${REDACTED}`);
  return result;
}

// Wraps an unknown thrown value into a message with every secret form removed.
export function redactError(
  error: unknown,
  token: string | undefined,
  username?: string | undefined,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecret(message, token, username);
}
