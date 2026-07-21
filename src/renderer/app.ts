import type { LauncherAction, LauncherConfig, LauncherRow } from "../shared/types";

type MultiValueFilterKey = "technology" | "section";

type AppState = {
  appName: string;
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
  search: string;
  technology: string;
  section: string;
  platform: string;
};

const state: AppState = {
  appName: "L4 Launcher",
  rows: [],
  quickActions: [],
  moreActions: [],
  search: "",
  technology: "",
  section: "",
  platform: "",
};

const appTitle = document.getElementById("app-title") as HTMLHeadingElement;
const quickActionsElement = document.getElementById("quick-actions") as HTMLElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const technologyFilter = document.getElementById("technology-filter") as HTMLSelectElement;
const sectionFilter = document.getElementById("section-filter") as HTMLSelectElement;
const platformFilter = document.getElementById("platform-filter") as HTMLSelectElement;
const statusBanner = document.getElementById("status-banner") as HTMLElement;
const rowsElement = document.getElementById("launcher-rows") as HTMLTableSectionElement;
const rowCountElement = document.getElementById("row-count") as HTMLParagraphElement;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function displayList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "--";
}

function setStatus(message: string, isError = false): void {
  if (!message) {
    statusBanner.hidden = true;
    statusBanner.textContent = "";
    statusBanner.classList.remove("error");
    return;
  }

  statusBanner.hidden = false;
  statusBanner.textContent = message;
  statusBanner.classList.toggle("error", isError);
}

function createButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function launchItem(itemId: string, label: string): Promise<void> {
  try {
    if (!window.launcherApi?.launchItem) {
      throw new Error("Launcher API is unavailable. Check that the preload script loaded correctly.");
    }

    const result = await window.launcherApi.launchItem(itemId);
    if (result.ok) {
      // "request sent" (not "launched"): process targets are fire-and-forget,
      // so a successful spawn does not guarantee the GUI stayed up.
      setStatus(`Launch request sent: ${label}`);
    } else {
      setStatus(`Launch failed: ${label} — ${result.error}`, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Launch failed: ${message}`, true);
  }
}

function matchesSearch(row: LauncherRow): boolean {
  const query = normalize(state.search);
  if (!query) {
    return true;
  }

  const haystack = normalize(
    [row.name, displayList(row.technology), displayList(row.section), row.platform, row.rmc, row.note].join(" "),
  );

  return haystack.includes(query);
}

function matchesFilters(row: LauncherRow): boolean {
  const technologyMatches = !state.technology || row.technology.includes(state.technology);
  const sectionMatches = !state.section || row.section.includes(state.section);
  const platformMatches = !state.platform || row.platform === state.platform;

  return technologyMatches && sectionMatches && platformMatches;
}

function getFilteredRows(): LauncherRow[] {
  return state.rows.filter((row) => matchesSearch(row) && matchesFilters(row));
}

function getUniqueMultiValues(rows: LauncherRow[], key: MultiValueFilterKey): string[] {
  const values = new Set<string>();

  for (const row of rows) {
    for (const value of row[key]) {
      if (value && value !== "--") {
        values.add(value);
      }
    }
  }

  return [...values].sort((left, right) => left.localeCompare(right));
}

function getUniquePlatformValues(rows: LauncherRow[]): string[] {
  const values = new Set<string>();

  for (const row of rows) {
    if (row.platform && row.platform !== "--") {
      values.add(row.platform);
    }
  }

  return [...values].sort((left, right) => left.localeCompare(right));
}

function populateSelect(select: HTMLSelectElement, values: string[]): void {
  const currentValue = select.value;
  select.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Select";
  select.appendChild(defaultOption);

  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }

  if (values.includes(currentValue)) {
    select.value = currentValue;
  }
}

function closeMoreMenu(): void {
  const menu = quickActionsElement.querySelector<HTMLElement>(".more-menu");
  if (menu) {
    menu.hidden = true;
  }
}

function renderQuickActions(): void {
  quickActionsElement.innerHTML = "";

  for (const action of state.quickActions) {
    quickActionsElement.appendChild(createButton(action.label, () => void launchItem(action.id, action.label)));
  }

  if (state.moreActions.length === 0) {
    return;
  }

  const moreWrapper = document.createElement("div");
  moreWrapper.className = "more-wrapper";

  const moreMenu = document.createElement("div");
  moreMenu.className = "more-menu";
  moreMenu.hidden = true;

  const moreButton = createButton("More...", () => {
    moreMenu.hidden = !moreMenu.hidden;
  });

  for (const action of state.moreActions) {
    moreMenu.appendChild(
      createButton(action.label, () => {
        moreMenu.hidden = true;
        void launchItem(action.id, action.label);
      }),
    );
  }

  moreWrapper.append(moreButton, moreMenu);
  quickActionsElement.appendChild(moreWrapper);
}

function appendCell(rowElement: HTMLTableRowElement, value: string, className?: string): void {
  const cell = document.createElement("td");
  cell.textContent = value || "--";

  if (className) {
    cell.className = className;
  }

  rowElement.appendChild(cell);
}

function renderRows(): void {
  const rows = getFilteredRows();
  rowsElement.innerHTML = "";

  if (rows.length === 0) {
    const emptyRow = document.createElement("tr");
    const emptyCell = document.createElement("td");
    emptyCell.colSpan = 6;
    emptyCell.className = "empty-row";
    emptyCell.textContent = "No GUIs match the current filters.";
    emptyRow.appendChild(emptyCell);
    rowsElement.appendChild(emptyRow);
    rowCountElement.textContent = `0 / ${state.rows.length} GUIs`;
    return;
  }

  for (const row of rows) {
    const rowElement = document.createElement("tr");
    rowElement.tabIndex = 0;
    rowElement.title = `Launch ${row.name}`;
    rowElement.addEventListener("click", () => void launchItem(row.id, row.name));
    rowElement.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void launchItem(row.id, row.name);
      }
    });

    appendCell(rowElement, row.name, "name-cell");
    appendCell(rowElement, displayList(row.technology));
    appendCell(rowElement, displayList(row.section));
    appendCell(rowElement, row.platform);
    appendCell(rowElement, row.rmc);
    appendCell(rowElement, row.note);
    rowsElement.appendChild(rowElement);
  }

  rowCountElement.textContent = `${rows.length} / ${state.rows.length} GUIs`;
}

function render(): void {
  renderRows();
}

function applyConfig(config: LauncherConfig): void {
  state.appName = config.appName || state.appName;
  state.rows = Array.isArray(config.rows) ? config.rows : [];
  state.quickActions = Array.isArray(config.quickActions) ? config.quickActions : [];
  state.moreActions = Array.isArray(config.moreActions) ? config.moreActions : [];

  appTitle.textContent = state.appName;
  populateSelect(technologyFilter, getUniqueMultiValues(state.rows, "technology"));
  populateSelect(sectionFilter, getUniqueMultiValues(state.rows, "section"));
  populateSelect(platformFilter, getUniquePlatformValues(state.rows));
  renderQuickActions();
  render();
}

searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  render();
});

technologyFilter.addEventListener("change", () => {
  state.technology = technologyFilter.value;
  render();
});

sectionFilter.addEventListener("change", () => {
  state.section = sectionFilter.value;
  render();
});

platformFilter.addEventListener("change", () => {
  state.platform = platformFilter.value;
  render();
});

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof Node) || quickActionsElement.contains(target)) {
    return;
  }

  closeMoreMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMoreMenu();
  }
});

async function initialize(): Promise<void> {
  try {
    if (!window.launcherApi?.getConfig) {
      throw new Error("Launcher API is unavailable. Check that the preload script loaded correctly.");
    }

    const config = await window.launcherApi.getConfig();
    setStatus("");
    applyConfig(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Config load failed: ${message}`, true);
  }
}

void initialize();
