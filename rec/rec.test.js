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
    this.classList = {
      add: (name) => this.classNames.add(name),
      remove: (name) => this.classNames.delete(name),
      toggle: (name, force) => {
        if (force) this.classNames.add(name);
        else this.classNames.delete(name);
      }
    };
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.open = false;
  }

  set className(value) {
    this.classNames = new Set(value.split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classNames].join(' ');
  }

  addEventListener(name, handler) {
    this.handlers.set(name, handler);
  }

  async click() {
    await this.handlers.get('click')?.({ target: this });
  }

  append(...elements) {
    this.children.push(...elements);
  }

  appendChild(element) {
    this.children.push(element);
    return element;
  }

  replaceChildren(...elements) {
    this.children = elements;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (element) => {
      if (matches(element, selector)) found.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
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
  return false;
}

function createRecHarness() {
  const elements = new Map();
  const createdElements = [];
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const guCase = {
    id: 4,
    reference: 'GU-4',
    companyName: 'Linked project',
    estimatedCostMinor: 550000,
    invoiceCount: 1
  };
  let savedRecCase = null;
  const linkCalls = [];
  const api = {
    acquireCaseLock: async () => ({ acquired: true }),
    createRecCase: async (payload) => {
      savedRecCase = { ...payload, id: 9 };
      return { id: 9, reference: payload.reference, guCaseId: payload.guCaseId };
    },
    listAvailableGuCases: async () =>
      savedRecCase?.guCaseId === guCase.id ? [] : [guCase],
    listRecCases: async () => savedRecCase ? [savedRecCase] : [],
    updateRecCase: async (payload) => {
      savedRecCase = { ...payload };
      return { id: 9, reference: payload.reference, guCaseId: payload.guCaseId };
    },
    linkRecCaseToGu: async (recCaseId, guCaseId) => {
      linkCalls.push({ recCaseId, guCaseId });
      savedRecCase = { ...savedRecCase, guCaseId };
      return { id: recCaseId, guCaseId };
    },
    loadRecCase: async () => ({
      ...savedRecCase,
      guReference: guCase.reference,
      guCompanyName: guCase.companyName,
      estimatedCostMinor: guCase.estimatedCostMinor
    }),
    releaseCaseLock: async () => {}
  };
  const document = {
    getElementById: getElementById,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      Object.defineProperty(element, 'id', {
        get() {
          return this._id;
        },
        set(id) {
          this._id = id;
          elements.set(id, this);
        }
      });
      createdElements.push(element);
      return element;
    },
    querySelectorAll(selector) {
      return createdElements.filter((element) => matches(element, selector));
    }
  };
  const window = {
    amountFieldFormatting: {
      enhance() {},
      formatMoney: (value) =>
        `${new Intl.NumberFormat('fr-FR', {
          useGrouping: true,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(value).replace(/[\u00a0\u202f]/g, ' ')} د.م.`
    },
    dispatchEvent() {},
    lotissementAPI: api,
    addEventListener() {}
  };
  class FakeOption extends FakeElement {
    constructor(text, value) {
      super('option');
      this.textContent = text;
      this.value = value;
    }
  }
  const source = fs.readFileSync(path.join(__dirname, 'rec.js'), 'utf8');
  vm.runInNewContext(source, {
    CustomEvent: class CustomEvent {},
    document,
    Intl,
    Map,
    Number,
    Option: FakeOption,
    String,
    window
  });
  return {
    api,
    elements,
    linkCalls,
    getElementById,
    get savedRecCase() {
      return savedRecCase;
    }
  };
}

test('REC save button saves invoices and GU link, then reopens the saved data', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'previsionnel', 'index.html'), 'utf8');
  const buttonMarkup = html.match(/<button id="createRecCase"[^>]*>/)?.[0];
  assert.ok(buttonMarkup);
  assert.doesNotMatch(buttonMarkup, /\sdisabled(?:\s|>|=)/);

  const harness = createRecHarness();
  const { getElementById } = harness;
  const saveButton = getElementById('createRecCase');
  assert.equal(saveButton.disabled, false);

  getElementById('recReference').value = 'REC-SAVE-9';
  getElementById('recLotName').value = 'Saved lot';
  const firstInvoice = getElementById('recInvoiceRows0').querySelector('.invoice-row');
  firstInvoice.querySelector('input[type="text"]').value = 'Road invoice';
  firstInvoice.querySelector('input[type="number"]').value = '125.50';
  const secondInvoice = getElementById('recInvoiceRows1').querySelector('.invoice-row');
  secondInvoice.querySelector('input[type="text"]').value = 'Water invoice';
  secondInvoice.querySelector('input[type="number"]').value = '80';

  await saveButton.click();
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.savedRecCase?.invoices)),
    [
      { categoryCode: 'voirie', description: 'Road invoice', amountMinor: 12550 },
      { categoryCode: 'eau-potable', description: 'Water invoice', amountMinor: 8000 }
    ]
  );
  assert.equal(harness.savedRecCase?.guCaseId, null);

  const guPreview = getElementById('recGuCards').querySelector('.rec-gu-select');
  await guPreview.click();
  await getElementById('linkRecToSelectedGu').click();
  assert.deepEqual(harness.linkCalls, [{ recCaseId: 9, guCaseId: 4 }]);
  assert.equal(harness.savedRecCase?.guCaseId, 4);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.savedRecCase.invoices)),
    [
      { categoryCode: 'voirie', description: 'Road invoice', amountMinor: 12550 },
      { categoryCode: 'eau-potable', description: 'Water invoice', amountMinor: 8000 }
    ]
  );

  getElementById('recSavedSelect').value = '9';
  await getElementById('openSavedRecCase').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getElementById('recReference').value, 'REC-SAVE-9');
  assert.equal(getElementById('recLotName').value, 'Saved lot');
  assert.equal(
    getElementById('recInvoiceRows0')
      .querySelector('.invoice-row')
      .querySelector('input[type="text"]').value,
    'Road invoice'
  );
  assert.equal(
    getElementById('recInvoiceRows1')
      .querySelector('.invoice-row')
      .querySelector('input[type="number"]').value,
    '80.00'
  );
  assert.match(getElementById('recGuLinkStatus').textContent, /GU-4/);
});

test('REC summary calculates and displays tax and balance in exact cent amounts', async () => {
  const harness = createRecHarness();
  const { getElementById } = harness;

  await getElementById('recPhaseButton').click();
  await new Promise((resolve) => setImmediate(resolve));
  await getElementById('recGuCards').querySelector('.rec-gu-select').click();

  const actualCost = getElementById('recInvoiceRows0')
    .querySelector('input[type="number"]');
  actualCost.value = '6850386.80';
  actualCost.handlers.get('input')();

  assert.equal(getElementById('recEstimatedCost').textContent, '5 500,00 د.م.');
  assert.equal(getElementById('recEstimatedTax').textContent, '275,00 د.م.');
  assert.equal(getElementById('recTheoreticalAdvance').textContent, '206,25 د.م.');
  assert.equal(getElementById('recActualCost').textContent, '6 850 386,80 د.م.');
  assert.equal(getElementById('recActualTax').textContent, '342 519,34 د.م.');
  assert.equal(getElementById('recFinalBalance').textContent, '342 313,09 د.م.');
  assert.match(
    getElementById('recBalanceNotice').textContent.replace(/[\u00a0\u202f]/g, ' '),
    /342 313,09/
  );
});
