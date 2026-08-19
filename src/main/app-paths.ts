import path from "node:path";

// ---------------------------------------------------------------------------
// Where the launcher looks for its own files.
//
// Split out of index.ts so the rules can be tested without an Electron runtime:
// every input is passed in, nothing is read from `app` or `process` here.
// ---------------------------------------------------------------------------

export const CONFIG_FILE_NAME = "launcher.yaml";

export type AppLocation = {
  /** Electron `app.isPackaged`. */
  isPackaged: boolean;
  /** Electron `app.getAppPath()`. Inside `app.asar` when packaged. */
  appPath: string;
  /** Electron `process.resourcesPath`: the real directory that holds `app.asar`. */
  resourcesPath?: string | undefined;
  /** Directory holding the running executable. */
  executableDir: string;
  /** Process working directory. */
  cwd: string;
  /** Electron `app.getPath("userData")`. */
  userDataDir: string;
};

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

// `${APP_ROOT}` in every config file, and the base for the default config
// candidates below.
//
// In development this is the project directory, so `${APP_ROOT}/examples/...`
// points into the checked-out tree. Packaged, `app.getAppPath()` is
// `<resources>/app.asar` — a path *inside* an archive, which the OS cannot stat
// or spawn, so a packaged build would resolve every configured command to a
// file that does not exist. `config/` and `examples/` ship as electron-builder
// `extraResources` and therefore land beside `app.asar` in `<resources>`, which
// makes the resources directory the packaged equivalent of the project
// directory and keeps every `${APP_ROOT}/...` reference pointing at a real file.
export function resolveAppRoot(
  location: Pick<AppLocation, "isPackaged" | "appPath" | "resourcesPath">,
): string {
  if (location.isPackaged && location.resourcesPath) {
    return location.resourcesPath;
  }
  return location.appPath;
}

// Ordered, most-specific-first. `ELI_LAUNCHER_CONFIG` overrides all of these and
// is handled by the caller.
export function buildConfigCandidates(location: AppLocation): string[] {
  const appRoot = resolveAppRoot(location);
  const bundled = path.join(appRoot, "config", CONFIG_FILE_NAME);
  const besideExecutable = path.join(location.executableDir, "config", CONFIG_FILE_NAME);

  if (location.isPackaged) {
    return uniquePaths([
      // An installed app sits in a read-only, admin-owned directory, so the
      // operator's own catalog has to live somewhere user-writable and has to
      // win over the bundled example. `cwd` is deliberately NOT consulted when
      // packaged: an installed launcher is started from arbitrary directories
      // and the config decides which commands get spawned, so picking one up
      // from the working directory would be a launch-anything footgun.
      path.join(location.userDataDir, CONFIG_FILE_NAME),
      bundled,
      besideExecutable,
    ]);
  }

  return uniquePaths([
    path.join(location.cwd, "config", CONFIG_FILE_NAME),
    bundled,
    location.resourcesPath ? path.join(location.resourcesPath, "config", CONFIG_FILE_NAME) : "",
    besideExecutable,
  ]);
}
