const state = {
  appName: "ELI HMI Launcher",
  menu: [],
  path: [],
  mode: "tiles",
};

const appTitle = document.getElementById("app-title");
const mainElement = document.querySelector("main");
const tilesView = document.getElementById("tiles-view");
const treeView = document.getElementById("tree-view");
const tilesButton = document.getElementById("tiles-button");
const treeButton = document.getElementById("tree-button");

function setError(message) {
  const existingError = document.getElementById("error-banner");

  if (!message) {
    existingError?.remove();
    return;
  }

  if (existingError) {
    existingError.textContent = message;
    return;
  }

  const errorBanner = document.createElement("section");
  errorBanner.id = "error-banner";
  errorBanner.className = "error-banner";
  errorBanner.textContent = message;
  mainElement.prepend(errorBanner);
}

function createButton(label, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function getNodeByPath() {
  let currentNodes = state.menu;
  let currentNode = null;

  for (const index of state.path) {
    currentNode = currentNodes[index] ?? null;

    if (!currentNode) {
      break;
    }

    currentNodes = Array.isArray(currentNode.children) ? currentNode.children : [];
  }

  return {
    currentNode,
    currentNodes,
  };
}

async function launchItem(item) {
  try {
    if (!window.launcherApi?.launchItem) {
      throw new Error("Launcher API is unavailable. Check that the preload script loaded correctly.");
    }

    await window.launcherApi.launchItem(item.id);
    setError("");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(`Launch failed: ${message}`);
  }
}

function renderBreadcrumbs(container) {
  const breadcrumbs = document.createElement("div");
  breadcrumbs.className = "breadcrumbs";

  function appendBreadcrumb(label, onClick, isCurrent = false) {
    if (breadcrumbs.childElementCount > 0) {
      const separator = document.createElement("span");
      separator.className = "breadcrumb-separator";
      separator.textContent = ">";
      breadcrumbs.appendChild(separator);
    }

    if (isCurrent) {
      const current = document.createElement("span");
      current.className = "breadcrumb-current";
      current.textContent = label;
      breadcrumbs.appendChild(current);
      return;
    }

    const link = document.createElement("a");
    link.className = "breadcrumb-link";
    link.href = "#";
    link.textContent = label;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    breadcrumbs.appendChild(link);
  }

  appendBreadcrumb(
    "Root",
    () => {
      state.path = [];
      render();
    },
    state.path.length === 0,
  );

  let nodes = state.menu;
  const pathSoFar = [];

  for (const [pathIndex, index] of state.path.entries()) {
    const node = nodes[index];

    if (!node) {
      break;
    }

    pathSoFar.push(index);
    const breadcrumbPath = [...pathSoFar];
    appendBreadcrumb(
      node.label ?? "Group",
      () => {
        state.path = breadcrumbPath;
        render();
      },
      pathIndex === state.path.length - 1,
    );
    nodes = Array.isArray(node.children) ? node.children : [];
  }

  container.appendChild(breadcrumbs);
}

function renderTiles() {
  tilesView.innerHTML = "";
  renderBreadcrumbs(tilesView);

  const { currentNode, currentNodes } = getNodeByPath();
  const visibleGroups = state.path.length === 0 ? state.menu : currentNodes;
  const launchables = Array.isArray(currentNode?.launchables) ? currentNode.launchables : [];
  const grid = document.createElement("div");
  grid.className = "tiles-grid";

  for (const [index, group] of visibleGroups.entries()) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const title = document.createElement("h3");
    title.textContent = group.label ?? "Group";
    const description = document.createElement("p");
    description.textContent = "Open group";
    tile.append(
      title,
      description,
      createButton("Open", () => {
        state.path = [...state.path, index];
        render();
      }),
    );
    grid.appendChild(tile);
  }

  for (const item of launchables) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const title = document.createElement("h3");
    title.textContent = item.label ?? item.id;
    const description = document.createElement("p");
    description.textContent = item.description ?? `${item.type} launchable`;
    tile.append(
      title,
      description,
      createButton("Launch", () => launchItem(item)),
    );
    grid.appendChild(tile);
  }

  tilesView.appendChild(grid);
}

function renderTreeNodes(nodes) {
  const list = document.createElement("ul");
  list.className = "tree-list";

  for (const node of nodes) {
    const branch = document.createElement("li");
    branch.className = "tree-branch";
    const launchables = Array.isArray(node.launchables) ? node.launchables : [];
    const children = Array.isArray(node.children) ? node.children : [];

    if (launchables.length > 0 || children.length > 0) {
      const details = document.createElement("details");
      details.className = "tree-node";

      const summary = document.createElement("summary");
      summary.className = "branch-label";
      summary.textContent = node.label ?? "Group";
      details.appendChild(summary);

      const content = document.createElement("div");
      content.className = "tree-node-content";

      for (const item of launchables) {
        const row = document.createElement("div");
        row.className = "launch-item";
        const launchButton = createButton(item.label ?? item.id, () => launchItem(item));
        row.appendChild(launchButton);
        content.appendChild(row);
      }

      if (children.length > 0) {
        content.appendChild(renderTreeNodes(children));
      }

      details.appendChild(content);
      branch.appendChild(details);
      list.appendChild(branch);
      continue;
    }

    const label = document.createElement("p");
    label.className = "branch-label";
    label.textContent = node.label ?? "Group";
    branch.appendChild(label);

    list.appendChild(branch);
  }

  return list;
}

function renderTree() {
  treeView.innerHTML = "";
  treeView.appendChild(renderTreeNodes(state.menu));
}

function render() {
  tilesButton.classList.toggle("active", state.mode === "tiles");
  treeButton.classList.toggle("active", state.mode === "tree");
  tilesView.classList.toggle("active", state.mode === "tiles");
  treeView.classList.toggle("active", state.mode === "tree");
  renderTiles();
  renderTree();
}

tilesButton.addEventListener("click", () => {
  state.mode = "tiles";
  render();
});

treeButton.addEventListener("click", () => {
  state.mode = "tree";
  render();
});

async function initialize() {
  try {
    if (!window.launcherApi?.getConfig) {
      throw new Error("Launcher API is unavailable. Check that the preload script loaded correctly.");
    }

    const config = await window.launcherApi.getConfig();
    state.appName = config.appName ?? state.appName;
    state.menu = Array.isArray(config.menu) ? config.menu : [];
    appTitle.textContent = state.appName;
    setError("");
    render();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(`Config load failed: ${message}`);
  }
}

initialize();
