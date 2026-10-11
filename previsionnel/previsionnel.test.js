'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function createPrevisionnelHarness(api) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        dataset: {},
        hidden: true,
        textContent: '',
        replaceChildren() {}
      });
    }
    return elements.get(id);
  };
  const document = {
    addEventListener(name, listener) {
      documentListeners.set(name, listener);
    },
    getElementById
  };
  const window = {
    dispatchEvent() {},
    lotissementAPI: api,
    addEventListener(name, listener) {
      windowListeners.set(name, listener);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, 'previsionnel.js'), 'utf8');
  const context = vm.createContext({
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    document,
    window
  });
  vm.runInContext(source, context);
  context.proceedWithPendingChanges = async () => true;
  context.displayGuCase = () => {};
  context.displayGuCaseMatches = () => {
    getElementById('guSearchResults').hidden = false;
  };

  return { context, elements, windowListeners };
}

test('GU case list closes after a successful load and can be reopened', async () => {
  let listRequests = 0;
  let resolveRefresh;
  const guCase = {
    id: 7,
    reference: 'GU-7',
    companyName: 'Project 7',
    invoices: []
  };
  const harness = createPrevisionnelHarness({
    acquireCaseLock: async () => ({ acquired: true }),
    loadGuCase: async () => guCase,
    listGuCases: async () => {
      listRequests += 1;
      if (listRequests === 2) {
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return [guCase];
    },
    releaseCaseLock: async () => {}
  });

  await harness.context.showAllGuCases();
  assert.equal(harness.elements.get('guSearchResults').hidden, false);

  harness.windowListeners.get('central-data-changed')();
  assert.equal(listRequests, 2);

  await harness.context.loadGuCase(guCase.id);
  assert.equal(harness.elements.get('guSearchResults').hidden, true);

  resolveRefresh([guCase]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.elements.get('guSearchResults').hidden, true);

  harness.windowListeners.get('central-data-changed')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.elements.get('guSearchResults').hidden, true);
  assert.equal(listRequests, 2);

  await harness.context.showAllGuCases();
  assert.equal(harness.elements.get('guSearchResults').hidden, false);
  assert.equal(listRequests, 3);
});

test('GU case list stays open and shows an error when loading fails', async () => {
  const harness = createPrevisionnelHarness({
    acquireCaseLock: async () => ({ acquired: true }),
    loadGuCase: async () => {
      throw new Error('Server unavailable');
    },
    listGuCases: async () => [{ id: 7, reference: 'GU-7', invoices: [] }],
    releaseCaseLock: async () => {}
  });

  await harness.context.showAllGuCases();
  await harness.context.loadGuCase(7);

  assert.equal(harness.elements.get('guSearchResults').hidden, false);
  assert.equal(harness.elements.get('guSearchStatus').dataset.state, 'error');
  assert.equal(
    harness.elements.get('guSearchStatus').textContent,
    'تعذر تحميل الملف. حاول مجدداً.'
  );
});
