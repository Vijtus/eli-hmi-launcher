// Accessible select-only combobox (ARIA Authoring Practices "Select-Only
// Combobox" pattern). Used for the Technology and Section filters instead of a
// native <select>, whose popup list is drawn by the OS and cannot be themed
// consistently across Linux/Windows/macOS — the source of the reported
// light/dark inconsistency. This control renders its own listbox, so every
// state (closed, focused, open, active option) is styled by the same fixed
// black-and-white Pico token palette on every platform.
//
// Keyboard support: Enter/Space/Arrow to open; Up/Down/Home/End to move the
// active option; type-ahead; Enter/Space to choose; Escape to close; Tab to
// leave. Visual focus is tracked with aria-activedescendant while DOM focus
// stays on the combobox, so screen readers announce the active option.

export type ComboboxOption = { value: string; label: string };

export type ComboboxHandle = {
  setOptions(options: ComboboxOption[]): void;
  getValue(): string;
};

// Pure helper (unit-tested): find the option index matching an accumulated
// type-ahead string, searching from `from` and wrapping once. Case-insensitive.
export function matchOptionByTypeahead(
  labels: string[],
  query: string,
  from: number,
): number {
  if (!query) {
    return -1;
  }
  const needle = query.toLowerCase();
  const count = labels.length;
  for (let step = 0; step < count; step += 1) {
    const index = (from + step) % count;
    if (labels[index].toLowerCase().startsWith(needle)) {
      return index;
    }
  }
  return -1;
}

export type ComboboxIds = {
  controlId: string;
  listboxId: string;
  valueId: string;
};

// Derive the element ids owned by one combobox instance.
// `baseId` belongs to the caller-supplied mount element, so every id returned
// here must differ from it: duplicate id attributes are invalid HTML and make
// document.getElementById(baseId) resolve to the mount instead of the control.
export function deriveComboboxIds(baseId: string): ComboboxIds {
  return {
    controlId: `${baseId}-control`,
    listboxId: `${baseId}-listbox`,
    valueId: `${baseId}-value`,
  };
}

export function comboboxOptionId(baseId: string, index: number): string {
  return `${baseId}-option-${index}`;
}

export function createCombobox(config: {
  mount: HTMLElement;
  labelId: string;
  placeholderLabel: string;
  onChange: (value: string) => void;
}): ComboboxHandle {
  const { mount, labelId, placeholderLabel, onChange } = config;

  let options: ComboboxOption[] = [{ value: "", label: placeholderLabel }];
  let selectedIndex = 0;
  let activeIndex = 0;
  let open = false;

  let typeahead = "";
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

  const baseId = mount.id || `combobox-${Math.random().toString(36).slice(2)}`;
  const { listboxId, controlId, valueId } = deriveComboboxIds(baseId);

  const combo = document.createElement("div");
  combo.className = "combobox-control";
  combo.setAttribute("role", "combobox");
  combo.setAttribute("tabindex", "0");
  combo.setAttribute("aria-haspopup", "listbox");
  combo.setAttribute("aria-expanded", "false");
  combo.setAttribute("aria-controls", listboxId);
  // Accessible name = visible label + current value. The value span is
  // referenced directly so the name does not depend on id-collision ordering.
  combo.setAttribute("aria-labelledby", `${labelId} ${valueId}`);
  combo.id = controlId;

  const valueText = document.createElement("span");
  valueText.className = "combobox-value";
  valueText.id = valueId;
  combo.appendChild(valueText);

  const listbox = document.createElement("ul");
  listbox.className = "combobox-listbox";
  listbox.id = listboxId;
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-labelledby", labelId);
  listbox.hidden = true;

  mount.classList.add("combobox");
  mount.append(combo, listbox);

  function optionId(index: number): string {
    return comboboxOptionId(baseId, index);
  }

  function renderValue(): void {
    valueText.textContent = options[selectedIndex]?.label ?? placeholderLabel;
    valueText.classList.toggle("is-placeholder", selectedIndex === 0);
  }

  function renderOptions(): void {
    listbox.innerHTML = "";
    options.forEach((option, index) => {
      const item = document.createElement("li");
      item.id = optionId(index);
      item.className = "combobox-option";
      item.setAttribute("role", "option");
      item.textContent = option.label;
      item.setAttribute("aria-selected", String(index === selectedIndex));
      item.classList.toggle("is-active", open && index === activeIndex);
      item.addEventListener("mousedown", (event) => {
        // Prevent the control from losing focus before we handle the choice.
        event.preventDefault();
      });
      item.addEventListener("click", () => {
        selectIndex(index);
        closeList();
      });
      listbox.appendChild(item);
    });
  }

  function updateActiveDescendant(): void {
    if (open) {
      combo.setAttribute("aria-activedescendant", optionId(activeIndex));
    } else {
      combo.removeAttribute("aria-activedescendant");
    }
    options.forEach((_, index) => {
      const el = document.getElementById(optionId(index));
      el?.classList.toggle("is-active", open && index === activeIndex);
    });
    if (open) {
      document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    }
  }

  function openList(startIndex = selectedIndex): void {
    if (open) {
      return;
    }
    open = true;
    activeIndex = startIndex;
    listbox.hidden = false;
    combo.setAttribute("aria-expanded", "true");
    updateActiveDescendant();
  }

  function closeList(): void {
    if (!open) {
      return;
    }
    open = false;
    listbox.hidden = true;
    combo.setAttribute("aria-expanded", "false");
    updateActiveDescendant();
  }

  function selectIndex(index: number): void {
    if (index < 0 || index >= options.length) {
      return;
    }
    const changed = index !== selectedIndex;
    selectedIndex = index;
    activeIndex = index;
    renderValue();
    options.forEach((_, i) => {
      document.getElementById(optionId(i))?.setAttribute("aria-selected", String(i === selectedIndex));
    });
    if (changed) {
      onChange(options[selectedIndex].value);
    }
  }

  function moveActive(delta: number): void {
    const next = Math.min(options.length - 1, Math.max(0, activeIndex + delta));
    activeIndex = next;
    updateActiveDescendant();
  }

  function handleTypeahead(char: string): void {
    typeahead += char;
    if (typeaheadTimer) {
      clearTimeout(typeaheadTimer);
    }
    typeaheadTimer = setTimeout(() => {
      typeahead = "";
    }, 500);

    const labels = options.map((option) => option.label);
    const from = open ? (activeIndex + 1) % labels.length : selectedIndex;
    const match = matchOptionByTypeahead(labels, typeahead, from);
    if (match < 0) {
      return;
    }
    if (open) {
      activeIndex = match;
      updateActiveDescendant();
    } else {
      selectIndex(match);
    }
  }

  combo.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          openList();
        } else {
          moveActive(1);
        }
        return;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          openList();
        } else {
          moveActive(-1);
        }
        return;
      case "Home":
        if (open) {
          event.preventDefault();
          activeIndex = 0;
          updateActiveDescendant();
        }
        return;
      case "End":
        if (open) {
          event.preventDefault();
          activeIndex = options.length - 1;
          updateActiveDescendant();
        }
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) {
          selectIndex(activeIndex);
          closeList();
        } else {
          openList();
        }
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          closeList();
        }
        return;
      case "Tab":
        closeList();
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          handleTypeahead(event.key);
        }
    }
  });

  combo.addEventListener("click", () => {
    if (open) {
      closeList();
    } else {
      openList();
    }
  });

  combo.addEventListener("blur", () => {
    closeList();
  });

  renderValue();
  renderOptions();

  return {
    setOptions(next: ComboboxOption[]): void {
      const previousValue = options[selectedIndex]?.value ?? "";
      options = [{ value: "", label: placeholderLabel }, ...next];
      const restored = options.findIndex((option) => option.value === previousValue);
      selectedIndex = restored >= 0 ? restored : 0;
      activeIndex = selectedIndex;
      renderValue();
      renderOptions();
      updateActiveDescendant();
    },
    getValue(): string {
      return options[selectedIndex]?.value ?? "";
    },
  };
}
