(() => {
  const get = (id) => document.getElementById(id);

  function setStatus(message, isError = false) {
    const status = get("adminStatus");
    status.textContent = message;
    status.dataset.state = isError ? "error" : "success";
  }

  function activateAdminView() {
    document.querySelectorAll('[data-phase="gu"]').forEach((section) => {
      section.hidden = true;
    });
    get("recPhaseView").hidden = true;
    get("comparisonPhaseView").hidden = true;
    get("buttonSettingsView").hidden = true;
    get("adminPhaseView").hidden = false;
    document.querySelectorAll(".phase-tab").forEach((button) => {
      const active = button.id === "adminPhaseButton";
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    get("phaseSubtitle").textContent = "إدارة الخادم";
    void refreshAdmin();
  }

  function renderUsers(users, currentUser) {
    const list = get("userList");
    list.replaceChildren();
    users.forEach((user) => {
      const row = document.createElement("div");
      row.className = "admin-user-row";
      const name = document.createElement("strong");
      name.textContent = user.username;
      const role = document.createElement("select");
      [["admin", "Administrateur"], ["editor", "Éditeur"], ["viewer", "Lecture seule"]]
        .forEach(([value, label]) => role.add(new Option(label, value)));
      role.value = user.role;
      role.disabled = user.id === currentUser.id;
      const disabledLabel = document.createElement("label");
      disabledLabel.append("Désactivé ");
      const disabled = document.createElement("input");
      disabled.type = "checkbox";
      disabled.checked = Boolean(user.disabled);
      disabled.disabled = user.id === currentUser.id;
      disabledLabel.append(disabled);
      const password = document.createElement("input");
      password.type = "password";
      password.placeholder = "Nouveau mot de passe (facultatif)";
      password.minLength = 12;
      password.maxLength = 256;
      password.autocomplete = "new-password";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "add-btn";
      save.dataset.buttonPrefKey = "admin.user.update";
      save.textContent = "Mettre à jour";
      save.addEventListener("click", async () => {
        try {
          await window.lotissementAPI.updateUser(user.id, {
            role: role.value,
            disabled: disabled.checked,
            password: password.value || undefined
          });
          password.value = "";
          setStatus(`Compte ${user.username} mis à jour.`);
          await refreshAdmin();
        } catch (error) {
          setStatus(String(error.message || error), true);
        }
      });
      row.append(name, role, disabledLabel, password, save);
      list.append(row);
    });
  }

  async function refreshAdmin() {
    try {
      const [user, users, settings, backups, audit] = await Promise.all([
        window.lotissementAPI.getCurrentUser(),
        window.lotissementAPI.listUsers(),
        window.lotissementAPI.loadAdminSettings(),
        window.lotissementAPI.listBackups(),
        window.lotissementAPI.listAuditEvents()
      ]);
      renderUsers(users, user);
      get("backupTime").value = settings.backupTime;
      get("lockLeaseSeconds").value = settings.lockLeaseSeconds;
      get("databasePath").value = settings.databasePath;
      get("backupDirectory").value = settings.backupDirectory;
      const backupSelect = get("backupSelect");
      backupSelect.replaceChildren(new Option("Choisir une sauvegarde à restaurer", ""));
      backups.forEach((backup) => backupSelect.add(
        new Option(`${backup.name} (${Math.ceil(backup.size / 1024)} Ko)`, backup.name)
      ));
      get("auditList").replaceChildren();
      audit.forEach((item) => {
        const row = document.createElement("p");
        row.textContent = `${item.createdAt} — ${item.actor} — ${item.action} — ${item.entityType} ${item.entityId || ""}`;
        get("auditList").append(row);
      });
      setStatus("Administration synchronisée.");
    } catch (error) {
      setStatus(`Impossible de charger l’administration: ${String(error.message || error)}`, true);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    get("adminPhaseButton").addEventListener("click", activateAdminView);
    get("refreshAdminButton").addEventListener("click", refreshAdmin);
    get("createUserForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await window.lotissementAPI.createUser({
          username: get("newUsername").value.trim(),
          password: get("newUserPassword").value,
          role: get("newUserRole").value
        });
        get("newUsername").value = "";
        get("newUserPassword").value = "";
        setStatus("Compte créé.");
        await refreshAdmin();
      } catch (error) {
        setStatus(String(error.message || error), true);
      }
    });
    get("adminSettingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await window.lotissementAPI.saveAdminSettings({
          backupTime: get("backupTime").value,
          lockLeaseSeconds: Number(get("lockLeaseSeconds").value)
        });
        setStatus("Réglages du serveur enregistrés.");
      } catch (error) {
        setStatus(String(error.message || error), true);
      }
    });
    get("storageSettingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!window.confirm("Le déplacement copie la base actuelle sans écraser la destination. Continuer ?")) {
        return;
      }
      try {
        const result = await window.lotissementAPI.saveStorageSettings({
          databasePath: get("databasePath").value.trim(),
          backupDirectory: get("backupDirectory").value.trim()
        });
        get("databasePath").value = result.databasePath;
        get("backupDirectory").value = result.backupDirectory;
        setStatus("Chemins de stockage appliqués; la base source est conservée comme copie de retour.");
      } catch (error) {
        setStatus(String(error.message || error), true);
      }
    });
    get("createBackupButton").addEventListener("click", async () => {
      try {
        const result = await window.lotissementAPI.createBackup();
        setStatus(`Sauvegarde créée: ${result.name}`);
        await refreshAdmin();
      } catch (error) {
        setStatus(String(error.message || error), true);
      }
    });
    get("restoreBackupButton").addEventListener("click", async () => {
      const name = get("backupSelect").value;
      if (!name || !window.confirm(`Restaurer ${name} ? Une sauvegarde avant restauration sera conservée.`)) {
        return;
      }
      try {
        await window.lotissementAPI.restoreBackup(name);
        setStatus(`Sauvegarde restaurée: ${name}`);
        await refreshAdmin();
      } catch (error) {
        setStatus(String(error.message || error), true);
      }
    });
  });
})();
