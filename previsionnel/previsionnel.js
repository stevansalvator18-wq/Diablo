
const workTypes = [
  "الطرق",
  "الماء الصالح للشرب",
  "التطهير السائل",
  "الكهرباء",
  "الاتصالات",
  "الإنارة العمومية",
  "الفضاءات العمومية",
  "أخرى"
];

const workCategoryCodes = [
  "voirie",
  "eau-potable",
  "assainissement",
  "electricite",
  "telecommunications",
  "eclairage-public",
  "espaces-publics",
  "autre"
];

const invoices = {};
let currentGuCaseId = null;
let hasUnsavedChanges = false;
let currentGuListMode = null;
let currentGuSearchQuery = "";
let lockedGuCaseId = null;

const money = (value) =>
  new Intl.NumberFormat("ar-MA", {
    style: "currency",
    currency: "MAD",
    minimumFractionDigits: 2
  }).format(value);

function createInvoiceRow(type) {
  const row = document.createElement("div");
  row.className = "invoice-row";

  const description = document.createElement("input");
  description.type = "text";
  description.dir = "auto";
  description.placeholder = "رقم الفاتورة أو وصفها";

  const amount = document.createElement("input");
  amount.type = "number";
  amount.dir = "ltr";
  amount.min = "0";
  amount.step = "0.01";
  amount.placeholder = "المبلغ (درهم)";
  amount.value = "0";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete-btn";
  remove.dataset.buttonPrefKey = "gu.invoice.remove";
  remove.textContent = "حذف";
  remove.title = "حذف هذه الفاتورة";

  amount.addEventListener("input", updateTotals);
  description.addEventListener("input", updateTotals);
  amount.addEventListener("input", markGuCaseDirty);
  description.addEventListener("input", markGuCaseDirty);

  remove.addEventListener("click", () => {
    row.remove();
    markGuCaseDirty();
    updateTotals();
  });

  row.append(description, amount, remove);
  window.amountFieldFormatting.enhance(amount);
  row.dataset.type = type;

  return row;
}

function createWorkCards() {
  const grid = document.getElementById("workGrid");
  if (!grid) return;

  grid.innerHTML = "";

  workTypes.forEach((type, index) => {
    invoices[type] = [];

    const card = document.createElement("section");
    card.className = "work-card";

    const heading = document.createElement("h3");
    heading.textContent = type;

    const rows = document.createElement("div");
    rows.id = `invoiceRows${index}`;

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "add-btn";
    addButton.dataset.buttonPrefKey = "gu.invoice.add";
    addButton.textContent = "+ إضافة فاتورة";

    const total = document.createElement("div");
    total.className = "work-total";

    const label = document.createElement("span");
    label.textContent = "المجموع حسب الفئة";

    const value = document.createElement("strong");
    value.id = `workTotal${index}`;
    value.textContent = money(0);

    total.append(label, value);

    addButton.addEventListener("click", () => {
      rows.appendChild(createInvoiceRow(type));
      markGuCaseDirty();
      updateTotals();
    });

    card.append(heading, rows, addButton, total);
    grid.appendChild(card);

    rows.appendChild(createInvoiceRow(type));
  });
}

function getRate(id, fallback) {
  const input = document.getElementById(id);
  if (!input) return fallback;

  const value = Number(input.value);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function updateTotals() {
  let grandTotal = 0;

  workTypes.forEach((type, index) => {
    const rows = document.querySelectorAll(
      `#invoiceRows${index} .invoice-row`
    );

    let categoryTotal = 0;

    rows.forEach((row) => {
      const amountInput = row.querySelector('input[type="number"]');
      let amount = Number(amountInput.value);

      if (!Number.isFinite(amount) || amount < 0) {
        amount = 0;
      }

      categoryTotal += amount;
    });

    grandTotal += categoryTotal;

    const totalElement = document.getElementById(`workTotal${index}`);
    if (totalElement) totalElement.textContent = money(categoryTotal);
  });

  const taxRate = getRate("taxRate", 5);
  const advanceRate = getRate("advanceRate", 75);

  const taxAmount = grandTotal * taxRate / 100;
  const advanceAmount = taxAmount * advanceRate / 100;

  const display = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = window.amountFieldFormatting.formatMoney(value);
  };

  display("resultTotal", grandTotal);
  display("resultTax", taxAmount);
  display("resultAdvance", advanceAmount);

  const taxRateDisplay = document.getElementById("resultTaxRate");
  if (taxRateDisplay) taxRateDisplay.textContent = `${taxRate}%`;

  const advanceRateDisplay = document.getElementById("resultAdvanceRate");
  if (advanceRateDisplay) {
    advanceRateDisplay.textContent = `${advanceRate}%`;
  }
}

function setCaseStatus(message, isError = false) {
  const status = document.getElementById("caseStatus");
  if (!status) return;

  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
}

function publishGuForRec(guCase) {
  const consultation = guCase ? {
    id: guCase.id,
    reference: guCase.reference,
    companyName: guCase.companyName,
    estimatedCostMinor: guCase.invoices.reduce(
      (total, invoice) => total + invoice.amountMinor,
      0
    )
  } : null;
  window.dispatchEvent(new CustomEvent("gu:consult", { detail: consultation }));
}

function translateUserError(error, fallback) {
  const message = String(error?.message ?? "");
  const translations = [
    ["Les données du dossier sont invalides", "بيانات الملف غير صالحة."],
    ["La liste des factures est invalide", "قائمة الفواتير غير صالحة."],
    ["L’identifiant du dossier GU est invalide", "معرّف ملف التكلفة التقديرية غير صالح."],
    ["Les taux doivent être des nombres", "يجب أن تكون النسب أرقاماً موجبة أو صفراً."],
    ["Une facture est invalide", "بيانات إحدى الفواتير غير صالحة."],
    ["Une catégorie de facture est invalide", "فئة إحدى الفواتير غير صالحة."],
    ["Le montant d’une facture doit être en centimes", "يجب إدخال مبلغ الفاتورة بالسنتيم."],
    ["Cette référence existe déjà", "هذا المرجع مستخدم بالفعل. اختر مرجعاً آخر."],
    ["Le dossier GU chargé n’existe plus", "لم يعد الملف المحدد موجوداً. أعد تحميل القائمة."],
    ["Ce dossier GU n’existe plus", "لم يعد الملف المحدد موجوداً. حدّث القائمة."],
    ["lié à un dossier REC ou à un paiement", "يتعذر الحذف لارتباط الملف بملف آخر أو بأداء."],
    ["Suppression refusée par une contrainte de la base", "رفضت قاعدة البيانات الحذف لحماية البيانات المرتبطة."],
    ["Le dossier GU n’a pas pu être supprimé", "تعذر حذف ملف التكلفة التقديرية."],
    ["doit être un texte", "يجب إدخال قيمة نصية صحيحة."],
    ["est limité à", "تجاوزت القيمة الحد المسموح به من الأحرف."],
    ["Origine de la requête IPC refusée", "تم رفض الطلب لأسباب أمنية."]
  ];

  const match = translations.find(([source]) => message.includes(source));
  return match ? match[1] : fallback;
}

function collectGuCase() {
  const invoicesToSave = [];

  workTypes.forEach((type, index) => {
    document.querySelectorAll(`#invoiceRows${index} .invoice-row`).forEach((row) => {
      const description = row.querySelector('input[type="text"]').value.trim();
      const rawAmount = Number(row.querySelector('input[type="number"]').value);
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0;
      const amountMinor = Math.round(amount * 100);

      if (!description && amountMinor === 0) return;

      invoicesToSave.push({
        categoryCode: workCategoryCodes[index],
        description,
        amountMinor
      });
    });
  });

  return {
    id: currentGuCaseId,
    reference: document.getElementById("guReference").value,
    companyName: document.getElementById("companyName").value,
    taxRatePercent: getRate("taxRate", 5),
    advanceRatePercent: getRate("advanceRate", 75),
    invoices: invoicesToSave
  };
}

function markGuCaseDirty() {
  hasUnsavedChanges = true;
}

async function saveCurrentGuCase() {
  try {
    const guCase = collectGuCase();
    const result = await window.lotissementAPI.saveGuCase(guCase);
    if (result.duplicateEmptyIdentity) {
      const shouldLoad = await confirmDuplicateEmptyGuCase();
      if (!shouldLoad) {
        setCaseStatus(
          "أُلغي الحفظ. أدخل مرجعاً أو اسم المشروع لإنشاء ملف جديد.",
          true
        );
        return false;
      }

      const existingCase = await window.lotissementAPI.loadGuCase(result.existingCaseId);
      if (!existingCase) {
        setCaseStatus("تعذر العثور على الملف الموجود. حدّث القائمة.", true);
        return false;
      }

      displayGuCase(existingCase);
      const lock = await window.lotissementAPI.acquireCaseLock("gu", existingCase.id);
      lockedGuCaseId = lock.acquired ? existingCase.id : null;
      window.dispatchEvent(new CustomEvent("central-case-lock-state", {
        detail: { entityType: "gu", readOnly: !lock.acquired, holder: lock.holder }
      }));
      setCaseStatus(`تم تحميل ملف ${guCaseLabel(existingCase)}.`);
      return false;
    }

    currentGuCaseId = result.id;
    if (guCase.id == null) {
      lockedGuCaseId = result.id;
      window.dispatchEvent(new CustomEvent("central-case-lock-state", {
        detail: { entityType: "gu", readOnly: false }
      }));
    }
    document.getElementById("guReference").value = result.reference ?? "";
    publishGuForRec({
      ...guCase,
      id: result.id,
      reference: result.reference
    });
    hasUnsavedChanges = false;
    setCaseStatus(`تم حفظ ملف ${guCaseLabel(result)}.`);
    return true;
  } catch (error) {
    setCaseStatus(translateUserError(error, "تعذر حفظ الملف. تحقق من البيانات وحاول مجدداً."), true);
    return false;
  }
}

function confirmDuplicateEmptyGuCase() {
  const dialog = document.getElementById("duplicateEmptyGuCaseDialog");
  dialog.returnValue = "cancel";

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "load"), {
      once: true
    });
    dialog.showModal();
  });
}

function guCaseLabel(guCase) {
  const reference = guCase.reference?.trim();
  const companyName = guCase.companyName?.trim();
  if (reference && companyName) return `${reference} — ${companyName}`;
  if (reference) return `المرجع ${reference}`;
  if (companyName) return `المشروع ${companyName}`;
  return "دون مرجع أو اسم";
}

function displayGuCase(guCase) {
  currentGuCaseId = guCase.id;
  document.getElementById("companyName").value = guCase.companyName ?? "";
  document.getElementById("guReference").value = guCase.reference ?? "";
  document.getElementById("taxRate").value = String(guCase.taxRatePercent);
  document.getElementById("advanceRate").value = String(guCase.advanceRatePercent);

  workTypes.forEach((type, index) => {
    const rows = document.getElementById(`invoiceRows${index}`);
    rows.replaceChildren();

    const categoryInvoices = guCase.invoices.filter(
      (invoice) => invoice.categoryCode === workCategoryCodes[index]
    );

    if (categoryInvoices.length === 0) {
      rows.appendChild(createInvoiceRow(type));
      return;
    }

    categoryInvoices.forEach((invoice) => {
      const row = createInvoiceRow(type);
      row.querySelector('input[type="text"]').value = invoice.description;
      const amountInput = row.querySelector('input[type="number"]');
      amountInput.value =
        (invoice.amountMinor / 100).toFixed(2);
      window.amountFieldFormatting.refresh(amountInput);
      rows.appendChild(row);
    });
  });

  updateTotals();
  hasUnsavedChanges = false;
  publishGuForRec(guCase);
}

function confirmUnsavedChanges() {
  if (!hasUnsavedChanges) return Promise.resolve("discard");

  const dialog = document.getElementById("unsavedChangesDialog");
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

async function proceedWithPendingChanges() {
  const choice = await confirmUnsavedChanges();
  if (choice !== "save" && choice !== "discard") return false;
  if (choice === "save") return saveCurrentGuCase();

  hasUnsavedChanges = false;
  return true;
}

function clearSearchResults() {
  closeGuSearchResults();
  document.getElementById("guSearchQuery").value = "";
  document.getElementById("guSearchStatus").textContent = "";
  currentGuSearchQuery = "";
}

function closeGuSearchResults() {
  resetGuSearchResults();
  currentGuListMode = null;
}

function resetGuCaseForm() {
  currentGuCaseId = null;
  publishGuForRec(null);
  document.getElementById("companyName").value = "";
  document.getElementById("guReference").value = "";
  document.getElementById("taxRate").value = "5";
  document.getElementById("advanceRate").value = "75";

  workTypes.forEach((type, index) => {
    document.getElementById(`invoiceRows${index}`).replaceChildren(createInvoiceRow(type));
  });

  hasUnsavedChanges = false;
  updateTotals();
}

async function startNewGuCase() {
  if (!(await proceedWithPendingChanges())) return;

  if (lockedGuCaseId !== null) {
    await window.lotissementAPI.releaseCaseLock("gu", lockedGuCaseId);
    lockedGuCaseId = null;
  }
  window.dispatchEvent(new CustomEvent("central-case-lock-state", {
    detail: { entityType: "gu", readOnly: false }
  }));
  resetGuCaseForm();
  clearSearchResults();
  setCaseStatus("ملف تكلفة تقديرية جديد جاهز.");
}

async function loadGuCase(id) {
  try {
    if (!(await proceedWithPendingChanges())) return;

    if (lockedGuCaseId !== null && lockedGuCaseId !== id) {
      await window.lotissementAPI.releaseCaseLock("gu", lockedGuCaseId);
      lockedGuCaseId = null;
    }
    const lock = await window.lotissementAPI.acquireCaseLock("gu", id);
    lockedGuCaseId = lock.acquired ? id : null;
    window.dispatchEvent(new CustomEvent("central-case-lock-state", {
      detail: { entityType: "gu", readOnly: !lock.acquired, holder: lock.holder }
    }));
    const guCase = await window.lotissementAPI.loadGuCase(id);

    if (!guCase) {
      if (lock.acquired) await window.lotissementAPI.releaseCaseLock("gu", id);
      lockedGuCaseId = null;
      setSearchStatus("لم يعد الملف المحدد موجوداً. أعد البحث.", true);
      return;
    }

    displayGuCase(guCase);
    closeGuSearchResults();
    setSearchStatus(`تم تحميل ملف ${guCaseLabel(guCase)}.`);
  } catch (error) {
    setSearchStatus(translateUserError(error, "تعذر تحميل الملف. حاول مجدداً."), true);
  }
}

async function deleteGuCase(id, label) {
  if (!(await confirmGuCaseDeletion(label))) return;
  if (!(await proceedWithPendingChanges())) return;

  try {
    await window.lotissementAPI.deleteGuCase(id);
    if (lockedGuCaseId === id) lockedGuCaseId = null;
    if (currentGuCaseId === id) {
      resetGuCaseForm();
      setCaseStatus(`تم حذف الملف ${label}.`);
    }
    await refreshGuCaseResults();
    if (currentGuCaseId !== id) setCaseStatus(`تم حذف الملف ${label}.`);
  } catch (error) {
    setSearchStatus(translateUserError(error, "تعذر حذف الملف. قد تكون له بيانات مرتبطة."), true);
  }
}

function setSearchStatus(message, isError = false) {
  const status = document.getElementById("guSearchStatus");
  if (!status) return;

  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
}

async function searchGuCases() {
  const query = document.getElementById("guSearchQuery").value.trim();
  await runGuSearch(query);
}

async function runGuSearch(query) {
  currentGuListMode = "search";
  currentGuSearchQuery = query;
  resetGuSearchResults();

  if (!query) {
    setSearchStatus("أدخل جزءاً من مرجع الملف أو اسم المشروع.", true);
    return;
  }

  try {
    const matches = await window.lotissementAPI.searchGuCases(query);
    if (currentGuListMode !== "search" || currentGuSearchQuery !== query) return;
    displayGuCaseMatches(
      matches,
      "لا توجد ملفات مطابقة لمعايير البحث.",
      "search"
    );
  } catch (error) {
    if (currentGuListMode !== "search" || currentGuSearchQuery !== query) return;
    setSearchStatus(translateUserError(error, "تعذر البحث عن الملفات. حاول مجدداً."), true);
  }
}

function resetGuSearchResults() {
  const results = document.getElementById("guSearchResults");
  document.getElementById("guCaseCards").replaceChildren();
  document.getElementById("guResultsEmpty").hidden = true;
  results.hidden = true;
  document.getElementById("guResultsCount").textContent = "0 ملف";
}

function displayGuCaseMatches(matches, emptyMessage, resultVerb) {
  const results = document.getElementById("guSearchResults");
  const cards = document.getElementById("guCaseCards");
  const emptyState = document.getElementById("guResultsEmpty");
  results.hidden = false;
  document.getElementById("guResultsCount").textContent =
    `${matches.length} ${matches.length === 1 ? "ملف" : "ملفات"}`;

  if (matches.length === 0) {
    emptyState.textContent = emptyMessage;
    emptyState.hidden = false;
    setSearchStatus(emptyMessage, true);
    return;
  }

  const labels = matches.map((match) => guCaseLabel(match));
  const labelCounts = new Map();
  labels.forEach((label) => labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1));
  const labelOccurrences = new Map();

  matches.forEach((match, index) => {
    const label = labels[index];
    const occurrence = (labelOccurrences.get(label) ?? 0) + 1;
    labelOccurrences.set(label, occurrence);
    const card = document.createElement("article");
    card.className = "gu-case-card";

    const details = document.createElement("div");
    details.className = "gu-case-details";

    const name = document.createElement("h4");
    name.className = "gu-case-name";
    name.dir = "auto";
    name.textContent = match.companyName || "دون اسم";

    const reference = document.createElement("p");
    reference.className = "gu-case-reference";
    reference.dir = match.reference ? "ltr" : "rtl";
    reference.textContent = match.reference || "دون مرجع";

    if (labelCounts.get(label) > 1) {
      const duplicate = document.createElement("span");
      duplicate.className = "gu-case-disambiguator";
      duplicate.textContent = `الملف رقم ${occurrence}`;
      details.append(name, reference, duplicate);
    } else {
      details.append(name, reference);
    }

    const actions = document.createElement("div");
    actions.className = "gu-case-actions";

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "gu-card-load";
    loadButton.dataset.buttonPrefKey = "gu.case.load";
    loadButton.textContent = "تحميل";
    loadButton.addEventListener("click", () => loadGuCase(match.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "gu-card-delete";
    deleteButton.dataset.buttonPrefKey = "gu.case.delete";
    deleteButton.textContent = "حذف";
    deleteButton.addEventListener("click", () => deleteGuCase(match.id, label));

    actions.append(loadButton, deleteButton);
    card.append(details, actions);
    cards.append(card);
  });

  const resultMessage = resultVerb === "search"
    ? matches.length === 1
      ? "تم العثور على ملف واحد."
      : `تم العثور على ${matches.length} ملفات.`
    : matches.length === 1
      ? "ملف واحد مسجل."
      : `عدد الملفات المسجلة: ${matches.length}.`;
  setSearchStatus(resultMessage);
}

async function showAllGuCases() {
  currentGuListMode = "list";
  currentGuSearchQuery = "";
  resetGuSearchResults();

  try {
    const matches = await window.lotissementAPI.listGuCases();
    if (currentGuListMode !== "list") return;
    displayGuCaseMatches(matches, "لا توجد ملفات محفوظة بعد.", "list");
  } catch (error) {
    if (currentGuListMode !== "list") return;
    setSearchStatus(translateUserError(error, "تعذر عرض قائمة الملفات. حاول مجدداً."), true);
  }
}

async function refreshGuCaseResults() {
  if (currentGuListMode === "search" && currentGuSearchQuery) {
    await runGuSearch(currentGuSearchQuery);
    return;
  }
  await showAllGuCases();
}

function confirmGuCaseDeletion(label) {
  const dialog = document.getElementById("deleteGuCaseDialog");
  document.getElementById("deleteGuCaseMessage").textContent =
    `هل تريد حذف ${label} نهائياً مع فواتيره؟`;
  dialog.returnValue = "cancel";

  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "delete"),
      { once: true }
    );
    dialog.showModal();
  });
}

function init() {
  createWorkCards();

  ["taxRate", "advanceRate"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener("input", updateTotals);
  });

  document.getElementById("saveGuCase")?.addEventListener("click", saveCurrentGuCase);
  document.getElementById("searchGuCases")?.addEventListener("click", searchGuCases);
  document.getElementById("showAllGuCases")?.addEventListener("click", showAllGuCases);
  document.getElementById("guSearchQuery")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchGuCases();
  });
  document.getElementById("newGuCase")?.addEventListener("click", startNewGuCase);

  ["companyName", "guReference", "taxRate", "advanceRate"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", markGuCaseDirty);
  });

  updateTotals();
}

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("central-data-changed", () => {
  if (!hasUnsavedChanges && currentGuListMode !== null) {
    void refreshGuCaseResults();
  }
});
