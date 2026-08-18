// A local smart-HTTP git server for integration tests, backed by the `git
// http-backend` CGI that ships with git.
//
// This is a TEST-ONLY dependency on the git binary. The launcher runtime uses
// isomorphic-git and never requires git to be installed; the server exists only
// so the wire protocol is exercised for real instead of against a mock.
// `hasGitHttpBackend()` lets callers skip when the binary is absent.

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

const CANDIDATES = [
  "/usr/lib/git-core/git-http-backend",
  "/usr/libexec/git-core/git-http-backend",
  "/usr/local/libexec/git-core/git-http-backend",
  "/opt/homebrew/libexec/git-core/git-http-backend",
];

export function findGitHttpBackend(): string | undefined {
  for (const candidate of CANDIDATES) {
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not executable here; keep looking.
    }
  }
  return undefined;
}

export function hasGitHttpBackend(): boolean {
  return findGitHttpBackend() !== undefined;
}

export type GitHttpServer = {
  url: (repo: string) => string;
  port: number;
  close: () => Promise<void>;
  requests: string[];
};

export type GitHttpServerOptions = {
  // When set, requests must carry exactly this Authorization header value.
  requireAuthorization?: string;
};

export async function startGitHttpServer(
  projectRoot: string,
  options: GitHttpServerOptions = {},
): Promise<GitHttpServer> {
  const backend = findGitHttpBackend();
  if (!backend) {
    throw new Error("git http-backend is not available");
  }
  const requests: string[] = [];

  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (options.requireAuthorization) {
      const header = request.headers["authorization"];
      if (header !== options.requireAuthorization) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
        response.end("unauthorized");
        return;
      }
    }
    const parsed = new URL(request.url ?? "/", "http://localhost");
    const child = spawn(backend, [], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: parsed.pathname,
        QUERY_STRING: parsed.search.replace(/^\?/, ""),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        REMOTE_USER: "test",
      },
    });
    request.pipe(child.stdin);

    let buffered = Buffer.alloc(0);
    let headersSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const split = buffered.indexOf("\r\n\r\n");
      if (split === -1) {
        return;
      }
      const rawHeaders = buffered.subarray(0, split).toString("utf8");
      const body = buffered.subarray(split + 4);
      let status = 200;
      for (const line of rawHeaders.split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator === -1) {
          continue;
        }
        const name = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === "status") {
          status = Number.parseInt(value, 10) || 200;
        } else {
          response.setHeader(name, value);
        }
      }
      response.writeHead(status);
      if (body.length > 0) {
        response.write(body);
      }
      headersSent = true;
    });
    child.stdout.on("end", () => response.end());
    child.on("error", () => {
      if (!headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
    // http-backend chatter is not interesting unless a test fails.
    child.stderr.resume();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: (repo: string) => `http://127.0.0.1:${port}/${repo}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
