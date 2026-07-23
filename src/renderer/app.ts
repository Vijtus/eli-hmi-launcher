import "@picocss/pico/css/pico.min.css";
import "./styles.css";

import { filterLauncherRows, getUniqueMultiValues } from "../shared/filtering";
import { statusForLaunchResult } from "../shared/launch-status";
import { createCombobox } from "./combobox";
import type { LauncherAction, LauncherConfig, LauncherRow } from "../shared/types";

type AppState = {
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
  search: string;
  technology: string;
  section: string;
};

const state: AppState = {
  rows: [],
  quickActions: [],
  moreActions: [],
  search: "",
  technology: "",
  section: "",
};

const quickActionsElement = document.getElementById("quick-actions") as HTMLElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const technologyMount = document.getElementById("technology-filter") as HTMLElement;
const sectionMount = document.getElementById("section-filter") as HTMLElement;
const statusBanner = document.getElementById("status-banner") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const statusDismiss = document.getElementById("status-dismiss") as HTMLButtonElement;
const rowsElement = document.getElementById("launcher-rows") as HTMLTableSectionElement;
const rowCountElement = document.getElementById("row-count") as HTMLParagraphElement;

const technologyFilter = createCombobox({
  mount: technologyMount,
  labelId: "technology-label",
  placeholderLabel: "Select",
  onChange: (value) => {
    state.technology = value;
    render();
  },
});

const sectionFilter = createCombobox({
  mount: sectionMount,
  labelId: "section-label",
  placeholderLabel: "Select",
  onChange: (value) => {
    state.section = value;
    render();
  },
});

function displayList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "--";
}

function setStatus(message: string, isError = false): void {
  if (!message) {
    statusBanner.hidden = true;
    statusText.textContent = "";
    statusBanner.classList.remove("error");
    return;
  }

  statusBanner.hidden = false;
  statusText.textContent = message;
  statusBanner.classList.toggle("error", isError);
}

function createButton(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) {
    button.className = className;
  }
  button.addEventListener("click", onClick);
  return button;
}

async function launchItem(itemId: string, label: string): Promise<void> {
  try {
    if (!window.launcherApi?.launchItem) {
      throw new Error("Launcher API is unavailable. Check that the preload script loaded correctly.");
    }

    const result = await window.launcherApi.launchItem(itemId);
    const status = statusForLaunchResult(result);
    if (status) {
      setStatus(status.message, status.isError);
    } else {
      // Successful launches are intentionally silent. Clear any stale error.
      setStatus("");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Launch failed: ${label} — ${message}`, true);
  }
}

function closeMoreMenu(): void {
  const menu = quickActionsElement.querySelector<HTMLDetailsElement>("details.dropdown");
  if (menu) {
    menu.removeAttribute("open");
  }
}

function renderQuickActions(): void {
  quickActionsElement.innerHTML = "";

  for (const action of state.quickActions) {
    quickActionsElement.appendChild(
      createButton(action.label, () => void launchItem(action.id, action.label)),
    );
  }

  if (state.moreActions.length === 0) {
    return;
  }

  // Pico dropdown component: <details class="dropdown"> gives us an accessible
  // disclosure (keyboard toggle, native expanded state) styled by the library.
  const details = document.createElement("details");
  details.className = "dropdown";

  const summary = document.createElement("summary");
  summary.setAttribute("role", "button");
  summary.textContent = "More...";

  const list = document.createElement("ul");
  for (const action of state.moreActions) {
    const item = document.createElement("li");
    item.appendChild(
      createButton(action.label, () => {
        details.removeAttribute("open");
        void launchItem(action.id, action.label);
      }),
    );
    list.appendChild(item);
  }

  details.append(summary, list);
  quickActionsElement.appendChild(details);
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
  const rows = filterLauncherRows(state.rows, {
    search: state.search,
    technology: state.technology,
    section: state.section,
  });
  rowsElement.innerHTML = "";

  if (rows.length === 0) {
    const emptyRow = document.createElement("tr");
    const emptyCell = document.createElement("td");
    emptyCell.colSpan = 6;
    emptyCell.className = "empty-row";
    emptyCell.textContent = "No GUIs match the current filters.";
    emptyRow.appendChild(emptyCell);
    rowsElement.appendChild(emptyRow);
    rowCountElement.textContent = `0 of ${state.rows.length} GUIs shown`;
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

  rowCountElement.textContent = `${rows.length} of ${state.rows.length} GUIs shown`;
}

function render(): void {
  renderRows();
}

function applyConfig(config: LauncherConfig): void {
  state.rows = Array.isArray(config.rows) ? config.rows : [];
  state.quickActions = Array.isArray(config.quickActions) ? config.quickActions : [];
  state.moreActions = Array.isArray(config.moreActions) ? config.moreActions : [];

  technologyFilter.setOptions(getUniqueMultiValues(state.rows, "technology").map((value) => ({ value, label: value })));
  sectionFilter.setOptions(getUniqueMultiValues(state.rows, "section").map((value) => ({ value, label: value })));
  renderQuickActions();
  render();
}

searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  render();
});

statusDismiss.addEventListener("click", () => {
  setStatus("");
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
