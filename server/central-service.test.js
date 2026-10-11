'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createCentralService } = require('./central-service');

const password = 'Correct horse battery staple 42!';

async function startFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lotissement-central-test-'));
  const service = await createCentralService({
    ...options,
    dataDirectory: directory,
    host: '127.0.0.1',
    port: 0,
    bootstrapToken: 'isolated-bootstrap-code'
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${service.address.port}`;

  async function request(endpoint, options = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.lock ? { 'x-edit-lock': options.lock } : {}),
        ...options.headers
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const body = response.status === 204 ? null : await response.json();
    return { status: response.status, body };
  }

  async function bootstrap(username = 'administrator') {
    const result = await request('/api/bootstrap', {
      method: 'POST',
      body: { setupCode: service.bootstrapToken, username, password }
    });
    assert.equal(result.status, 200);
    return result.body;
  }

  async function login(username, userPassword = password) {
    return request('/api/login', {
      method: 'POST',
      body: { username, password: userPassword }
    });
  }

  return { directory, service, baseUrl, request, bootstrap, login };
}

test('bootstrap code, password authentication, and administrative role checks', async (t) => {
  const fixture = await startFixture(t);
  const wrongCode = await fixture.request('/api/bootstrap', {
    method: 'POST',
    body: { setupCode: 'wrong', username: 'administrator', password }
  });
  assert.equal(wrongCode.status, 403);
  const admin = await fixture.bootstrap();
  assert.equal(admin.user.role, 'admin');
  assert.equal((await fixture.request('/api/bootstrap', {
    method: 'POST',
    body: { setupCode: fixture.service.bootstrapToken, username: 'second-admin', password }
  })).status, 409);

  const login = await fixture.login('administrator');
  assert.equal(login.status, 200);
  assert.equal((await fixture.request('/api/admin/settings', { token: login.body.token })).status, 200);
  const invalid = await fixture.login('administrator', 'wrong password long enough');
  assert.equal(invalid.status, 401);
  const noToken = await fixture.request('/api/gu');
  assert.equal(noToken.status, 401);
});

test('GU, REC, comparison workflows and serialized concurrent GU writes', async (t) => {
  const fixture = await startFixture(t);
  const admin = await fixture.bootstrap();
  const headers = { token: admin.token };
  const makeGu = (reference) => ({
    id: null,
    reference,
    companyName: 'Isolated test project',
    taxRatePercent: 5,
    advanceRatePercent: 75,
    invoices: [{ categoryCode: 'voirie', description: 'road', amountMinor: 125000 }]
  });
  const parallel = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    fixture.request('/api/gu', { method: 'PUT', ...headers, body: makeGu(`GU-PAR-${index}`) })
  ));
  assert.ok(parallel.every((result) => result.status === 200));
  assert.equal((await fixture.request('/api/gu', headers)).body.length, 10);

  const guList = await fixture.request('/api/gu', headers);
  const gu = await fixture.request(`/api/gu/${guList.body[0].id}`, headers);
  assert.equal(gu.body.invoices[0].amountMinor, 125000);
  const recInvoices = [
    { categoryCode: 'voirie', description: 'actual road', amountMinor: 99000 },
    { categoryCode: 'eau-potable', description: 'actual water', amountMinor: 42000 }
  ];
  const recCreated = await fixture.request('/api/rec', {
    method: 'POST',
    ...headers,
    body: {
      reference: 'REC-ISOLATED-1',
      lotName: 'Test lot',
      guCaseId: null,
      invoices: recInvoices
    }
  });
  assert.equal(recCreated.status, 200);
  const recLock = await fixture.request('/api/locks/acquire', {
    method: 'POST',
    ...headers,
    body: { entityType: 'rec', entityId: recCreated.body.id }
  });
  assert.equal(recLock.body.acquired, true);
  const linked = await fixture.request(`/api/rec/${recCreated.body.id}/gu-link`, {
    method: 'PATCH',
    token: admin.token,
    lock: recLock.body.lockToken,
    body: { guCaseId: gu.body.id }
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.guCaseId, gu.body.id);
  const persistedDatabase = new DatabaseSync(fixture.service.databasePath, {
    readOnly: true
  });
  try {
    assert.equal(
      persistedDatabase.prepare(
        'SELECT gu_case_id FROM rec_cases WHERE id = ?'
      ).get(recCreated.body.id).gu_case_id,
      gu.body.id
    );
  } finally {
    persistedDatabase.close();
  }

  const rec = await fixture.request(`/api/rec/${recCreated.body.id}`, headers);
  assert.equal(rec.body.guCaseId, gu.body.id);
  assert.deepEqual(rec.body.invoices, recInvoices);

  const duplicateRec = await fixture.request('/api/rec', {
    method: 'POST',
    ...headers,
    body: {
      reference: 'REC-ISOLATED-2',
      lotName: 'Second test lot',
      guCaseId: null,
      invoices: []
    }
  });
  const duplicateRecLock = await fixture.request('/api/locks/acquire', {
    method: 'POST',
    ...headers,
    body: { entityType: 'rec', entityId: duplicateRec.body.id }
  });
  const duplicateLink = await fixture.request(`/api/rec/${duplicateRec.body.id}/gu-link`, {
    method: 'PATCH',
    token: admin.token,
    lock: duplicateRecLock.body.lockToken,
    body: { guCaseId: gu.body.id }
  });
  assert.equal(duplicateLink.status, 400);
  assert.match(duplicateLink.body.error, /مرتبط بالفعل/);
  assert.equal(
    (await fixture.request(`/api/rec/${duplicateRec.body.id}`, headers)).body.guCaseId,
    null
  );
  assert.equal((await fixture.request(`/api/rec/${recCreated.body.id}`, headers)).body.guCaseId,
    gu.body.id);

  const comparisonInvoices = [
    { categoryCode: 'voirie', description: 'Road review', amountMinor: 95000 },
    { categoryCode: 'eau-potable', description: 'Water review', amountMinor: 46000 }
  ];
  const comparison = await fixture.request('/api/comparisons', {
    method: 'PUT',
    ...headers,
    body: {
      name: 'Isolated comparison',
      sourceRecCaseId: rec.body.id,
      invoices: comparisonInvoices
    }
  });
  assert.equal(comparison.status, 200);
  assert.equal(comparison.body.sourceSnapshot.actualTotalMinor, 141000);
  const loadedComparison = await fixture.request(
    `/api/comparisons/${comparison.body.id}`,
    headers
  );
  assert.equal(loadedComparison.body.name, 'Isolated comparison');
  assert.equal(loadedComparison.body.sourceRecCaseId, rec.body.id);
  assert.deepEqual(loadedComparison.body.invoices, comparisonInvoices);
  const persistedComparisonDatabase = new DatabaseSync(
    fixture.service.databasePath,
    { readOnly: true }
  );
  try {
    assert.deepEqual(
      persistedComparisonDatabase.prepare(`
        SELECT category_code AS categoryCode, description, amount_minor AS amountMinor
        FROM comparison_invoices WHERE comparison_id = ? ORDER BY id
      `).all(comparison.body.id).map((invoice) => ({ ...invoice })),
      comparisonInvoices
    );
    const storedSnapshot = persistedComparisonDatabase.prepare(
      'SELECT source_snapshot AS sourceSnapshot FROM comparisons WHERE id = ?'
    ).get(comparison.body.id);
    assert.equal(
      JSON.parse(storedSnapshot.sourceSnapshot).actualTotalMinor,
      141000
    );
  } finally {
    persistedComparisonDatabase.close();
  }

});

test('all estimated GU work categories persist and reload with invoice details', async (t) => {
  const fixture = await startFixture(t);
  const admin = await fixture.bootstrap();
  const invoices = [
    ['voirie', 'Road estimate', 10001],
    ['eau-potable', 'Water estimate', 20002],
    ['assainissement', 'Drainage estimate', 30003],
    ['electricite', 'Electricity estimate', 40004],
    ['telecommunications', 'Telecom estimate', 50005],
    ['eclairage-public', 'Street lighting estimate', 60006],
    ['espaces-publics', 'Public spaces estimate', 70007],
    ['autre', 'Other estimate', 80008]
  ].map(([categoryCode, description, amountMinor]) => ({
    categoryCode, description, amountMinor
  }));
  const saved = await fixture.request('/api/gu', {
    method: 'PUT',
    token: admin.token,
    body: {
      id: null,
      reference: 'GU-WORK-CATEGORIES',
      companyName: 'Isolated category project',
      taxRatePercent: 5,
      advanceRatePercent: 75,
      invoices
    }
  });
  assert.equal(saved.status, 200);

  const list = await fixture.request('/api/gu', { token: admin.token });
  assert.ok(list.body.some((item) =>
    item.id === saved.body.id && item.reference === 'GU-WORK-CATEGORIES'
  ));
  const loaded = await fixture.request(`/api/gu/${saved.body.id}`, {
    token: admin.token
  });
  assert.deepEqual(loaded.body.invoices, invoices);
});

test('viewer is read-only; editor locks are exclusive and recover after lease expiry', async (t) => {
  const fixture = await startFixture(t, { lockLeaseSeconds: 1 });
  const admin = await fixture.bootstrap();
  const first = await fixture.request('/api/users', {
    method: 'POST',
    token: admin.token,
    body: { username: 'editor-one', password, role: 'editor' }
  });
  const second = await fixture.request('/api/users', {
    method: 'POST',
    token: admin.token,
    body: { username: 'editor-two', password, role: 'editor' }
  });
  const viewer = await fixture.request('/api/users', {
    method: 'POST',
    token: admin.token,
    body: { username: 'reader-one', password, role: 'viewer' }
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(viewer.status, 200);
  assert.equal((await fixture.request('/api/users', { token: first.body.id })).status, 401);
  assert.equal((await fixture.request('/api/users', {
    token: (await fixture.login('editor-one')).body.token
  })).status, 403);
  const firstSession = (await fixture.login('editor-one')).body;
  const secondSession = (await fixture.login('editor-two')).body;
  const readOnly = (await fixture.login('reader-one')).body;
  const created = await fixture.request('/api/gu', {
    method: 'PUT',
    token: admin.token,
    body: {
      reference: 'GU-LOCK',
      companyName: 'Locked',
      taxRatePercent: 5,
      advanceRatePercent: 75,
      invoices: []
    }
  });
  const id = created.body.id;
  const acquired = await fixture.request('/api/locks/acquire', {
    method: 'POST', token: firstSession.token, body: { entityType: 'gu', entityId: id }
  });
  assert.equal(acquired.body.acquired, true);
  const conflict = await fixture.request('/api/locks/acquire', {
    method: 'POST', token: secondSession.token, body: { entityType: 'gu', entityId: id }
  });
  assert.equal(conflict.body.acquired, false);
  const readOnlyLock = await fixture.request('/api/locks/acquire', {
    method: 'POST', token: readOnly.token, body: { entityType: 'gu', entityId: id }
  });
  assert.equal(readOnlyLock.body.readOnly, true);
  const updated = {
    id,
    reference: 'GU-LOCK',
    companyName: 'Updated',
    taxRatePercent: 5,
    advanceRatePercent: 75,
    invoices: []
  };
  assert.equal((await fixture.request('/api/gu', {
    method: 'PUT', token: firstSession.token, body: updated
  })).status, 423);
  assert.equal((await fixture.request('/api/gu', {
    method: 'PUT', token: firstSession.token, lock: acquired.body.lockToken, body: updated
  })).status, 200);
  await fixture.request('/api/locks/release', {
    method: 'POST',
    token: firstSession.token,
    body: { entityType: 'gu', entityId: id, lockToken: acquired.body.lockToken }
  });
  const secondLock = await fixture.request('/api/locks/acquire', {
    method: 'POST', token: secondSession.token, body: { entityType: 'gu', entityId: id }
  });
  assert.equal(secondLock.body.acquired, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const recoveredLock = await fixture.request('/api/locks/acquire', {
    method: 'POST', token: firstSession.token, body: { entityType: 'gu', entityId: id }
  });
  assert.equal(recoveredLock.body.acquired, true);
  assert.equal((await fixture.request('/api/gu', {
    method: 'PUT', token: readOnly.token, body: updated
  })).status, 403);
});

test('SSE notifications, preference isolation, audit log, storage move and verified restore', async (t) => {
  const fixture = await startFixture(t);
  const admin = await fixture.bootstrap();
  const stream = await fetch(`${fixture.baseUrl}/api/events`, {
    headers: { authorization: `Bearer ${admin.token}` }
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const firstChunk = await reader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: ready/);
  const customPreferences = { 'guPhaseButton': { label: 'GU home', backgroundColor: '#123456', textColor: '#ffffff' } };
  assert.deepEqual((await fixture.request('/api/preferences/buttons', {
    method: 'PUT', token: admin.token, body: customPreferences
  })).body, customPreferences);
  const created = await fixture.request('/api/gu', {
    method: 'PUT',
    token: admin.token,
    body: {
      reference: 'GU-BACKUP',
      companyName: 'Before restore',
      taxRatePercent: 5,
      advanceRatePercent: 75,
      invoices: []
    }
  });
  const change = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('No SSE change event')), 2000))
  ]);
  assert.match(new TextDecoder().decode(change.value), /gu\.changed/);
  await reader.cancel();
  const manualBackup = await fixture.request('/api/admin/backups', {
    method: 'POST', token: admin.token, body: {}
  });
  assert.equal(manualBackup.status, 200);
  assert.ok(fs.existsSync(path.join(fixture.directory, 'backups', manualBackup.body.name)));
  const listedBackups = await fixture.request('/api/admin/backups', { token: admin.token });
  assert.ok(listedBackups.body.some(({ name }) => name === manualBackup.body.name));

  const beforeMovePath = fixture.service.databasePath;
  const movedPath = path.join(fixture.directory, 'moved', 'central.sqlite');
  const move = await fixture.request('/api/admin/storage', {
    method: 'PUT',
    token: admin.token,
    body: { databasePath: movedPath }
  });
  assert.equal(move.status, 200);
  assert.ok(fs.existsSync(movedPath));
  assert.ok(fs.existsSync(beforeMovePath));
  assert.equal(fixture.service.databasePath, movedPath);
  assert.equal((await fixture.request('/api/gu', { token: admin.token })).body.length, 1);
  const manualAfterMove = await fixture.request('/api/admin/backups', {
    method: 'POST', token: admin.token, body: {}
  });
  assert.equal(manualAfterMove.status, 200);
  const secondCase = await fixture.request('/api/gu', {
    method: 'PUT',
    token: admin.token,
    body: {
      reference: 'GU-AFTER-BACKUP',
      companyName: 'After snapshot',
      taxRatePercent: 5,
      advanceRatePercent: 75,
      invoices: []
    }
  });
  assert.equal(secondCase.status, 200);
  const restore = await fixture.request('/api/admin/backups/restore', {
    method: 'POST',
    token: admin.token,
    body: { name: manualAfterMove.body.name }
  });
  assert.equal(restore.status, 200);
  assert.equal((await fixture.request('/api/gu', { token: admin.token })).status, 401);
  const restoredAdmin = await fixture.login('administrator');
  assert.equal(restoredAdmin.status, 200);
  assert.equal((await fixture.request('/api/gu', { token: restoredAdmin.body.token })).body.length, 1);
  assert.equal((await fixture.request('/api/admin/audit', {
    token: restoredAdmin.body.token
  })).status, 200);
});

test('scheduled backups keep seven daily snapshots', async (t) => {
  const fixture = await startFixture(t);
  await fixture.bootstrap();
  const now = new Date(2026, 0, 1, 2, 0, 0);
  for (let day = 0; day < 9; day += 1) {
    await fixture.service.runScheduledBackup(new Date(
      now.getFullYear(), now.getMonth(), now.getDate() + day, 2, 0
    ));
  }
  const files = fs.readdirSync(path.join(fixture.directory, 'backups'))
    .filter((name) => /^backup-\d{8}\.sqlite$/.test(name));
  assert.equal(files.length, 7);
});
