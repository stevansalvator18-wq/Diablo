(() => {
  const categories = [
    ["voirie", "الطرق"],
    ["eau-potable", "الماء الصالح للشرب"],
    ["assainissement", "الصرف الصحي"],
    ["electricite", "الكهرباء"],
    ["telecommunications", "الاتصالات"],
    ["eclairage-public", "الإنارة العمومية"],
    ["espaces-publics", "الفضاءات العمومية"],
    ["autre", "أخرى"]
  ];
  const state = {
    id: null,
    sourceRecCaseId: null,
    sourceSnapshot: null,
    savedNames: [],
    isSaving: false
  };

  const element = (id) => document.getElementById(id);
  const money = (amount) => new Intl.NumberFormat("ar-MA", {
    style: "currency",
    currency: "MAD",
    minimumFractionDigits: 2
  }).format(amount);

  function setStatus(message, isError = false) {
    const status = element("comparisonStatus");
    status.textContent = message;
    status.dataset.state = isError ? "error" : "success";
  }

  function createInvoiceRow(invoice = {}) {
    const row = document.createElement("div");
    row.className = "comparison-invoice-row";

    const category = document.createElement("select");
    category.setAttribute("aria-label", "فئة الفاتورة");
    categories.forEach(([code, label]) => {
      const option = new Option(label, code);
      category.append(option);
    });
    category.value = categories.some(([code]) => code === invoice.categoryCode)
      ? invoice.categoryCode
      : "voirie";

    const description = document.createElement("input");
    description.type = "text";
    description.maxLength = 500;
    description.placeholder = "رقم الفاتورة أو وصفها";
    description.value = invoice.description || "";
    description.setAttribute("aria-label", "تعديل وصف الفاتورة");

    const amount = document.createElement("input");
    amount.type = "number";
    amount.min = "0";
    amount.step = "0.01";
    amount.value = invoice.amountMinor == null
      ? ""
      : (invoice.amountMinor / 100).toFixed(2);
    amount.placeholder = "المبلغ (درهم)";
    amount.setAttribute("aria-label", "تعديل مبلغ الفاتورة بالدرهم");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-btn";
    remove.dataset.buttonPrefKey = "comparison.invoice.remove";
    remove.textContent = "حذف الفاتورة";
    remove.addEventListener("click", () => {
      row.remove();
      updateComparisonResult();
    });

    category.addEventListener("change", updateComparisonResult);
    description.addEventListener("input", updateComparisonResult);
    amount.addEventListener("input", updateComparisonResult);
    row.append(category, description, amount, remove);
    window.amountFieldFormatting.enhance(amount);
    return row;
  }

  function collectInvoices() {
    const invoices = [];
    document.querySelectorAll(".comparison-invoice-row").forEach((row) => {
      const description = row.querySelector('input[type="text"]').value.trim();
      const rawAmount = Number(row.querySelector('input[type="number"]').value);
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0;
      const amountMinor = Math.round(amount * 100);
      if (!description && amountMinor === 0) return;
      invoices.push({
        categoryCode: row.querySelector("select").value,
        description,
        amountMinor
      });
    });
    return invoices;
  }

  function sourceLabel(source) {
    return `${source.reference}${source.lotName ? ` — ${source.lotName}` : ""}`;
  }

  function makeSuggestedName(source) {
    const base = source.lotName || source.reference || `REC-${source.sourceRecCaseId}`;
    const clean = base.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
    const prefix = `المقارنة_${clean || `REC-${source.sourceRecCaseId}`}`;
    if (!state.savedNames.includes(prefix)) return prefix;
    let suffix = 2;
    while (state.savedNames.includes(`${prefix}_${suffix}`)) suffix += 1;
    return `${prefix}_${suffix}`;
  }

  function updateComparisonResult() {
    const referenceMinor = Number(state.sourceSnapshot?.actualTotalMinor || 0);
    const invoices = collectInvoices();
    const invoiceTotalMinor = invoices.reduce((sum, invoice) => sum + invoice.amountMinor, 0);
    const differenceMinor = invoiceTotalMinor - referenceMinor;
    const differencePercent = referenceMinor === 0
      ? null
      : differenceMinor / referenceMinor * 100;

    const formatMoney = window.amountFieldFormatting.formatMoney;
    element("comparisonResultReference").textContent = formatMoney(referenceMinor / 100);
    element("comparisonResultInvoices").textContent = formatMoney(invoiceTotalMinor / 100);
    element("comparisonResultDifference").textContent = formatMoney(differenceMinor / 100);
    element("comparisonResultPercent").textContent = differencePercent === null
      ? "غير متاحة (المبلغ المرجعي يساوي صفراً)"
      : `${window.amountFieldFormatting.formatNumber(differencePercent)} %`;

    const status = element("comparisonResultStatus");
    if (!state.sourceSnapshot) {
      status.textContent = "اختر ملف التكلفة الحقيقية المرجعي.";
      status.dataset.state = "empty";
    } else if (differenceMinor === 0) {
      status.textContent = "مطابق";
      status.dataset.state = "identical";
    } else {
      status.textContent = "فرق يستوجب المراجعة. لم تُحدد عتبة للتقارب.";
      status.dataset.state = "review";
    }
    const saveDisabled = state.isSaving ||
      !state.sourceSnapshot ||
      !element("comparisonName").value.trim();
    element("saveComparison").dataset.comparisonDisabled = String(saveDisabled);
    element("saveComparison").disabled = saveDisabled;
  }

  function renderSnapshot(snapshot) {
    state.sourceSnapshot = snapshot || null;
    const area = element("comparisonSourceSnapshot");
    if (!snapshot) {
      area.hidden = true;
      element("comparisonSourceReference").textContent = "";
      element("comparisonSourceLot").textContent = "";
      element("comparisonSourceGu").textContent = "";
      element("comparisonReferenceTotal").textContent = money(0);
      element("comparisonSourceInvoiceCount").textContent = "0";
      updateComparisonResult();
      return;
    }

    area.hidden = false;
    element("comparisonSourceReference").textContent = snapshot.reference || "بدون رقم";
    element("comparisonSourceLot").textContent = snapshot.lotName || "غير محدد";
    element("comparisonSourceGu").textContent = snapshot.guReference
      ? `${snapshot.guReference}${snapshot.guCompanyName ? ` — ${snapshot.guCompanyName}` : ""}`
      : "لا يوجد ملف تكلفة تقديرية مرتبط";
    element("comparisonReferenceTotal").textContent = money(snapshot.actualTotalMinor / 100);
    element("comparisonSourceInvoiceCount").textContent = String(snapshot.invoiceCount);
    updateComparisonResult();
  }

  function setInvoices(invoices) {
    const rows = element("comparisonInvoiceRows");
    rows.replaceChildren();
    invoices.forEach((invoice) => rows.append(createInvoiceRow(invoice)));
    updateComparisonResult();
  }

  async function refreshRecCases(selectedId = null) {
    const cases = await window.lotissementAPI.listRecCases();
    const select = element("comparisonSourceRec");
    select.replaceChildren(new Option("اختر ملف تكلفة حقيقية محفوظاً", ""));
    cases.forEach((item) => {
      select.append(new Option(sourceLabel(item), String(item.id)));
    });
    if (selectedId != null) select.value = String(selectedId);
  }

  async function refreshSavedComparisons(selectedId = null) {
    const comparisons = await window.lotissementAPI.listComparisons();
    state.savedNames = comparisons.map((item) => item.name);
    const select = element("savedComparisonSelect");
    select.replaceChildren(new Option("اختر مقارنة محفوظة", ""));
    comparisons.forEach((item) => {
      select.append(new Option(
        `${item.name} — ${item.sourceReference}`,
        String(item.id)
      ));
    });
    if (selectedId != null) select.value = String(selectedId);
    element("openComparison").disabled = !select.value;
  }

  async function selectSource(recCaseId) {
    state.id = null;
    state.sourceRecCaseId = null;
    state.sourceSnapshot = null;
    element("comparisonSourceSnapshot").hidden = true;
    setInvoices([]);
    if (!recCaseId) {
      element("comparisonName").value = "";
      updateComparisonResult();
      return;
    }

    const recCase = await window.lotissementAPI.loadRecCase(recCaseId);
    if (!recCase) throw new Error("ملف التكلفة الحقيقية المرجعي غير موجود.");
    const actualTotalMinor = recCase.invoices.reduce(
      (total, invoice) => total + invoice.amountMinor,
      0
    );
    const snapshot = {
      sourceRecCaseId: recCase.id,
      reference: recCase.reference,
      lotName: recCase.lotName,
      guCaseId: recCase.guCaseId,
      guReference: recCase.guReference,
      guCompanyName: recCase.guCompanyName,
      estimatedCostMinor: recCase.estimatedCostMinor,
      taxRatePercent: recCase.taxRatePercent,
      invoiceCount: recCase.invoices.length,
      actualTotalMinor,
      invoices: recCase.invoices
    };
    state.sourceRecCaseId = recCase.id;
    renderSnapshot(snapshot);
    element("comparisonName").value = makeSuggestedName(snapshot);
    setInvoices([]);
    setStatus(`نُسخت بيانات الملف ${recCase.reference} للمقارنة.`);
  }

  async function startNewComparison() {
    state.id = null;
    state.sourceRecCaseId = null;
    element("comparisonSourceRec").disabled = false;
    element("comparisonSourceRec").value = "";
    element("comparisonName").value = "";
    element("savedComparisonSelect").value = "";
    element("openComparison").disabled = true;
    renderSnapshot(null);
    setInvoices([]);
    setStatus("المقارنة الجديدة جاهزة. اختر ملف التكلفة الحقيقية.");
    updateComparisonResult();
  }

  async function loadComparison(id) {
    try {
      const comparison = await window.lotissementAPI.loadComparison(id);
      if (!comparison) {
        throw new Error("المقارنة المحفوظة غير موجودة.");
      }
      state.id = comparison.id;
      state.sourceRecCaseId = comparison.sourceRecCaseId;
      element("comparisonName").value = comparison.name;
      await refreshRecCases(comparison.sourceRecCaseId);
      element("comparisonSourceRec").disabled = true;
      renderSnapshot(comparison.sourceSnapshot);
      setInvoices(comparison.invoices);
      await refreshSavedComparisons(comparison.id);
      setStatus(`تم فتح المقارنة « ${comparison.name} ».`);
    } catch (error) {
      setStatus(`تعذر فتح المقارنة: ${String(error.message || error)}`, true);
    }
  }

  async function saveCurrentComparison() {
    if (state.isSaving) return;
    if (!state.sourceRecCaseId || !state.sourceSnapshot) {
      setStatus("اختر أولاً ملف التكلفة الحقيقية المرجعي.", true);
      return;
    }

    state.isSaving = true;
    element("saveComparison").disabled = true;
    try {
      const saved = await window.lotissementAPI.saveComparison({
        id: state.id,
        name: element("comparisonName").value.trim(),
        sourceRecCaseId: state.sourceRecCaseId,
        invoices: collectInvoices()
      });
      state.id = saved.id;
      state.sourceRecCaseId = saved.sourceRecCaseId;
      renderSnapshot(saved.sourceSnapshot);
      await refreshSavedComparisons(saved.id);
      setStatus(`تم حفظ المقارنة « ${saved.name} ».`);
    } catch (error) {
      setStatus(`تعذر حفظ المقارنة: ${String(error.message || error)}`, true);
    } finally {
      state.isSaving = false;
      updateComparisonResult();
    }
  }

  async function refreshComparisonView() {
    try {
      await Promise.all([
        refreshRecCases(state.sourceRecCaseId),
        refreshSavedComparisons(state.id)
      ]);
    } catch (error) {
      setStatus(`تعذر تحميل بيانات المقارنة: ${String(error.message || error)}`, true);
    }
  }

  function switchToComparison() {
    document.querySelectorAll('[data-phase="gu"]').forEach((section) => {
      section.hidden = true;
    });
    element("recPhaseView").hidden = true;
    element("comparisonPhaseView").hidden = false;
    ["guPhaseButton", "recPhaseButton", "comparisonPhaseButton"].forEach((id) => {
      const active = id === "comparisonPhaseButton";
      element(id).classList.toggle("active", active);
      element(id).setAttribute("aria-pressed", String(active));
    });
    element("phaseSubtitle").textContent = "المقارنة";
    void refreshComparisonView();
  }

  element("comparisonPhaseButton").addEventListener("click", switchToComparison);
  window.addEventListener("central-data-changed", () => {
    if (!element("comparisonPhaseView").hidden) void refreshComparisonView();
  });
  element("guPhaseButton").addEventListener("click", () => {
    element("comparisonPhaseView").hidden = true;
  });
  element("recPhaseButton").addEventListener("click", () => {
    element("comparisonPhaseView").hidden = true;
  });
  element("newComparison").addEventListener("click", startNewComparison);
  element("comparisonSourceRec").addEventListener("change", (event) => {
    selectSource(Number(event.target.value) || null).catch((error) => {
      setStatus(`تعذر نسخ بيانات ملف التكلفة الحقيقية: ${String(error.message || error)}`, true);
    });
  });
  element("comparisonName").addEventListener("input", updateComparisonResult);
  element("addComparisonInvoice").addEventListener("click", () => {
    element("comparisonInvoiceRows").append(createInvoiceRow());
    updateComparisonResult();
  });
  element("saveComparison").addEventListener("click", saveCurrentComparison);
  element("savedComparisonSelect").addEventListener("change", (event) => {
    element("openComparison").disabled = !event.target.value;
  });
  element("openComparison").addEventListener("click", () => {
    const id = Number(element("savedComparisonSelect").value);
    if (Number.isSafeInteger(id) && id > 0) void loadComparison(id);
  });
  renderSnapshot(null);
  setInvoices([]);
})();
