export type WebLaunchable = {
  id: string;
  label: string;
  description?: string;
  type: "web";
  url: string;
};

export type ExecutableLaunchable = {
  id: string;
  label: string;
  description?: string;
  type: "executable";
  command: string;
  args?: string[];
  cwd?: string;
};

export type LaunchableItem = WebLaunchable | ExecutableLaunchable;

export type MenuNode = {
  label?: string;
  launchables?: LaunchableItem[];
  children?: MenuNode[];
};

export type LauncherConfig = {
  appName: string;
  menu: MenuNode[];
};

export type LaunchResult = {
  ok: true;
};
