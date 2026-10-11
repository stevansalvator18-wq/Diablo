(() => {
  const status = document.getElementById("reportStatus");

  async function runReport(action, successMessage) {
    const button = document.getElementById(action.buttonId);
    button.disabled = true;
    try {
      const result = await window.lotissementAPI[action.apiMethod]();
      status.textContent = result.cancelled
        ? "Exportation annulée."
        : result.filePath
          ? `${successMessage}: ${result.filePath}`
          : successMessage;
      status.dataset.state = "success";
    } catch (error) {
      status.textContent = `Échec du rapport: ${String(error.message || error)}`;
      status.dataset.state = "error";
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("exportPdfButton").addEventListener("click", () =>
      runReport(
        { buttonId: "exportPdfButton", apiMethod: "exportReportPdf" },
        "Rapport PDF enregistré"
      ));
    document.getElementById("exportExcelButton").addEventListener("click", () =>
      runReport(
        { buttonId: "exportExcelButton", apiMethod: "exportReportExcel" },
        "Classeur Excel enregistré"
      ));
    document.getElementById("printReportButton").addEventListener("click", () =>
      runReport(
        { buttonId: "printReportButton", apiMethod: "printReport" },
        "Rapport envoyé à l’imprimante"
      ));
  });
})();
