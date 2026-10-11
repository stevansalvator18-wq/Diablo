'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class FakeElement {
  constructor() {
    this.dataset = {};
    this.handlers = new Map();
    this.value = '';
    this.classList = { toggle() {}, remove() {} };
    this.attributes = {};
  }

  addEventListener(name, handler) {
    this.handlers.set(name, handler);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  requestSubmit() {}
}

test('login and REC lock state preserve the GU selection button state', async () => {
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const linkButton = getElementById('linkRecToSelectedGu');
  linkButton.disabled = true;
  linkButton.dataset.selectionDisabled = 'true';
  const saveComparisonButton = getElementById('saveComparison');
  saveComparisonButton.disabled = true;
  saveComparisonButton.dataset.comparisonDisabled = 'true';

  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    body: { dataset: {} },
    addEventListener(name, handler) {
      documentListeners.set(name, handler);
    },
    getElementById,
    querySelectorAll() {
      return [];
    }
  };
  const api = {
    getServerConnection: async () => ({ serverUrl: 'http://127.0.0.1:8765' }),
    onLockLost() {},
    onServerAuthExpired() {},
    onServerAuthenticated(callback) {
      this.authenticated = callback;
    },
    onServerEvent() {}
  };
  const window = {
    dispatchEvent() {},
    lotissementAPI: api,
    addEventListener(name, handler) {
      windowListeners.set(name, handler);
    }
  };
  class MutationObserver {
    observe() {}
  }
  const source = fs.readFileSync(path.join(__dirname, 'client-session.js'), 'utf8');
  vm.runInNewContext(source, {
    CustomEvent: class CustomEvent {},
    document,
    Element: class Element {},
    MutationObserver,
    window
  });

  await documentListeners.get('DOMContentLoaded')();
  api.authenticated({ role: 'editor', username: 'editor' });
  assert.equal(linkButton.disabled, true);
  assert.equal(saveComparisonButton.disabled, true);

  saveComparisonButton.dataset.comparisonDisabled = 'false';
  saveComparisonButton.disabled = false;
  windowListeners.get('central-case-lock-state')({
    detail: { entityType: 'rec', readOnly: false }
  });
  assert.equal(saveComparisonButton.disabled, false);

  api.authenticated({ role: 'viewer', username: 'viewer' });
  assert.equal(saveComparisonButton.disabled, true);
  saveComparisonButton.dataset.comparisonDisabled = 'false';
  api.authenticated({ role: 'editor', username: 'editor' });
  assert.equal(saveComparisonButton.disabled, false);

  linkButton.dataset.selectionDisabled = 'false';
  linkButton.disabled = false;
  windowListeners.get('central-case-lock-state')({
    detail: { entityType: 'rec', readOnly: false }
  });
  assert.equal(linkButton.disabled, false);

  windowListeners.get('central-case-lock-state')({
    detail: { entityType: 'rec', readOnly: true }
  });
  assert.equal(linkButton.disabled, true);

  windowListeners.get('central-case-lock-state')({
    detail: { entityType: 'rec', readOnly: false }
  });
  assert.equal(linkButton.disabled, false);
});
