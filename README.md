# ELI HMIs Launcher

This repository is the codebase for a new CS HMIs launcher built with web technologies on top of Electron. The goal is to develop the launcher like a web application while still packaging and running it as a native desktop application that can execute machine code on the host system.

The project started by establishing a local offline documentation base for Electron so the implementation work can continue with the framework reference available directly in the repository.

## Project direction

We intend to develop a new CS HMIS launcher using web technologies with Electron, allowing it to be built like a web application while still executing native machine code.

## Ready-to-run launcher

A ready-to-run Electron launcher is now included with:

- YAML-driven launcher configuration in `config/launcher.yaml`
- Hierarchical navigation groups (for example `L2 > Motion > ...`)
- Two UI modes:
  - tile navigation mode for operator-friendly launch
  - compact tree mode for dense navigation
- Launchable item types:
  - `web` (opens URL in the default browser)
  - `executable` (spawns local executable, typically from machine PATH)

### Run locally

```sh
npm install
npm start
```

### Optional custom config path

Set `ELI_LAUNCHER_CONFIG` to point to an alternative YAML config file.

```sh
ELI_LAUNCHER_CONFIG=/absolute/path/to/launcher.yaml npm start
```

### YAML structure

```yaml
appName: Launcher name
menu:
  - label: Top level group
    children:
      - label: Subgroup
        launchables:
          - id: unique-item-id
            label: Operator label
            type: web
            url: "https://..."
          - id: another-id
            label: Local executable
            type: executable
            command: "MyApp.exe"
            args: ["--example"]
            cwd: "C:/Optional/WorkingDir"
```

## Offline Electron docs

The repository currently includes an offline Markdown mirror of the official Electron documentation under `docs/`.

To refresh the mirror from the repository root:

```sh
npm run sync:electron-docs
```

The sync script resolves the latest stable Electron tag, sparsely checks out the upstream `docs/` tree, mirrors Markdown files into `docs/electron/`, and regenerates the local index in `docs/README.md`.

Current docs scope is Markdown-only. Images, website assets, and Fiddle sources are intentionally excluded in this first implementation.
