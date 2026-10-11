(() => {
  const formatter = new Intl.NumberFormat("fr-FR", {
    useGrouping: true,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const normalizeSeparators = (value) => value.replace(/[\u00a0\u202f]/g, " ");
  const formatNumber = (value) => normalizeSeparators(formatter.format(value));
  const formatMoney = (value) => `${formatNumber(value)} د.م.`;

  function refresh(input) {
    const display = input.parentElement?.querySelector(".formatted-number-display");
    if (!display) return;

    const value = input.value === "" ? Number.NaN : Number(input.value);
    display.textContent = Number.isFinite(value)
      ? formatNumber(value)
      : "";
  }

  function enhance(input) {
    const wrapper = document.createElement("span");
    wrapper.className = "formatted-number-field";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);

    const display = document.createElement("span");
    display.className = "formatted-number-display";
    display.setAttribute("aria-hidden", "true");
    wrapper.append(display);

    input.classList.add("formatted-number-input");
    input.addEventListener("focus", () => wrapper.classList.add("is-editing"));
    input.addEventListener("blur", () => {
      refresh(input);
      wrapper.classList.remove("is-editing");
    });
    input.addEventListener("input", () => refresh(input));
    refresh(input);
  }

  window.amountFieldFormatting = Object.freeze({
    enhance,
    refresh,
    formatNumber,
    formatMoney
  });
})();
