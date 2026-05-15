# ELI HMIs Launcher

This repository is the codebase for a new CS HMIS launcher built with web technologies on top of Electron. The goal is to develop the launcher like a web application while still packaging and running it as a native desktop application that can execute machine code on the host system.

The project started by establishing a local offline documentation base for Electron so the implementation work can continue with the framework reference available directly in the repository.

## Project direction

We intend to develop a new CS HMIS launcher using web technologies with Electron, allowing it to be built like a web application while still executing native machine code.

## Offline Electron docs

The repository currently includes an offline Markdown mirror of the official Electron documentation under `docs/`.

To refresh the mirror from the repository root:

```sh
npm run sync:electron-docs
```

The sync script resolves the latest stable Electron tag, sparsely checks out the upstream `docs/` tree, mirrors Markdown files into `docs/electron/`, and regenerates the local index in `docs/README.md`.

Current docs scope is Markdown-only. Images, website assets, and Fiddle sources are intentionally excluded in this first implementation.
