'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.handlers = new Map();
    this.dataset = {};
    this.attributes = {};
    this.classNames = new Set();
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.connected = true;
  }

  set className(value) {
    this.classNames = new Set(value.split(/\s+/).filter(Boolean));
  }

  addEventListener(name, handler) {
    this.handlers.set(name, handler);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  append(...elements) {
    elements.forEach((element) => {
      element.connected = this.connected;
      this.children.push(element);
    });
  }

  replaceChildren(...elements) {
    this.children.forEach((child) => {
      child.connected = false;
    });
    this.children = [];
    this.append(...elements);
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (element) => {
      if (element.connected && matches(element, selector)) found.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeOption extends FakeElement {
  constructor(text, value) {
    super('option');
    this.textContent = text;
    this.value = value;
  }
}

function matches(element, selector) {
  if (selector.startsWith('.')) {
    return element.classNames.has(selector.slice(1));
  }
  if (selector === 'input[type="text"]' || selector === 'input[type="number"]') {
    return element.tagName === 'input' &&
      element.type === (selector.includes('number') ? 'number' : 'text');
  }
  if (selector === 'select') return element.tagName === 'select';
  return false;
}

function createComparisonHarness() {
  const elements = new Map();
  const createdElements = [];
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const sourceSnapshot = {
    sourceRecCaseId: 3,
    reference: 'REC-3',
    lotName: 'Project lot',
    guCaseId: 8,
    guReference: 'GU-8',
    guCompanyName: 'Project',
    estimatedCostMinor: 75000,
    taxRatePercent: 5,
    invoiceCount: 1,
    actualTotalMinor: 12500,
    invoices: [{ categoryCode: 'voirie', description: 'source', amountMinor: 12500 }]
  };
  const recCase = {
    id: 3,
    reference: 'REC-3',
    lotName: 'Project lot',
    guCaseId: 8,
    guReference: 'GU-8',
    guCompanyName: 'Project',
    estimatedCostMinor: 75000,
    taxRatePercent: 5,
    invoices: sourceSnapshot.invoices
  };
  let saved = null;
  let saveCount = 0;
  const api = {
    listComparisons: async () => saved
      ? [{ id: saved.id, name: saved.name, sourceReference: 'REC-3' }]
      : [],
    listRecCases: async () => [{ id: 3, reference: 'REC-3', lotName: 'Project lot' }],
    loadRecCase: async () => recCase,
    loadComparison: async () => saved,
    saveComparison: async (comparison) => {
      saveCount += 1;
      saved = {
        id: 15,
        ...comparison,
        sourceReference: 'REC-3',
        sourceLotName: 'Project lot',
        sourceSnapshot
      };
      return saved;
    }
  };
  const document = {
    getElementById: getElementById,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      Object.defineProperty(element, 'id', {
        set(id) {
          this._id = id;
          elements.set(id, this);
        },
        get() {
          return this._id;
        }
      });
      createdElements.push(element);
      return element;
    },
    querySelectorAll(selector) {
      if (selector === '[data-phase="gu"]') return [];
      const roots = [...elements.values()];
      const matchesInTree = roots.flatMap((root) => [
        ...(root.connected && matches(root, selector) ? [root] : []),
        ...root.querySelectorAll(selector)
      ]);
      return [...new Set(matchesInTree.concat(
        createdElements.filter((item) => item.connected && matches(item, selector))
      ))];
    }
  };
  const window = {
    amountFieldFormatting: {
      enhance() {},
      formatMoney: (value) => String(value),
      formatNumber: (value) => String(value)
    },
    addEventListener() {},
    lotissementAPI: api
  };
  const source = fs.readFileSync(path.join(__dirname, 'comparison.js'), 'utf8');
  vm.runInNewContext(source, {
    document,
    Intl,
    Number,
    Option: FakeOption,
    String,
    window
  });
  return {
    api,
    elements,
    getElementById,
    get saveCount() {
      return saveCount;
    },
    get saved() {
      return saved;
    }
  };
}

test('comparison button saves data and invoices and reopening restores them', async () => {
  const harness = createComparisonHarness();
  const get = harness.getElementById;

  await get('comparisonPhaseButton').handlers.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  const sourceSelect = get('comparisonSourceRec');
  sourceSelect.value = '3';
  await sourceSelect.handlers.get('change')({ target: sourceSelect });
  await new Promise((resolve) => setImmediate(resolve));

  const name = get('comparisonName');
  name.value = 'Cost review';
  name.handlers.get('input')();
  assert.equal(get('saveComparison').disabled, false);

  await get('addComparisonInvoice').handlers.get('click')();
  const invoice = get('comparisonInvoiceRows').querySelector('.comparison-invoice-row');
  invoice.querySelector('select').value = 'eau-potable';
  invoice.querySelector('input[type="text"]').value = 'Water review';
  invoice.querySelector('input[type="number"]').value = '42.75';

  await get('saveComparison').handlers.get('click')();
  assert.equal(harness.saveCount, 1);
  assert.equal(harness.saved.sourceRecCaseId, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.saved.invoices)),
    [{ categoryCode: 'eau-potable', description: 'Water review', amountMinor: 4275 }]
  );
  assert.equal(get('comparisonStatus').dataset.state, 'success');

  await get('newComparison').handlers.get('click')();
  const savedSelect = get('savedComparisonSelect');
  savedSelect.value = '15';
  await get('openComparison').handlers.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('comparisonName').value, 'Cost review');
  const restoredInvoice = get('comparisonInvoiceRows')
    .querySelector('.comparison-invoice-row');
  assert.equal(restoredInvoice.querySelector('select').value, 'eau-potable');
  assert.equal(restoredInvoice.querySelector('input[type="text"]').value, 'Water review');
  assert.equal(restoredInvoice.querySelector('input[type="number"]').value, '42.75');
});
