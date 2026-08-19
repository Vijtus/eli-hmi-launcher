# Bundled site catalog (not in git)

Drop a copy of the `launcher/` tree from `eli-eric/eli-hmi-config` here before
building, and the resulting app resolves its real catalog by hostname with no
network access and no token:

```
config-repo/
  launcher/
    host/<machine>.yaml    names a zone
    zone/<zone>.yaml       supplies the catalog
```

`config-repo/launcher/` is **gitignored on purpose**. That config repository is
private and this one is public, so the site's workspace paths, install roots and
internal hostnames must not be committed here. Only this README is tracked.

## How it is used

The bundled tree is read **only when `ELI_LAUNCHER_CONFIG_REPO_URL` is not set**,
so a machine that can reach the real repo always gets the live version and this
snapshot never shadows it. Provenance is reported as `(bundled)` rather than a
commit, and the field report says so, so a shipped catalog cannot be mistaken for
a freshly fetched one.

With no `launcher/` directory present the feature is simply inert, which is the
state of a fresh clone.

## Without rebuilding

`ELI_LAUNCHER_CONFIG_REPO_DIR=<path>` points at any checked-out tree. For a
portable build this is the practical route: put a `config-repo/` folder on the
USB stick beside the executable and set the variable, and the catalog can be
updated by replacing files rather than shipping a new binary.

## Security note

The config repo supplies **entries and `local:` settings only**. It cannot alter
`security.allowedCommandRoots` or `allowBareCommands` — those come from the local
config file and stay a trust root. A deployed machine therefore needs an
allow-list that covers wherever its GUIs live; `config/launcher.yaml` names
`${local.workspaceRoot}` and `${local.cssGuiRoot}` for that, which are dropped
harmlessly on a machine that has neither.
