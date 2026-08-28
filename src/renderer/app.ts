import "./styles.css";

import { catalogStalenessMessage } from "../shared/catalog-status";
import { filterLauncherRows, getUniqueMultiValues } from "../shared/filtering";
import { statusForLaunchResult } from "../shared/launch-status";
import type {
  LauncherAction,
  LauncherConfig,
  LauncherRow,
  RuntimeItemState,
  RuntimeSnapshot,
  RepoSettingsInput,
} from "../shared/types";

type AppState = {
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
  search: string;
  technology: string;
  section: string;
  runtimeById: Map<string, RuntimeItemState>;
};

const state: AppState = {
  rows: [],
  quickActions: [],
  moreActions: [],
  search: "",
  technology: "",
  section: "",
  runtimeById: new Map(),
};

const quickActionsElement = document.getElementById("quick-actions") as HTMLElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const technologyFilter = document.getElementById("technology-filter") as HTMLSelectElement;
const sectionFilter = document.getElementById("section-filter") as HTMLSelectElement;
const statusBanner = document.getElementById("status-banner") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const statusDismiss = document.getElementById("status-dismiss") as HTMLButtonElement;
const rowsElement = document.getElementById("launcher-rows") as HTMLTableSectionElement;
const rowCountElement = document.getElementById("row-count") as HTMLParagraphElement;
const catalogStalenessElement = document.getElementById("catalog-staleness") as HTMLParagraphElement;
const fieldReportElement = document.getElementById("field-report-banner") as HTMLParagraphElement;
const configLocationElement = document.getElementById("config-location") as HTMLParagraphElement;
const configLocationText = document.getElementById("config-location-text") as HTMLSpanElement;
const configLocationOpen = document.getElementById("config-location-open") as HTMLButtonElement;
const appTitle = document.getElementById("app-title") as HTMLElement;
const siteName = document.getElementById("site-name") as HTMLElement;

function displayList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "--";
}

function setStatus(message: string, isError = false): void {
  statusBanner.hidden = !message;
  statusText.textContent = message;
  statusBanner.classList.toggle("error", isError);
}

function createButton(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.addEventListener("click", onClick);
  return button;
}

async function launchItem(itemId: string, label: string): Promise<void> {
  try {
    const result = await window.launcherApi.launchItem(itemId);
    const status = statusForLaunchResult(result);
    setStatus(status?.message ?? "", status?.isError ?? false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Launch failed: ${label} — ${message}`, true);
  }
}

function closeMoreMenu(): void {
  quickActionsElement.querySelector<HTMLDetailsElement>("details.more-actions")?.removeAttribute("open");
}

function renderQuickActions(): void {
  quickActionsElement.replaceChildren();
  for (const action of state.quickActions) {
    quickActionsElement.appendChild(createButton(action.label, () => void launchItem(action.id, action.label)));
  }

  if (state.moreActions.length === 0) {
    return;
  }

  const details = document.createElement("details");
  details.className = "more-actions";
  const summary = document.createElement("summary");
  summary.textContent = "More…";
  const list = document.createElement("ul");
  for (const action of state.moreActions) {
    const item = document.createElement("li");
    item.appendChild(createButton(action.label, () => {
      details.removeAttribute("open");
      void launchItem(action.id, action.label);
    }));
    list.appendChild(item);
  }
  details.append(summary, list);
  quickActionsElement.appendChild(details);
}

function appendCell(row: HTMLTableRowElement, value: string, className = ""): void {
  const cell = document.createElement("td");
  cell.textContent = value || "--";
  cell.className = className;
  row.appendChild(cell);
}

function appendLaunchCell(row: HTMLTableRowElement, item: LauncherRow): void {
  const cell = document.createElement("td");
  cell.className = "name-cell";
  cell.appendChild(createButton(item.name, () => void launchItem(item.id, item.name), "launch-button"));
  row.appendChild(cell);
}

function runtimeLabel(runtime: RuntimeItemState | undefined): string {
  if (!runtime) return "--";
  if (runtime.stale) return "STALE";
  if (runtime.status === "running") return runtime.runningInstances > 1 ? `RUNNING ${runtime.runningInstances}` : "RUNNING";
  if (runtime.status === "shared") return "SHARED";
  if (runtime.status === "handed-off") return "HANDOFF";
  if (runtime.status === "stopped") return "STOPPED";
  return "UNKNOWN";
}

function appendRuntimeCell(row: HTMLTableRowElement, runtime: RuntimeItemState | undefined): void {
  const cell = document.createElement("td");
  cell.className = "runtime-state-cell";
  cell.textContent = runtimeLabel(runtime);
  cell.dataset.runtimeStatus = runtime?.stale ? "stale" : (runtime?.status ?? "unobserved");
  cell.title = runtime?.detail ?? "No launch has been observed in this launcher session.";
  cell.setAttribute("aria-label", runtime ? `Runtime state: ${cell.textContent}. ${runtime.detail}` : "Runtime state: no launch observed.");
  row.appendChild(cell);
}

function renderRows(): void {
  const rows = filterLauncherRows(state.rows, {
    search: state.search,
    technology: state.technology,
    section: state.section,
  });
  rowsElement.replaceChildren();

  if (rows.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty-row";
    cell.textContent = "No GUIs match the current filters.";
    row.appendChild(cell);
    rowsElement.appendChild(row);
  } else {
    for (const item of rows) {
      const row = document.createElement("tr");
      appendLaunchCell(row, item);
      appendCell(row, displayList(item.technology));
      appendCell(row, displayList(item.section));
      appendCell(row, item.platform);
      appendCell(row, item.rmc);
      appendRuntimeCell(row, state.runtimeById.get(item.id));
      appendCell(row, item.note);
      rowsElement.appendChild(row);
    }
  }

  rowCountElement.textContent = `${rows.length} of ${state.rows.length} GUIs shown`;
}

function setSelectOptions(select: HTMLSelectElement, values: string[]): void {
  const current = select.value;
  select.replaceChildren(new Option("All", ""), ...values.map((value) => new Option(value, value)));
  select.value = values.includes(current) ? current : "";
}

function applyRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  state.runtimeById = new Map(snapshot.items.map((item) => [item.id, item]));
  renderRows();
}

function applyConfig(config: LauncherConfig): void {
  appTitle.textContent = config.productName;
  document.title = config.siteName ? `${config.productName} — ${config.siteName}` : config.productName;
  siteName.textContent = config.siteName ?? "";
  siteName.hidden = !config.siteName;

  state.rows = config.rows;
  state.quickActions = config.quickActions;
  state.moreActions = config.moreActions;

  const staleness = catalogStalenessMessage(config.catalogStatus);
  catalogStalenessElement.hidden = !staleness;
  catalogStalenessElement.textContent = staleness ?? "";

  setSelectOptions(technologyFilter, getUniqueMultiValues(state.rows, "technology"));
  setSelectOptions(sectionFilter, getUniqueMultiValues(state.rows, "section"));
  renderQuickActions();
  renderRows();
}

async function showConfigLocation(): Promise<void> {
  const location = await window.launcherApi.getConfigLocation();
  if (!location) return;
  configLocationText.textContent = location.editable
    ? `CONFIG: ${location.path}`
    : `CONFIG (built in, not editable): ${location.path}`;
  configLocationOpen.hidden = !location.editable;
  configLocationElement.hidden = false;
}

async function showFieldReportBanner(): Promise<void> {
  const report = await window.launcherApi.getFieldReport();
  if (!report) return;
  fieldReportElement.textContent = `RECORDING DIAGNOSTICS → ${report.reportPath}`;
  fieldReportElement.hidden = false;
}

searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  renderRows();
});
technologyFilter.addEventListener("change", () => {
  state.technology = technologyFilter.value;
  renderRows();
});
sectionFilter.addEventListener("change", () => {
  state.section = sectionFilter.value;
  renderRows();
});
statusDismiss.addEventListener("click", () => setStatus(""));
configLocationOpen.addEventListener("click", () => void window.launcherApi.revealConfig());
document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !quickActionsElement.contains(event.target)) closeMoreMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMoreMenu();
});

async function initialize(): Promise<void> {
  try {
    const [config, runtime] = await Promise.all([
      window.launcherApi.getConfig(),
      window.launcherApi.getRuntimeStates(),
    ]);
    window.launcherApi.onRuntimeStates(applyRuntimeSnapshot);
    applyConfig(config);
    applyRuntimeSnapshot(runtime);
    await Promise.all([showConfigLocation(), showFieldReportBanner()]);
  } catch (error) {
    setStatus(`Config load failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

void initialize();

// ---------------------------------------------------------------------------
// Configuration screen.
//
// Setting six environment variables is a fine thing to ask of a deployment
// script and a poor thing to ask of an operator at a workstation. This is the
// same settings by another route; the environment still wins, and the screen
// says so when it does.
// ---------------------------------------------------------------------------

const settingsDialog = document.getElementById("settings-dialog") as HTMLDialogElement | null;

if (settingsDialog) {
  const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  const openButton = document.getElementById("open-settings") as HTMLButtonElement;
  const urlField = field("settings-url");
  const usernameField = field("settings-username");
  const tokenField = field("settings-token");
  const subpathField = field("settings-subpath");
  const refField = field("settings-ref");
  const hostnameField = field("settings-hostname");
  const tokenHint = document.getElementById("settings-token-hint") as HTMLElement;
  const hostnameHint = document.getElementById("settings-hostname-hint") as HTMLElement;
  const envNote = document.getElementById("settings-env-note") as HTMLElement;
  const storageNote = document.getElementById("settings-storage-note") as HTMLElement;
  const result = document.getElementById("settings-result") as HTMLElement;
  const testButton = document.getElementById("settings-test") as HTMLButtonElement;
  const clearButton = document.getElementById("settings-clear") as HTMLButtonElement;
  const cancelButton = document.getElementById("settings-cancel") as HTMLButtonElement;
  const saveButton = document.getElementById("settings-save") as HTMLButtonElement;

  function say(message: string, tone: "ok" | "bad" | "busy"): void {
    result.textContent = message;
    result.dataset["tone"] = tone;
    result.hidden = false;
  }

  function collect(): RepoSettingsInput {
    return {
      url: urlField.value,
      username: usernameField.value,
      token: tokenField.value,
      ref: refField.value,
      subpath: subpathField.value,
      hostname: hostnameField.value,
    };
  }

  async function fill(): Promise<void> {
    const view = await window.launcherApi.getRepoSettings();
    urlField.value = view.url;
    usernameField.value = view.username;
    subpathField.value = view.subpath;
    refField.value = view.ref;
    hostnameField.value = view.hostname;
    tokenField.value = "";

    tokenField.placeholder = view.tokenStored ? "stored — leave empty to keep it" : "";
    tokenHint.textContent = view.secureStorageAvailable
      ? "Stored encrypted by the operating system. Never shown again."
      : "This system offers no secure storage, so a token cannot be saved here.";

    hostnameHint.textContent =
      `This machine is “${view.machineName}”. The repository must hold a host file of that ` +
      "name; enter another machine's name to borrow its file.";

    storageNote.hidden = view.secureStorageAvailable;
    storageNote.textContent = view.secureStorageAvailable
      ? ""
      : "No secure storage on this system. Everything except the token can be saved here; " +
        "the token has to come from the environment.";

    envNote.hidden = view.overriddenByEnv.length === 0;
    envNote.textContent =
      view.overriddenByEnv.length === 0
        ? ""
        : `Set in the environment and therefore in charge: ${view.overriddenByEnv.join(", ")}. ` +
          "Values saved here are kept but do not take effect until those are removed.";

    result.hidden = true;
  }

  openButton?.addEventListener("click", () => {
    void fill().then(() => settingsDialog.showModal());
  });

  cancelButton.addEventListener("click", () => settingsDialog.close());

  testButton.addEventListener("click", () => {
    say("Connecting…", "busy");
    testButton.disabled = true;
    void window.launcherApi
      .testRepoSettings(collect())
      .then((outcome) => say(outcome.message, outcome.ok ? "ok" : "bad"))
      .catch((error: unknown) => say(String(error), "bad"))
      .finally(() => {
        testButton.disabled = false;
      });
  });

  saveButton.addEventListener("click", () => {
    void window.launcherApi
      .saveRepoSettings(collect())
      .then(async (outcome) => {
        say(
          outcome.message ?? "Saved. The launcher has to restart to read the catalog again.",
          outcome.message ? "bad" : "ok",
        );
        tokenField.value = "";
        await fill();
        if (!outcome.message) {
          await window.launcherApi.restartApp();
        }
      })
      .catch((error: unknown) => say(String(error), "bad"));
  });

  clearButton.addEventListener("click", () => {
    void window.launcherApi
      .clearRepoSettings()
      .then(async () => {
        await fill();
        say("Cleared. The launcher will use the local launcher.yaml after a restart.", "ok");
      })
      .catch((error: unknown) => say(String(error), "bad"));
  });
}
