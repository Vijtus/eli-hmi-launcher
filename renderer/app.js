const state = {
  appName: "ELI HMI Launcher",
  menu: [],
  path: [],
  mode: "tiles",
};

const appTitle = document.getElementById("app-title");
const statusBox = document.getElementById("status");
const tilesView = document.getElementById("tiles-view");
const treeView = document.getElementById("tree-view");
const tilesButton = document.getElementById("tiles-button");
const treeButton = document.getElementById("tree-button");

function setStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.style.color = isError ? "#fca5a5" : "#38bdf8";
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
    await window.launcherApi.launchItem(item.id);
    setStatus(`Launched: ${item.label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Launch failed: ${message}`, true);
  }
}

function renderBreadcrumbs(container) {
  const breadcrumbs = document.createElement("div");
  breadcrumbs.className = "breadcrumbs";
  breadcrumbs.appendChild(createButton("Root", () => {
    state.path = [];
    render();
  }));

  let nodes = state.menu;
  const pathSoFar = [];

  for (const index of state.path) {
    const node = nodes[index];

    if (!node) {
      break;
    }

    pathSoFar.push(index);
    breadcrumbs.appendChild(createButton(node.label ?? "Group", () => {
      state.path = [...pathSoFar];
      render();
    }));
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
    tile.append(title, description, createButton("Open", () => {
      state.path = [...state.path, index];
      render();
    }));
    grid.appendChild(tile);
  }

  for (const item of launchables) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const title = document.createElement("h3");
    title.textContent = item.label ?? item.id;
    const description = document.createElement("p");
    description.textContent = item.description ?? `${item.type} launchable`;
    tile.append(title, description, createButton("Launch", () => launchItem(item)));
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
    const label = document.createElement("p");
    label.className = "branch-label";
    label.textContent = node.label ?? "Group";
    branch.appendChild(label);

    const launchables = Array.isArray(node.launchables) ? node.launchables : [];

    for (const item of launchables) {
      const row = document.createElement("div");
      row.className = "launch-item";
      const launchButton = createButton(item.label ?? item.id, () => launchItem(item));
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = item.type;
      row.append(launchButton, kind);
      branch.appendChild(row);
    }

    const children = Array.isArray(node.children) ? node.children : [];

    if (children.length > 0) {
      branch.appendChild(renderTreeNodes(children));
    }

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
    const config = await window.launcherApi.getConfig();
    state.appName = config.appName ?? state.appName;
    state.menu = Array.isArray(config.menu) ? config.menu : [];
    appTitle.textContent = state.appName;
    setStatus(`Loaded ${state.menu.length} root groups`);
    render();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Config load failed: ${message}`, true);
  }
}

initialize();
