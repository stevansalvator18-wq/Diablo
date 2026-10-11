'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function createReportsHarness(api) {
  const buttons = new Map();
  const listeners = new Map();
  const status = { textContent: '', dataset: {} };
  const document = {
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    getElementById(id) {
      if (id === 'reportStatus') return status;
      if (!buttons.has(id)) {
        buttons.set(id, {
          disabled: false,
          handlers: new Map(),
          addEventListener(name, listener) {
            this.handlers.set(name, listener);
          }
        });
      }
      return buttons.get(id);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, 'reports.js'), 'utf8');
  vm.runInNewContext(source, { document, window: { lotissementAPI: api } });
  listeners.get('DOMContentLoaded')();
  return { buttons, status };
}

test('report controls call their corresponding API actions and show completion status', async () => {
  const calls = [];
  const api = {
    exportReportPdf: async () => { calls.push('pdf'); return { filePath: 'report.pdf' }; },
    exportReportExcel: async () => { calls.push('excel'); return { filePath: 'report.xlsx' }; },
    printReport: async () => { calls.push('print'); return { printed: true }; }
  };
  const harness = createReportsHarness(api);

  for (const [buttonId, message] of [
    ['exportPdfButton', 'report.pdf'],
    ['exportExcelButton', 'report.xlsx'],
    ['printReportButton', 'Rapport envoyé']
  ]) {
    const button = harness.buttons.get(buttonId);
    await button.handlers.get('click')();
    assert.equal(button.disabled, false);
    assert.ok(harness.status.textContent.includes(message));
    assert.equal(harness.status.dataset.state, 'success');
  }
  assert.deepEqual(calls, ['pdf', 'excel', 'print']);
});

test('report controls display cancellation and API errors without swallowing them', async () => {
  const harness = createReportsHarness({
    exportReportPdf: async () => ({ cancelled: true }),
    exportReportExcel: async () => { throw new Error('Excel unavailable'); },
    printReport: async () => ({ printed: true })
  });

  await harness.buttons.get('exportPdfButton').handlers.get('click')();
  assert.match(harness.status.textContent, /annulée/);
  await harness.buttons.get('exportExcelButton').handlers.get('click')();
  assert.match(harness.status.textContent, /Excel unavailable/);
  assert.equal(harness.status.dataset.state, 'error');
  assert.equal(harness.buttons.get('exportExcelButton').disabled, false);
});
