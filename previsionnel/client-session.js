(() => {
  const connectionView = document.getElementById("connectionView");
  const applicationRoot = document.getElementById("applicationRoot");
  const status = document.getElementById("connectionStatus");
  let currentUser = null;
  const readOnlyCases = new Map();
  const originalDisabled = new WeakMap();

  function formatError(error) {
    return String(error?.message || error)
      .replace(/^Error invoking remote method '[^']+': Error: /, "");
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.dataset.state = isError ? "error" : "success";
    document.getElementById("retryServerConnection").hidden =
      !isError || !String(message).includes("Serveur central inaccessible");
  }

  function setApplicationAccess(user) {
    currentUser = user;
    applicationRoot.hidden = !user;
    connectionView.hidden = Boolean(user);
    document.body.dataset.role = user?.role || "";
    document.getElementById("adminPhaseButton").hidden = user?.role !== "admin";
    document.getElementById("currentUserLabel").textContent = user
      ? `${user.username} (${user.role})`
      : "";
    if (user) {
      document.getElementById("phaseSubtitle").textContent = "التكلفة التقديرية";
      document.querySelectorAll(".phase-tab").forEach((button) => {
        const active = button.id === "guPhaseButton";
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      document.getElementById("buttonSettingsView").hidden = true;
      document.getElementById("adminPhaseView").hidden = true;
      applyEditability();
      window.dispatchEvent(new CustomEvent("central-authenticated", { detail: user }));
    } else {
      document.getElementById("buttonSettingsView").hidden = true;
      document.getElementById("adminPhaseView").hidden = true;
      readOnlyCases.clear();
      applyEditability();
    }
  }

  function setDisabled(element, disabled) {
    if (!originalDisabled.has(element)) originalDisabled.set(element, element.disabled);
    element.disabled = disabled || originalDisabled.get(element);
  }

  function applyEditability() {
    const viewer = currentUser?.role === "viewer";
    const selectors = [
      ["#companyName, #guReference, #taxRate, #advanceRate", viewer || readOnlyCases.get("gu")],
      ["#newGuCase, #saveGuCase", viewer || readOnlyCases.get("gu")],
      ["#createRecCase, #newRecCase", viewer || readOnlyCases.get("rec")],
      ["#recReference, #recLotName, #recWorkGrid input", viewer || readOnlyCases.get("rec")],
      ["#workGrid input", viewer || readOnlyCases.get("gu")],
      ["#comparisonName, #comparisonInvoiceRows input", viewer],
      ["#newComparison, #addComparisonInvoice", viewer],
      ['[data-button-pref-key="gu.invoice.add"], [data-button-pref-key="gu.invoice.remove"]',
        viewer || readOnlyCases.get("gu")],
      ['[data-button-pref-key="rec.invoice.add"], [data-button-pref-key="rec.invoice.remove"]',
        viewer || readOnlyCases.get("rec")],
      ['[data-button-pref-key="comparison.invoice.remove"]', viewer]
    ];
    selectors.forEach(([selector, disabled]) => {
      document.querySelectorAll(selector).forEach((element) => setDisabled(element, disabled));
    });
    const linkButton = document.getElementById("linkRecToSelectedGu");
    if (linkButton) {
      linkButton.disabled = viewer || Boolean(readOnlyCases.get("rec")) ||
        linkButton.dataset.selectionDisabled === "true";
    }
    const saveComparisonButton = document.getElementById("saveComparison");
    if (saveComparisonButton) {
      saveComparisonButton.disabled = viewer ||
        saveComparisonButton.dataset.comparisonDisabled === "true";
    }
  }

  async function saveConnection() {
    const serverUrl = document.getElementById("serverAddress").value.trim();
    await window.lotissementAPI.setServerConnection(serverUrl);
    showStatus("Serveur central joignable; adresse enregistrée.");
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      const connection = await window.lotissementAPI.getServerConnection();
      document.getElementById("serverAddress").value = connection.serverUrl;
    } catch (error) {
      showStatus(`Configuration locale inaccessible: ${String(error.message || error)}`, true);
    }

    document.getElementById("serverConnectionForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await saveConnection();
      } catch (error) {
        showStatus(formatError(error), true);
      }
    });
    document.getElementById("retryServerConnection").addEventListener("click", () => {
      document.getElementById("serverConnectionForm").requestSubmit();
    });

    document.getElementById("serverLoginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await saveConnection();
        const user = await window.lotissementAPI.login({
          username: document.getElementById("loginUsername").value.trim(),
          password: document.getElementById("loginPassword").value
        });
        document.getElementById("loginPassword").value = "";
        setApplicationAccess(user);
        showStatus("");
      } catch (error) {
        showStatus(formatError(error), true);
      }
    });

    document.getElementById("serverBootstrapForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await saveConnection();
        const user = await window.lotissementAPI.bootstrapServerAdmin({
          serverUrl: document.getElementById("serverAddress").value.trim(),
          setupCode: document.getElementById("bootstrapCode").value,
          username: document.getElementById("bootstrapUsername").value.trim(),
          password: document.getElementById("bootstrapPassword").value
        });
        document.getElementById("bootstrapCode").value = "";
        document.getElementById("bootstrapPassword").value = "";
        setApplicationAccess(user);
        showStatus("");
      } catch (error) {
        showStatus(formatError(error), true);
      }
    });

    document.getElementById("logoutButton").addEventListener("click", async () => {
      try {
        await window.lotissementAPI.logout();
        currentUser = null;
        setApplicationAccess(null);
      } catch (error) {
        showStatus(`Déconnexion incomplète: ${String(error.message || error)}`, true);
      }
    });

    window.lotissementAPI.onServerAuthenticated((user) => setApplicationAccess(user));
    window.lotissementAPI.onServerAuthExpired((reason) => {
      setApplicationAccess(null);
      showStatus(reason === "restore"
        ? "La base a été restaurée; reconnectez-vous."
        : "Votre session a expiré; reconnectez-vous.");
    });
    window.lotissementAPI.onLockLost((lock) => {
      showStatus(`Verrou perdu pour le dossier ${lock.entityType.toUpperCase()} ${lock.entityId}. Rechargez-le.`, true);
      readOnlyCases.set(lock.entityType, true);
      applyEditability();
      window.dispatchEvent(new CustomEvent("central-lock-lost", { detail: lock }));
    });
    window.lotissementAPI.onServerEvent((change) => {
      if (change.actor === currentUser?.username) return;
      window.dispatchEvent(new CustomEvent("central-data-changed", { detail: change }));
    });
    window.addEventListener("central-case-lock-state", (event) => {
      readOnlyCases.set(event.detail.entityType, Boolean(event.detail.readOnly));
      applyEditability();
    });
    document.addEventListener("click", (event) => {
      const phaseButton = event.target instanceof Element
        ? event.target.closest(".phase-tab")
        : null;
      if (phaseButton && phaseButton.id !== "adminPhaseButton") {
        const adminView = document.getElementById("adminPhaseView");
        if (adminView) adminView.hidden = true;
        const adminButton = document.getElementById("adminPhaseButton");
        if (adminButton) {
          adminButton.classList.remove("active");
          adminButton.setAttribute("aria-pressed", "false");
        }
      }
    });
    const observer = new MutationObserver(() => applyEditability());
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
