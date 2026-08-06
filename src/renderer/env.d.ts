import type { LauncherConfig, LaunchResult, RuntimeSnapshot } from "../shared/types";

declare global {
  interface Window {
    launcherApi: {
      getConfig(): Promise<LauncherConfig>;
      getRuntimeStates(): Promise<RuntimeSnapshot>;
      onRuntimeStates(listener: (snapshot: RuntimeSnapshot) => void): () => void;
      launchItem(itemId: string): Promise<LaunchResult>;
    };
  }
}
