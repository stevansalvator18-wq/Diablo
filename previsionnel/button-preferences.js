(() => {
  const buttonsByKey = new Map();
  const defaultsByKey = new Map();
  const groupLabels = {
    general: "التنقل العام",
    gu: "التكلفة التقديرية (GU)",
    rec: "التكلفة الحقيقية (REC)",
    comparison: "المقارنة",
    settings: "الإعدادات"
  };
  let savedPreferences = {};
  let workingPreferences = {};

  const clonePreferences = (preferences) =>
    JSON.parse(JSON.stringify(preferences || {}));

  function parseColor(value) {
    const rgb = value.match(/rgba?\(([^)]+)\)/i);
    if (rgb) {
      const parts = rgb[1].split(",").map((part) => Number.parseFloat(part.trim()));
      if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
        return {
          red: parts[0],
          green: parts[1],
          blue: parts[2],
          alpha: Number.isFinite(parts[3]) ? parts[3] : 1
        };
      }
    }

    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const digits = hex[1].length === 3
        ? hex[1].split("").map((digit) => digit + digit).join("")
        : hex[1];
      return {
        red: Number.parseInt(digits.slice(0, 2), 16),
        green: Number.parseInt(digits.slice(2, 4), 16),
        blue: Number.parseInt(digits.slice(4, 6), 16),
        alpha: 1
      };
    }
    return null;
  }

  function composite(foreground, background) {
    const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
    if (!alpha) return { red: 255, green: 255, blue: 255, alpha: 1 };
    return {
      red: (foreground.red * foreground.alpha +
        background.red * background.alpha * (1 - foreground.alpha)) / alpha,
      green: (foreground.green * foreground.alpha +
        background.green * background.alpha * (1 - foreground.alpha)) / alpha,
      blue: (foreground.blue * foreground.alpha +
        background.blue * background.alpha * (1 - foreground.alpha)) / alpha,
      alpha
    };
  }

  function toHex(color) {
    return `#${[color.red, color.green, color.blue]
      .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function backgroundHex(button) {
    let background = { red: 0, green: 0, blue: 0, alpha: 0 };
    const layers = [];
    let element = button;
    while (element) {
      const layer = parseColor(getComputedStyle(element).backgroundColor);
      if (layer) layers.push(layer);
      element = element.parentElement;
    }
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      background = composite(layers[index], background);
    }
    if (background.alpha < 1) {
      background = composite(background, { red: 255, green: 255, blue: 255, alpha: 1 });
    }
    return toHex(background);
  }

  function opaqueTextHex(button, background) {
    const color = parseColor(getComputedStyle(button).color);
    return color ? toHex(composite(color, parseColor(background))) : "#000000";
  }

  function resolveGroup(button, key) {
    if (button.closest("#buttonSettingsView")) return "settings";
    if (button.closest("#comparisonPhaseView")) return "comparison";
    if (button.closest("#recPhaseView")) return "rec";
    if (button.closest('[data-phase="gu"]') || key.startsWith("gu.")) return "gu";
    return "general";
  }

  function preferenceKey(button) {
    return button.dataset.buttonPrefKey || button.id || "";
  }

  function registerButton(button) {
    if (!(button instanceof HTMLButtonElement) || button.dataset.buttonPrefPreview === "true") {
      return;
    }
    const key = preferenceKey(button);
    if (!key) return;

    let instances = buttonsByKey.get(key);
    if (!instances) {
      instances = new Set();
      buttonsByKey.set(key, instances);
    }
    if (instances.has(button)) return;
    instances.add(button);

    if (!defaultsByKey.has(key)) {
      const background = backgroundHex(button);
      defaultsByKey.set(key, {
        label: button.textContent.trim(),
        backgroundColor: background,
        textColor: opaqueTextHex(button, background),
        group: resolveGroup(button, key)
      });
    }
    applyButton(button, key);
  }

  function scanButtons(root = document) {
    if (root instanceof HTMLButtonElement) registerButton(root);
    root.querySelectorAll?.("button").forEach(registerButton);
  }

  function applyButton(button, key) {
    const defaults = defaultsByKey.get(key);
    if (!defaults) return;
    const preference = workingPreferences[key] || {};
    button.textContent = preference.label || defaults.label;
    if (preference.backgroundColor || preference.textColor) {
      button.classList.add("button-preference-managed");
      button.style.setProperty(
        "--button-preference-background",
        preference.backgroundColor || defaults.backgroundColor
      );
      button.style.setProperty(
        "--button-preference-text",
        preference.textColor || defaults.textColor
      );
    } else {
      button.classList.remove("button-preference-managed");
      button.style.removeProperty("--button-preference-background");
      button.style.removeProperty("--button-preference-text");
    }
  }

  function applyAll() {
    buttonsByKey.forEach((instances, key) => {
      instances.forEach((button) => applyButton(button, key));
    });
  }

  function settingFor(key) {
    return workingPreferences[key] || {};
  }

  function setPreferenceValue(key, field, value, defaultValue) {
    const preference = { ...settingFor(key) };
    if (value === defaultValue) {
      delete preference[field];
    } else {
      preference[field] = value;
    }
    if (Object.keys(preference).length) {
      workingPreferences[key] = preference;
    } else {
      delete workingPreferences[key];
    }
  }

  function relativeLuminance(hex) {
    const color = parseColor(hex);
    const channels = [color.red, color.green, color.blue].map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  function hasSufficientContrast() {
    for (const [key, defaults] of defaultsByKey) {
      const preference = workingPreferences[key] || {};
      const foreground = relativeLuminance(preference.textColor || defaults.textColor);
      const background = relativeLuminance(
        preference.backgroundColor || defaults.backgroundColor
      );
      if ((Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05) < 4.5) {
        return false;
      }
    }
    return true;
  }

  function setStatus(message, isError = false) {
    const status = document.getElementById("buttonSettingsStatus");
    status.textContent = message;
    status.classList.toggle("button-settings-warning", isError);
  }

  function updateContrastStatus() {
    if (hasSufficientContrast()) {
      setStatus("يمكنك معاينة التغييرات قبل حفظها.");
      return true;
    }
    setStatus("اختر لونين يحققان تبايناً لا يقل عن 4.5:1 قبل الحفظ.", true);
    return false;
  }

  function renderSettings() {
    const list = document.getElementById("buttonSettingsList");
    const groups = new Map();
    defaultsByKey.forEach((defaults, key) => {
      if (!groups.has(defaults.group)) groups.set(defaults.group, []);
      groups.get(defaults.group).push([key, defaults]);
    });

    list.replaceChildren();
    groups.forEach((buttons, group) => {
      const section = document.createElement("section");
      section.className = "button-settings-group";
      const heading = document.createElement("h3");
      heading.textContent = groupLabels[group] || groupLabels.general;
      section.append(heading);

      buttons.forEach(([key, defaults]) => {
        const preference = settingFor(key);
        const row = document.createElement("div");
        row.className = "button-settings-row";
        row.dataset.buttonSettingsKey = key;

        const currentLabel = document.createElement("span");
        currentLabel.textContent = preference.label || defaults.label;

        const labelField = document.createElement("label");
        labelField.append("التسمية الجديدة");
        const labelInput = document.createElement("input");
        labelInput.type = "text";
        labelInput.maxLength = 80;
        labelInput.value = preference.label || defaults.label;
        labelField.append(labelInput);

        const backgroundField = document.createElement("label");
        backgroundField.append("لون الخلفية");
        const backgroundInput = document.createElement("input");
        backgroundInput.type = "color";
        backgroundInput.value = preference.backgroundColor || defaults.backgroundColor;
        backgroundField.append(backgroundInput);

        const textField = document.createElement("label");
        textField.append("لون النص");
        const textInput = document.createElement("input");
        textInput.type = "color";
        textInput.value = preference.textColor || defaults.textColor;
        textField.append(textInput);

        const preview = document.createElement("button");
        preview.type = "button";
        preview.disabled = true;
        preview.className = "button-settings-preview";
        preview.dataset.buttonPrefPreview = "true";
        preview.textContent = labelInput.value;
        preview.style.backgroundColor = backgroundInput.value;
        preview.style.color = textInput.value;

        const resetColors = document.createElement("label");
        resetColors.append("ألوان افتراضية");
        const resetInput = document.createElement("input");
        resetInput.type = "checkbox";
        resetInput.checked = !preference.backgroundColor && !preference.textColor;
        resetColors.append(resetInput);

        const updateRow = () => {
          setPreferenceValue(
            key,
            "label",
            labelInput.value.trim() || defaults.label,
            defaults.label
          );
          preview.textContent = labelInput.value.trim() || defaults.label;
          preview.style.backgroundColor = backgroundInput.value;
          preview.style.color = textInput.value;
          resetInput.checked = !settingFor(key).backgroundColor &&
            !settingFor(key).textColor;
          applyAll();
          updateContrastStatus();
        };
        labelInput.addEventListener("input", updateRow);
        backgroundInput.addEventListener("input", () => {
          setPreferenceValue(
            key,
            "backgroundColor",
            backgroundInput.value.toLowerCase(),
            defaults.backgroundColor
          );
          resetInput.checked = false;
          updateRow();
        });
        textInput.addEventListener("input", () => {
          setPreferenceValue(
            key,
            "textColor",
            textInput.value.toLowerCase(),
            defaults.textColor
          );
          resetInput.checked = false;
          updateRow();
        });
        resetInput.addEventListener("change", () => {
          if (!resetInput.checked) return;
          setPreferenceValue(key, "backgroundColor", defaults.backgroundColor, defaults.backgroundColor);
          setPreferenceValue(key, "textColor", defaults.textColor, defaults.textColor);
          backgroundInput.value = defaults.backgroundColor;
          textInput.value = defaults.textColor;
          updateRow();
        });

        row.append(currentLabel, labelField, backgroundField, textField, preview, resetColors);
        section.append(row);
      });
      list.append(section);
    });
    updateContrastStatus();
  }

  function showSettings() {
    document.querySelectorAll('[data-phase="gu"]').forEach((element) => {
      element.hidden = true;
    });
    document.getElementById("recPhaseView").hidden = true;
    document.getElementById("comparisonPhaseView").hidden = true;
    document.getElementById("buttonSettingsView").hidden = false;
    document.querySelectorAll(".phase-tab").forEach((button) => {
      const active = button.id === "settingsPhaseButton";
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.getElementById("phaseSubtitle").textContent = "الإعدادات";
    renderSettings();
  }

  async function saveSettings() {
    if (!hasSufficientContrast()) {
      updateContrastStatus();
      return;
    }
    try {
      savedPreferences = await window.lotissementAPI.saveButtonPreferences(
        workingPreferences
      );
      workingPreferences = clonePreferences(savedPreferences);
      applyAll();
      renderSettings();
      setStatus("تم حفظ إعدادات الأزرار.");
    } catch (error) {
      setStatus(`تعذر حفظ إعدادات الأزرار: ${String(error.message || error)}`, true);
    }
  }

  async function restoreDefaults() {
    if (!window.confirm("هل تريد استعادة التسميات والألوان الافتراضية لجميع الأزرار؟")) {
      return;
    }
    try {
      savedPreferences = await window.lotissementAPI.saveButtonPreferences({});
      workingPreferences = {};
      applyAll();
      renderSettings();
      setStatus("تمت استعادة إعدادات الأزرار الافتراضية.");
    } catch (error) {
      setStatus(`تعذر استعادة الإعدادات الافتراضية: ${String(error.message || error)}`, true);
    }
  }

  async function loadSavedPreferences() {
    try {
      savedPreferences = await window.lotissementAPI.loadButtonPreferences();
      workingPreferences = clonePreferences(savedPreferences);
      scanButtons();
      applyAll();
      if (!document.getElementById("buttonSettingsView").hidden) renderSettings();
      setStatus("تم تحميل إعدادات الأزرار المحفوظة.");
    } catch (error) {
      setStatus(`تعذر تحميل إعدادات الأزرار: ${String(error.message || error)}`, true);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) scanButtons(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanButtons();

    document.getElementById("settingsPhaseButton").addEventListener("click", showSettings);
    document.getElementById("saveButtonSettings").addEventListener("click", saveSettings);
    document.getElementById("cancelButtonSettings").addEventListener("click", () => {
      workingPreferences = clonePreferences(savedPreferences);
      applyAll();
      renderSettings();
      setStatus("تم إلغاء التعديلات غير المحفوظة.");
    });
    document.getElementById("restoreButtonSettings")
      .addEventListener("click", restoreDefaults);
    document.addEventListener("click", (event) => {
      const phaseButton = event.target instanceof Element
        ? event.target.closest(".phase-tab")
        : null;
      if (phaseButton && phaseButton.id !== "settingsPhaseButton") {
        const settingsButton = document.getElementById("settingsPhaseButton");
        settingsButton.classList.remove("active");
        settingsButton.setAttribute("aria-pressed", "false");
        document.getElementById("buttonSettingsView").hidden = true;
      }
    });

    window.addEventListener("central-authenticated", loadSavedPreferences);
    if (!document.getElementById("buttonSettingsView").hidden) renderSettings();
  });
})();
