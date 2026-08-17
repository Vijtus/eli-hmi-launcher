import { assertWebUrlAllowed, type LaunchContext } from "./config";
import { webLaunchError } from "./launch-errors";

export type OpenExternal = (url: string) => Promise<void>;

export async function launchWebTarget(
  configuredUrl: string,
  context: LaunchContext,
  openExternal: OpenExternal,
): Promise<string> {
  let resolvedUrl = configuredUrl;
  try {
    const parsed = assertWebUrlAllowed(configuredUrl, context);
    resolvedUrl = parsed.toString();
    await openExternal(resolvedUrl);
    return resolvedUrl;
  } catch (error) {
    throw webLaunchError(resolvedUrl, error);
  }
}
