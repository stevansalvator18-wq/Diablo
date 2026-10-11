(() => {
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
  const eligibleCases = [];
  let consultedGuCase = null;
  let linkedGuCase = null;
  let currentRecCaseId = null;
  let lockedRecCaseId = null;
  let isSavingRecCase = false;
  let recInvoices = [];

  const getElement = (id) => document.getElementById(id);
  const money = (amount) => new Intl.NumberFormat("ar-MA", {
    style: "currency",
    currency: "MAD",
    minimumFractionDigits: 2
  }).format(amount);

  function amountToMinorUnits(value) {
    const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
    if (!match) return 0;

    const digits = `${match[1]}${match[2] || ""}`.replace(/^0+(?=\d)/, "");
    const exponent = Number(match[3] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
      return exponent > 0 ? Number.MAX_SAFE_INTEGER : 0;
    }

    const shift = 2 - (match[2] || "").length + exponent;
    let minorUnits = BigInt(digits || "0");
    if (shift >= 0) {
      if (digits !== "0" && digits.length + shift > 16) {
        return Number.MAX_SAFE_INTEGER;
      }
      minorUnits *= 10n ** BigInt(shift);
    } else {
      const divisor = 10n ** BigInt(-shift);
      const remainder = minorUnits % divisor;
      minorUnits /= divisor;
      if (remainder * 2n >= divisor) minorUnits += 1n;
    }

    return Number(minorUnits > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : minorUnits);
  }

  function roundMinorUnitsRatio(amountMinor, numerator, denominator) {
    const product = BigInt(amountMinor) * BigInt(numerator);
    const divisor = BigInt(denominator);
    return Number((product + divisor / 2n) / divisor);
  }

  function setStatus(message, isError = false) {
    const status = getElement("recStatus");
    status.textContent = message;
    status.dataset.state = isError ? "error" : "success";
  }

  function recReferenceIsValid() {
    const reference = getElement("recReference").value.trim();
    return reference.length > 0 && reference.length <= 100;
  }

  function recLotNameIsValid() {
    const lotName = getElement("recLotName").value.trim();
    return lotName.length > 0 && lotName.length <= 200;
  }

  function getGuLabel(guCase) {
    return `${guCase.companyName || "بدون اسم"} — ${guCase.reference || "بدون مرجع"}`;
  }

  function createInvoiceRow(categoryIndex, invoice = null) {
    const row = document.createElement("div");
    row.className = "invoice-row";

    const description = document.createElement("input");
    description.type = "text";
    description.dir = "auto";
    description.placeholder = "رقم الفاتورة أو وصفها";
    description.value = invoice?.description ?? "";

    const amount = document.createElement("input");
    amount.type = "number";
    amount.dir = "ltr";
    amount.min = "0";
    amount.step = "0.01";
    amount.placeholder = "المبلغ (درهم)";
    amount.value = invoice ? (invoice.amountMinor / 100).toFixed(2) : "0";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-btn";
    remove.dataset.buttonPrefKey = "rec.invoice.remove";
    remove.textContent = "حذف";
    remove.addEventListener("click", () => {
      row.remove();
      updateRecTotals();
    });

    description.addEventListener("input", updateRecTotals);
    amount.addEventListener("input", updateRecTotals);
    row.append(description, amount, remove);
    window.amountFieldFormatting.enhance(amount);
    return row;
  }

  function createRecWorkCards(invoices = []) {
    const grid = getElement("recWorkGrid");
    grid.replaceChildren();

    workTypes.forEach((type, index) => {
      const card = document.createElement("section");
      card.className = "work-card";

      const heading = document.createElement("h3");
      heading.textContent = type;

      const rows = document.createElement("div");
      rows.id = `recInvoiceRows${index}`;

      const categoryInvoices = invoices.filter(
        (invoice) => invoice.categoryCode === workCategoryCodes[index]
      );
      if (categoryInvoices.length) {
        categoryInvoices.forEach((invoice) => {
          rows.appendChild(createInvoiceRow(index, invoice));
        });
      } else {
        rows.appendChild(createInvoiceRow(index));
      }

      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "add-btn";
      addButton.dataset.buttonPrefKey = "rec.invoice.add";
      addButton.textContent = "+ إضافة فاتورة";
      addButton.addEventListener("click", () => {
        rows.appendChild(createInvoiceRow(index));
        updateRecTotals();
      });

      const totalRow = document.createElement("div");
      totalRow.className = "work-total";
      const totalLabel = document.createElement("span");
      totalLabel.textContent = "المجموع حسب الفئة";
      const total = document.createElement("strong");
      total.id = `recWorkTotal${index}`;
      total.dir = "ltr";
      total.textContent = money(0);
      totalRow.append(totalLabel, total);

      card.append(heading, rows, addButton, totalRow);
      grid.append(card);
    });
  }

  function collectInvoices() {
    const invoices = [];
    workTypes.forEach((type, index) => {
      getElement(`recInvoiceRows${index}`).querySelectorAll(".invoice-row").forEach((row) => {
        const description = row.querySelector('input[type="text"]').value.trim();
        const amountMinor = amountToMinorUnits(
          row.querySelector('input[type="number"]').value
        );
        if (!description && amountMinor === 0) return;
        invoices.push({ categoryCode: workCategoryCodes[index], description, amountMinor });
      });
    });
    return invoices;
  }

  function renderEligibleCases() {
    const cards = getElement("recGuCards");
    const empty = getElement("recGuEmpty");
    const query = getElement("recGuSearch").value.trim().toLocaleLowerCase();
    const filtered = eligibleCases.filter((guCase) =>
      `${guCase.reference || ""} ${guCase.companyName || ""}`
        .toLocaleLowerCase().includes(query)
    );

    cards.replaceChildren();
    getElement("recGuCount").textContent = `${filtered.length} ${filtered.length === 1 ? "ملف" : "ملفات"}`;
    if (!filtered.length) {
      empty.textContent = eligibleCases.length
        ? "لا توجد ملفات مطابقة للبحث."
        : "لا توجد ملفات تكلفة تقديرية متاحة للربط.";
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    const labels = filtered.map((item) => `${item.companyName || "بدون اسم"} — ${item.reference || "بدون مرجع"}`);
    const counts = new Map();
    labels.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1));
    const occurrences = new Map();

    filtered.forEach((guCase, index) => {
      const label = labels[index];
      const occurrence = (occurrences.get(label) ?? 0) + 1;
      occurrences.set(label, occurrence);
      const card = document.createElement("article");
      card.className = "rec-gu-card";
      card.setAttribute("aria-pressed", "false");

      const details = document.createElement("div");
      details.className = "rec-gu-details";
      const name = document.createElement("h4");
      name.dir = "auto";
      name.textContent = guCase.companyName || "بدون اسم";
      const reference = document.createElement("p");
      reference.className = "rec-gu-reference";
      reference.dir = guCase.reference ? "ltr" : "rtl";
      reference.textContent = guCase.reference || "بدون مرجع";
      const invoices = document.createElement("p");
      invoices.className = "rec-gu-metadata";
      invoices.textContent = `عدد الفواتير: ${Number(guCase.invoiceCount) || 0}`;
      const cost = document.createElement("p");
      cost.className = "rec-gu-metadata";
      cost.dir = "ltr";
      cost.textContent = `التكلفة التقديرية: ${money(Number(guCase.estimatedCostMinor || 0) / 100)}`;
      details.append(name, reference, invoices, cost);

      if (counts.get(label) > 1) {
        const disambiguator = document.createElement("span");
        disambiguator.className = "rec-gu-disambiguator";
        disambiguator.textContent = `الملف رقم ${occurrence}`;
        details.append(disambiguator);
      }

      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "rec-gu-select";
      choose.dataset.buttonPrefKey = "rec.gu.preview";
      choose.textContent = "معاينة هذا الملف";
      choose.addEventListener("click", () => selectGuCase(guCase, card));
      if (consultedGuCase?.id === guCase.id) {
        card.classList.add("selected");
        card.setAttribute("aria-pressed", "true");
      }
      card.append(details, choose);
      cards.append(card);
    });
  }

  function renderRecInvoices(invoices = []) {
    const grid = getElement("recWorkGrid");
    grid.replaceChildren();
    workTypes.forEach((type, index) => {
      const card = document.createElement("section");
      card.className = "work-card";
      const heading = document.createElement("h3");
      heading.textContent = type;
      const rows = document.createElement("div");
      rows.id = `recInvoiceRows${index}`;
      const categoryInvoices = invoices.filter((item) => item.categoryCode === workCategoryCodes[index]);
      if (categoryInvoices.length) categoryInvoices.forEach((invoice) => rows.append(createRecInvoiceRow(index, invoice)));
      else rows.append(createRecInvoiceRow(index));

      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-btn";
      add.dataset.buttonPrefKey = "rec.invoice.add";
      add.textContent = "+ إضافة فاتورة";
      add.addEventListener("click", () => {
        rows.append(createRecInvoiceRow(index));
        updateRecTotals();
      });
      const totalRow = document.createElement("div");
      totalRow.className = "work-total";
      const label = document.createElement("span");
      label.textContent = "المجموع حسب الفئة";
      const total = document.createElement("strong");
      total.id = `recWorkTotal${index}`;
      total.dir = "ltr";
      total.textContent = money(0);
      totalRow.append(label, total);
      card.append(heading, rows, add, totalRow);
      grid.append(card);
    });
    updateRecTotals();
  }

  function createRecInvoiceRow(categoryIndex, invoice = null) {
    const row = document.createElement("div");
    row.className = "invoice-row";
    const description = document.createElement("input");
    description.type = "text";
    description.dir = "auto";
    description.placeholder = "رقم الفاتورة أو وصفها";
    description.value = invoice?.description ?? "";
    const amount = document.createElement("input");
    amount.type = "number";
    amount.dir = "ltr";
    amount.min = "0";
    amount.step = "0.01";
    amount.placeholder = "المبلغ (درهم)";
    amount.value = invoice ? (invoice.amountMinor / 100).toFixed(2) : "0";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-btn";
    remove.dataset.buttonPrefKey = "rec.invoice.remove";
    remove.textContent = "حذف";
    remove.addEventListener("click", () => {
      row.remove();
      updateRecTotals();
    });
    description.addEventListener("input", updateRecTotals);
    amount.addEventListener("input", updateRecTotals);
    row.append(description, amount, remove);
    window.amountFieldFormatting.enhance(amount);
    return row;
  }

  function collectRecInvoices() {
    const invoices = [];
    workTypes.forEach((type, index) => {
      getElement(`recInvoiceRows${index}`).querySelectorAll(".invoice-row").forEach((row) => {
        const description = row.querySelector('input[type="text"]').value.trim();
        const amountMinor = amountToMinorUnits(
          row.querySelector('input[type="number"]').value
        );
        if (!description && amountMinor === 0) return;
        invoices.push({ categoryCode: workCategoryCodes[index], description, amountMinor });
      });
    });
    return invoices;
  }

  function displayedGuCase() {
    return consultedGuCase || linkedGuCase;
  }

  function updateRecTotals() {
    let actualCostMinor = 0;
    workTypes.forEach((type, index) => {
      let categoryTotalMinor = 0;
      getElement(`recInvoiceRows${index}`)?.querySelectorAll('input[type="number"]').forEach((input) => {
        categoryTotalMinor += amountToMinorUnits(input.value);
      });
      actualCostMinor += categoryTotalMinor;
      const total = getElement(`recWorkTotal${index}`);
      if (total) total.textContent = money(categoryTotalMinor / 100);
    });

    const guCase = displayedGuCase();
    const estimatedCostMinor = guCase ? Number(guCase.estimatedCostMinor || 0) : 0;
    const estimatedTaxMinor = roundMinorUnitsRatio(estimatedCostMinor, 5, 100);
    const theoreticalAdvanceMinor = roundMinorUnitsRatio(estimatedCostMinor, 3, 80);
    const actualTaxMinor = roundMinorUnitsRatio(actualCostMinor, 5, 100);
    const balanceMinor = actualTaxMinor - theoreticalAdvanceMinor;
    const formatSummaryMoney = window.amountFieldFormatting.formatMoney;
    getElement("recEstimatedCost").textContent =
      formatSummaryMoney(estimatedCostMinor / 100);
    getElement("recEstimatedTax").textContent =
      formatSummaryMoney(estimatedTaxMinor / 100);
    getElement("recTheoreticalAdvance").textContent =
      formatSummaryMoney(theoreticalAdvanceMinor / 100);
    getElement("recTopEstimatedCost").textContent = getElement("recEstimatedCost").textContent;
    getElement("recTopEstimatedTax").textContent = getElement("recEstimatedTax").textContent;
    getElement("recTopTheoreticalAdvance").textContent = getElement("recTheoreticalAdvance").textContent;
    getElement("recActualCost").textContent =
      formatSummaryMoney(actualCostMinor / 100);
    getElement("recActualTax").textContent =
      formatSummaryMoney(actualTaxMinor / 100);
    getElement("recFinalBalance").textContent =
      formatSummaryMoney(balanceMinor / 100);

    const notice = getElement("recBalanceNotice");
    if (balanceMinor < 0) {
      notice.textContent = `يوجد فائض قدره ${formatSummaryMoney(Math.abs(balanceMinor) / 100)}، يرجى التحقق منه. لا يتم رد أي مبلغ تلقائياً.`;
      notice.dataset.state = "warning";
      notice.hidden = false;
    } else if (balanceMinor > 0) {
      notice.textContent = `المبلغ المتبقي للتحصيل: ${formatSummaryMoney(balanceMinor / 100)}.`;
      notice.dataset.state = "due";
      notice.hidden = false;
    } else if (guCase) {
      notice.textContent = "الرصيد النهائي مسدد.";
      notice.dataset.state = "settled";
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }
  }

  function renderGuSummary(guCase) {
    const summary = getElement("selectedGuSummary");
    const linkStatus = getElement("recGuLinkStatus");
    const linkButton = getElement("linkRecToSelectedGu");
    if (!guCase) {
      summary.hidden = true;
      linkStatus.textContent = linkedGuCase
        ? `ملف GU المرتبط حالياً: ${getGuLabel(linkedGuCase)}`
        : "لا توجد علاقة محفوظة بملف GU.";
      linkButton.dataset.selectionDisabled = "true";
      linkButton.disabled = true;
      updateRecTotals();
      return;
    }

    getElement("selectedGuName").textContent = guCase.companyName || "بدون اسم";
    const reference = getElement("selectedGuReference");
    reference.textContent = guCase.reference || "بدون مرجع";
    reference.dir = guCase.reference ? "ltr" : "rtl";
    summary.hidden = false;
    linkStatus.textContent = linkedGuCase
      ? `ملف GU المرتبط حالياً: ${getGuLabel(linkedGuCase)}`
      : "لا توجد علاقة محفوظة بملف GU؛ المعاينة لا تنشئ علاقة.";
    linkButton.textContent = currentRecCaseId === null
      ? "حفظ ملف REC وربطه بملف GU المحدد"
      : "حفظ الربط بملف GU المحدد";
    linkButton.dataset.selectionDisabled =
      String(isSavingRecCase || linkedGuCase?.id === guCase.id);
    linkButton.disabled = linkButton.dataset.selectionDisabled === "true";
    updateRecTotals();
  }

  function createRecPayload(guCaseId = linkedGuCase?.id ?? null) {
    return {
      id: currentRecCaseId,
      reference: getElement("recReference").value.trim(),
      lotName: getElement("recLotName").value.trim(),
      guCaseId,
      invoices: collectRecInvoices()
    };
  }

  function updateSaveButton() {
    getElement("createRecCase").disabled = isSavingRecCase;
    getElement("createRecCase").textContent = currentRecCaseId === null
      ? "حفظ ملف التكلفة الحقيقية"
      : "حفظ التعديلات";
  }

  function renderSavedRecCases(cases) {
    const select = getElement("recSavedSelect");
    const selectedValue = currentRecCaseId === null ? "" : String(currentRecCaseId);
    select.replaceChildren(new Option("اختر ملفاً محفوظاً", ""));
    cases.forEach((recCase) => {
      const option = new Option(
        `${recCase.reference} — ${recCase.lotName} (${recCase.guCompanyName || "بدون اسم GU"} — ${recCase.guReference || "بدون مرجع GU"})`,
        String(recCase.id)
      );
      select.append(option);
    });
    select.value = selectedValue;
    getElement("openSavedRecCase").disabled = !select.value || isSavingRecCase;
  }

  async function refreshSavedRecCases() {
    try {
      renderSavedRecCases(await window.lotissementAPI.listRecCases());
      return true;
    } catch (error) {
      setStatus(
        `تعذر تحميل ملفات التكلفة الحقيقية المحفوظة: ${String(error?.message || "خطأ غير معروف")}`,
        true
      );
      return false;
    }
  }

  async function refreshEligibleCases() {
    try {
      eligibleCases.splice(0, eligibleCases.length, ...(
        await window.lotissementAPI.listAvailableGuCases(currentRecCaseId)
      ));
      renderEligibleCases();
      renderGuSummary(displayedGuCase());
      updateSaveButton();
      return true;
    } catch {
      eligibleCases.splice(0, eligibleCases.length);
      renderEligibleCases();
      setStatus("تعذر تحميل ملفات التكلفة التقديرية. حاول مجدداً.", true);
      return false;
    }
  }

  async function refreshLinkedGuCase() {
    if (!linkedGuCase) return;
    const linkedGuCaseId = linkedGuCase.id;

    try {
      const guCase = await window.lotissementAPI.loadGuCase(linkedGuCaseId);
      if (linkedGuCase?.id !== linkedGuCaseId) return;
      if (!guCase) {
        throw new Error("ملف التكلفة التقديرية المرتبط غير موجود.");
      }

      linkedGuCase = {
        id: guCase.id,
        reference: guCase.reference,
        companyName: guCase.companyName,
        estimatedCostMinor: guCase.invoices.reduce(
          (total, invoice) => total + invoice.amountMinor,
          0
        )
      };
      if (!consultedGuCase) consultedGuCase = linkedGuCase;
      renderGuSummary(displayedGuCase());
    } catch (error) {
      if (linkedGuCase?.id !== linkedGuCaseId) return;
      setStatus(
        `تعذر تحديث بيانات ملف GU المرتبط: ${String(error?.message || "حاول مجدداً.")}`,
        true
      );
    }
  }

  async function saveRecCase(guCaseId = linkedGuCase?.id ?? null) {
    if (isSavingRecCase) return;

    if (!recReferenceIsValid()) {
      setStatus("مرجع ملف التكلفة الحقيقية مطلوب، ويجب ألا يتجاوز 100 حرف.", true);
      return;
    }
    if (!recLotNameIsValid()) {
      setStatus("اسم التجزئة مطلوب ولا يتجاوز 200 حرف.", true);
      return;
    }

    const payload = createRecPayload(guCaseId);
    isSavingRecCase = true;
    updateSaveButton();
    getElement("openSavedRecCase").disabled = true;
    try {
      const result = currentRecCaseId === null
        ? await window.lotissementAPI.createRecCase(payload)
        : await window.lotissementAPI.updateRecCase(payload);
      currentRecCaseId = result.id;
      if (payload.id == null) {
        lockedRecCaseId = result.id;
        window.dispatchEvent(new CustomEvent("central-case-lock-state", {
          detail: { entityType: "rec", readOnly: false }
        }));
      }
      linkedGuCase = result.guCaseId === null
        ? null
        : consultedGuCase?.id === result.guCaseId
          ? consultedGuCase
          : linkedGuCase;
      getElement("recReference").value = result.reference;
      await refreshEligibleCases();
      const savedCasesRefreshed = await refreshSavedRecCases();
      if (savedCasesRefreshed) {
        setStatus(result.guCaseId === null
          ? `تم حفظ ملف ${result.reference} دون ربطه بملف GU.`
          : `تم حفظ ملف ${result.reference} وربطه بملف GU.`);
      } else {
        setStatus(
          `تم حفظ ملف ${result.reference}، لكن تعذر تحديث قائمة الملفات المحفوظة.`,
          true
        );
      }
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("مرتبط بالفعل")) {
        setStatus("ملف التكلفة التقديرية مرتبط بالفعل بملف تكلفة حقيقية.", true);
      } else if (message.includes("مستخدم بالفعل")) {
        setStatus("مرجع التكلفة الحقيقية مستخدم بالفعل. أدخل مرجعاً آخر.", true);
      } else if (message.includes("غير موجود")) {
        setStatus("ملف التكلفة التقديرية المحدد غير موجود. حدّث القائمة.", true);
      } else {
        setStatus(
          `تعذر حفظ ملف التكلفة الحقيقية: ${message || "تحقق من البيانات وحاول مجدداً."}`,
          true
        );
      }
    } finally {
      isSavingRecCase = false;
      updateSaveButton();
      getElement("openSavedRecCase").disabled = !getElement("recSavedSelect").value;
      renderGuSummary(displayedGuCase());
    }
  }

  async function linkSelectedGuCase() {
    if (!consultedGuCase) {
      setStatus("اختر ملف GU للمعاينة أولاً.", true);
      return;
    }
    if (linkedGuCase?.id === consultedGuCase.id) {
      setStatus("ملف GU هذا مرتبط بالفعل بملف REC الحالي.");
      return;
    }
    if (currentRecCaseId === null) {
      await saveRecCase(consultedGuCase.id);
      return;
    }
    if (isSavingRecCase) return;

    const selectedGuCase = consultedGuCase;
    isSavingRecCase = true;
    updateSaveButton();
    getElement("openSavedRecCase").disabled = true;
    renderGuSummary(selectedGuCase);
    try {
      const result = await window.lotissementAPI.linkRecCaseToGu(
        currentRecCaseId,
        selectedGuCase.id
      );
      if (result.id !== currentRecCaseId || result.guCaseId !== selectedGuCase.id) {
        throw new Error("لم يتم تأكيد حفظ الربط بملف GU المحدد.");
      }

      linkedGuCase = selectedGuCase;
      const eligibleCasesRefreshed = await refreshEligibleCases();
      const savedCasesRefreshed = await refreshSavedRecCases();
      if (eligibleCasesRefreshed && savedCasesRefreshed) {
        setStatus(`تم حفظ الربط بملف GU: ${getGuLabel(selectedGuCase)}.`);
      } else {
        setStatus(
          `تم حفظ الربط بملف GU: ${getGuLabel(selectedGuCase)}، لكن تعذر تحديث إحدى القوائم.`,
          true
        );
      }
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("مرتبط بالفعل")) {
        setStatus("ملف التكلفة التقديرية مرتبط بالفعل بملف تكلفة حقيقية.", true);
      } else if (message.includes("غير موجود")) {
        setStatus("ملف التكلفة التقديرية المحدد غير موجود. حدّث القائمة.", true);
      } else {
        setStatus(`تعذر حفظ الربط بملف GU: ${message || "حاول مجدداً."}`, true);
      }
    } finally {
      isSavingRecCase = false;
      updateSaveButton();
      getElement("openSavedRecCase").disabled = !getElement("recSavedSelect").value;
      renderGuSummary(displayedGuCase());
    }
  }

  async function loadRecCase(id) {
    try {
      if (lockedRecCaseId !== null && lockedRecCaseId !== id) {
        await window.lotissementAPI.releaseCaseLock("rec", lockedRecCaseId);
        lockedRecCaseId = null;
      }
      const lock = await window.lotissementAPI.acquireCaseLock("rec", id);
      lockedRecCaseId = lock.acquired ? id : null;
      window.dispatchEvent(new CustomEvent("central-case-lock-state", {
        detail: { entityType: "rec", readOnly: !lock.acquired, holder: lock.holder }
      }));
      const recCase = await window.lotissementAPI.loadRecCase(id);
      if (!recCase) {
        if (lock.acquired) await window.lotissementAPI.releaseCaseLock("rec", id);
        lockedRecCaseId = null;
        setStatus("ملف التكلفة الحقيقية غير موجود. حدّث القائمة.", true);
        return;
      }

      currentRecCaseId = recCase.id;
      linkedGuCase = recCase.guCaseId === null ? null : {
        id: recCase.guCaseId,
        reference: recCase.guReference,
        companyName: recCase.guCompanyName,
        estimatedCostMinor: recCase.estimatedCostMinor
      };
      consultedGuCase = linkedGuCase;
      getElement("recReference").value = recCase.reference;
      getElement("recLotName").value = recCase.lotName;
      getElement("recSavedSelect").value = String(recCase.id);
      getElement("openSavedRecCase").disabled = false;
      getElement("recGuPicker").hidden = false;
      getElement("recGuPicker").open = false;
      renderGuSummary(displayedGuCase());
      renderRecInvoices(recCase.invoices);
      updateSaveButton();
      await refreshEligibleCases();
      setStatus(`تم فتح ملف ${recCase.reference}.`);
    } catch (error) {
      setStatus(
        `تعذر فتح ملف التكلفة الحقيقية: ${String(error?.message || "حاول مجدداً.")}`,
        true
      );
    }
  }

  async function startNewRecCase() {
    if (lockedRecCaseId !== null) {
      await window.lotissementAPI.releaseCaseLock("rec", lockedRecCaseId);
      lockedRecCaseId = null;
    }
    window.dispatchEvent(new CustomEvent("central-case-lock-state", {
      detail: { entityType: "rec", readOnly: false }
    }));
    currentRecCaseId = null;
    consultedGuCase = null;
    linkedGuCase = null;
    getElement("recReference").value = "";
    getElement("recLotName").value = "";
    getElement("recGuSearch").value = "";
    getElement("recSavedSelect").value = "";
    getElement("openSavedRecCase").disabled = true;
    getElement("recGuPicker").hidden = false;
    getElement("recGuPicker").open = false;
    renderGuSummary(null);
    createRecWorkCards();
    updateRecTotals();
    updateSaveButton();
    await refreshEligibleCases();
    setStatus("ملف تكلفة حقيقية جديد جاهز.");
  }

  function selectGuCase(guCase, card) {
    consultedGuCase = guCase;
    document.querySelectorAll(".rec-gu-card").forEach((item) => {
      item.classList.toggle("selected", item === card);
      item.setAttribute("aria-pressed", item === card ? "true" : "false");
    });
    renderGuSummary(guCase);
    setStatus("تم اختيار ملف GU للمعاينة فقط؛ لم يُحفظ أي ربط.");
  }

  function handleSearchInput() {
    renderEligibleCases();
  }

  function resetRecForm() {
    currentRecCaseId = null;
    consultedGuCase = null;
    linkedGuCase = null;
    getElement("recReference").value = "";
    getElement("recLotName").value = "";
    getElement("recGuSearch").value = "";
    getElement("recSavedSelect").value = "";
    getElement("openSavedRecCase").disabled = true;
    getElement("recGuPicker").hidden = false;
    getElement("recGuPicker").open = false;
    renderGuSummary(null);
    createRecWorkCards();
    updateRecTotals();
    updateSaveButton();
  }

  function switchPhase(phase) {
    const isGu = phase === "gu";
    const isRec = phase === "rec";
    document.querySelectorAll('[data-phase="gu"]').forEach((element) => {
      element.hidden = !isGu;
    });
    getElement("recPhaseView").hidden = !isRec;
    getElement("comparisonPhaseView").hidden = true;
    getElement("guPhaseButton").classList.toggle("active", isGu);
    getElement("guPhaseButton").setAttribute("aria-pressed", String(isGu));
    getElement("recPhaseButton").classList.toggle("active", isRec);
    getElement("recPhaseButton").setAttribute("aria-pressed", String(isRec));
    getElement("comparisonPhaseButton").classList.remove("active");
    getElement("comparisonPhaseButton").setAttribute("aria-pressed", "false");
    getElement("phaseSubtitle").textContent = isRec ? "التكلفة الحقيقية" : "التكلفة التقديرية";
    if (isRec) {
      refreshLinkedGuCase();
      refreshEligibleCases();
      refreshSavedRecCases();
    }
  }

  getElement("guPhaseButton").addEventListener("click", () => switchPhase("gu"));
  getElement("recPhaseButton").addEventListener("click", () => switchPhase("rec"));
  getElement("recGuSearch").addEventListener("input", handleSearchInput);
  getElement("recReference").addEventListener("input", updateSaveButton);
  getElement("recLotName").addEventListener("input", updateSaveButton);
  getElement("createRecCase").addEventListener("click", () => saveRecCase());
  getElement("newRecCase").addEventListener("click", startNewRecCase);
  getElement("linkRecToSelectedGu").addEventListener("click", linkSelectedGuCase);
  getElement("recSavedSelect").addEventListener("change", (event) => {
    getElement("openSavedRecCase").disabled = !event.target.value;
  });
  getElement("openSavedRecCase").addEventListener("click", () => {
    if (isSavingRecCase) return;
    const id = Number(getElement("recSavedSelect").value);
    if (Number.isSafeInteger(id) && id > 0) loadRecCase(id);
  });
  renderGuSummary(null);
  createRecWorkCards();
  window.addEventListener("central-data-changed", () => {
    void refreshEligibleCases();
    void refreshSavedRecCases();
    if (linkedGuCase) void refreshLinkedGuCase();
  });
})();