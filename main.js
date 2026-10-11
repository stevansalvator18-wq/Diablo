
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const ExcelJS = require('exceljs');

const defaultUserDataPath = path.join(app.getPath('appData'), 'MonPremierElectron');
const testMode = process.env.REC_TEST_MODE;

function createTestUserDataPath() {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const userDataPath = fs.mkdtempSync(
    path.join(temporaryRoot, 'monpremierelectron-rec-test-')
  );
  const directoryStats = fs.lstatSync(userDataPath);
  const realUserDataPath = fs.realpathSync(userDataPath);
  const relativeDirectory = path.relative(temporaryRoot, realUserDataPath);

  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
      path.resolve(userDataPath) !== realUserDataPath ||
      relativeDirectory === '..' ||
      relativeDirectory.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeDirectory)) {
    throw new Error('Le répertoire temporaire REC ne peut pas être validé.');
  }

  const databasePath = path.join(realUserDataPath, 'lotissement.sqlite');
  for (const filePath of [
    databasePath,
    `${databasePath}-journal`,
    `${databasePath}-wal`,
    `${databasePath}-shm`
  ]) {
    try {
      fs.lstatSync(filePath);
      throw new Error('Un fichier de base existe déjà dans le répertoire temporaire REC.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return realUserDataPath;
}

if (testMode !== undefined && testMode !== '1') {
  throw new Error('REC_TEST_MODE doit être défini à 1 ou ne pas être défini.');
}

const testUserDataPath = testMode === '1' ? createTestUserDataPath() : null;

app.setPath(
  'userData',
  testUserDataPath || defaultUserDataPath
);

let mainWindow;
let centralUrl = 'http://127.0.0.1:8765';
let sessionToken = null;
let currentUser = null;
let eventController = null;
let eventStreamPromise = null;
let lockRenewalTimer = null;
const editLocks = new Map();

const categoryCodes = new Set([
  'voirie',
  'eau-potable',
  'assainissement',
  'electricite',
  'telecommunications',
  'eclairage-public',
  'espaces-publics',
  'autre'
]);

function requireText(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new Error(`${field} doit être un texte.`);
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} est obligatoire et limité à ${maxLength} caractères.`);
  }

  return normalized;
}

function validateReference(value) {
  return requireText(value, 'La référence GU', 100);
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${field} doit être un texte.`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} est limité à ${maxLength} caractères.`);
  }

  return normalized || null;
}

function validateGuCaseId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('L’identifiant du dossier GU est invalide.');
  }
  return value;
}

function validateRecCase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('بيانات ملف التكلفة الحقيقية غير صالحة.');
  }

  if (typeof value.reference !== 'string' || !value.reference.trim() ||
      value.reference.trim().length > 100) {
    throw new Error('مرجع ملف التكلفة الحقيقية مطلوب، ويجب ألا يتجاوز 100 حرف.');
  }

  const reference = value.reference.trim();
  return {
    reference,
    lotName: requireText(value.lotName, 'اسم التجزئة', 200),
    guCaseId: value.guCaseId == null ? null : validateGuCaseId(value.guCaseId),
    invoices: validateRecInvoices(value.invoices)
  };
}

function validateRecCaseId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('معرّف ملف التكلفة الحقيقية غير صالح.');
  }
  return value;
}

function validateComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('بيانات المقارنة غير صالحة.');
  }
  if (!Array.isArray(value.invoices) || value.invoices.length > 2000) {
    throw new Error('قائمة فواتير المقارنة غير صالحة.');
  }

  const id = value.id == null ? null : validateComparisonId(value.id);
  const sourceRecCaseId = value.sourceRecCaseId == null
    ? null
    : validateRecCaseId(value.sourceRecCaseId);
  const invoices = value.invoices.map((invoice) => {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
      throw new Error('بيانات إحدى فواتير المقارنة غير صالحة.');
    }
    if (!categoryCodes.has(invoice.categoryCode)) {
      throw new Error('فئة إحدى فواتير المقارنة غير صالحة.');
    }
    if (!Number.isSafeInteger(invoice.amountMinor) || invoice.amountMinor < 0) {
      throw new Error('مبلغ إحدى فواتير المقارنة غير صالح.');
    }
    return {
      categoryCode: invoice.categoryCode,
      description: typeof invoice.description === 'string'
        ? invoice.description.trim().slice(0, 500)
        : '',
      amountMinor: invoice.amountMinor
    };
  });

  return {
    id,
    name: requireText(value.name, 'Le nom de la comparaison', 200),
    sourceRecCaseId,
    invoices
  };
}

function validateComparisonId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('معرّف المقارنة غير صالح.');
  }
  return value;
}

function validateRecInvoices(value) {
  if (!Array.isArray(value) || value.length > 2000) {
    throw new Error('قائمة فواتير التكلفة الحقيقية غير صالحة.');
  }

  return value.map((invoice) => {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
      throw new Error('بيانات إحدى الفواتير غير صالحة.');
    }
    if (!categoryCodes.has(invoice.categoryCode)) {
      throw new Error('فئة إحدى الفواتير غير صالحة.');
    }
    if (!Number.isSafeInteger(invoice.amountMinor) || invoice.amountMinor < 0) {
      throw new Error('يجب إدخال مبلغ الفاتورة بالسنتيم.');
    }

    return {
      categoryCode: invoice.categoryCode,
      description: typeof invoice.description === 'string'
        ? invoice.description.trim().slice(0, 500)
        : '',
      amountMinor: invoice.amountMinor
    };
  });
}

function validateGuCase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Les données du dossier sont invalides.');
  }

  if (!Array.isArray(value.invoices) || value.invoices.length > 2000) {
    throw new Error('La liste des factures est invalide.');
  }

  const id = value.id ?? null;
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('L’identifiant du dossier GU est invalide.');
  }

  for (const rate of [value.taxRatePercent, value.advanceRatePercent]) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error('Les taux doivent être des nombres positifs ou nuls.');
    }
  }

  const invoices = value.invoices.map((invoice) => {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
      throw new Error('Une facture est invalide.');
    }
    if (!categoryCodes.has(invoice.categoryCode)) {
      throw new Error('Une catégorie de facture est invalide.');
    }
    if (!Number.isSafeInteger(invoice.amountMinor) || invoice.amountMinor < 0) {
      throw new Error('Le montant d’une facture doit être en centimes.');
    }

    return {
      categoryCode: invoice.categoryCode,
      description: typeof invoice.description === 'string'
        ? invoice.description.trim().slice(0, 500)
        : '',
      amountMinor: invoice.amountMinor
    };
  });

  return {
    id,
    reference: optionalText(value.reference, 'La référence GU', 100),
    companyName: optionalText(value.companyName, 'Le nom du projet', 200),
    taxRatePercent: value.taxRatePercent,
    advanceRatePercent: value.advanceRatePercent,
    invoices
  };
}

function assertTrustedRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Origine de la requête IPC refusée.');
  }

  try {
    const senderPath = fileURLToPath(event.senderFrame.url);
    const expectedPath = path.resolve(__dirname, 'previsionnel', 'index.html');
    if (path.resolve(senderPath).toLowerCase() !== expectedPath.toLowerCase()) {
      throw new Error('Origine de la requête IPC refusée.');
    }
  } catch {
    throw new Error('Origine de la requête IPC refusée.');
  }
}

const connectionPath = path.join(app.getPath('userData'), 'server-connection.json');

function loadCentralUrl() {
  try {
    const connection = JSON.parse(fs.readFileSync(connectionPath, 'utf8'));
    if (typeof connection.serverUrl === 'string') centralUrl = connection.serverUrl;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Impossible de lire la configuration du serveur central.', error);
    }
  }
}

function normalizeCentralUrl(value) {
  if (typeof value !== 'string' || value.length > 500) {
    throw new Error('L’adresse du serveur central est invalide.');
  }
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username ||
      parsed.password || parsed.search || parsed.hash) {
    throw new Error('Utilisez une adresse HTTP(S) locale sans identifiants intégrés.');
  }
  const hostname = parsed.hostname.toLowerCase();
  const privateAddress = hostname === 'localhost' || hostname === '::1' ||
    /^127\./.test(hostname) || /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /\.local$/.test(hostname) || !hostname.includes('.');
  if (!privateAddress) {
    throw new Error('Le serveur doit être accessible par une adresse du réseau local.');
  }
  return parsed.origin;
}

async function centralRequest(endpoint, options = {}) {
  const base = normalizeCentralUrl(options.serverUrl || centralUrl);
  const url = new URL(endpoint, `${base}/`);
  const diagnosticUrl = `${url.origin}${url.pathname}`;
  const method = options.method || 'GET';
  const headers = { accept: 'application/json' };
  if (options.requireAuth !== false) {
    if (!sessionToken) throw new Error('Connectez-vous au serveur central.');
    headers.authorization = `Bearer ${sessionToken}`;
  }
  if (options.lockKey && editLocks.has(options.lockKey)) {
    headers['x-edit-lock'] = editLocks.get(options.lockKey).lockToken;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response;
  console.info(`[central] request method=${method} url=${diagnosticUrl}`);
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout || 120_000)
    });
  } catch (error) {
    const causeCode = error.cause?.code;
    const errorType = error.name || 'Error';
    console.error(
      `[central] connection-failed method=${method} url=${diagnosticUrl} ` +
      `type=${errorType} code=${causeCode || 'n/a'} message=${error.message || error}`
    );
    const diagnostic = causeCode ? ` (${causeCode})` : '';
    throw new Error(
      `Serveur central inaccessible à ${base}${diagnostic}. ` +
      'Vérifiez que le service central est démarré sur l’ordinateur serveur, ' +
      'puis réessayez. Sur cet ordinateur, lancez « npm run server ».'
    );
  }

  console.info(`[central] response method=${method} url=${diagnosticUrl} status=${response.status}`);
  const text = await response.text();
  let result = null;
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`Réponse JSON invalide du serveur central (HTTP ${response.status}).`);
    }
  }
  if (!response.ok) {
    const error = new Error(result?.error || `Erreur du serveur central (HTTP ${response.status}).`);
    error.statusCode = response.status;
    throw error;
  }
  return result;
}

function stopCentralEvents() {
  if (eventController) eventController.abort();
  eventController = null;
  eventStreamPromise = null;
  if (lockRenewalTimer) clearInterval(lockRenewalTimer);
  lockRenewalTimer = null;
}

function clearSession() {
  stopCentralEvents();
  sessionToken = null;
  currentUser = null;
  editLocks.clear();
}

function startCentralEvents() {
  stopCentralEvents();
  const token = sessionToken;
  const controller = new AbortController();
  eventController = controller;
  eventStreamPromise = (async () => {
    while (!controller.signal.aborted && sessionToken === token) {
      try {
        const response = await fetch(new URL('/api/events', centralUrl), {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
          signal: controller.signal
        });
        if (response.status === 401) {
          clearSession();
          mainWindow?.webContents.send('server:auth-expired');
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`Flux d’événements indisponible (HTTP ${response.status}).`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted && sessionToken === token) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';
          for (const event of events) {
            const payload = event.split('\n').find((line) => line.startsWith('data: '));
            if (!payload) continue;
            try {
              const change = JSON.parse(payload.slice(6));
              if (change.type === 'restore') {
                clearSession();
                mainWindow?.webContents.send('server:auth-expired', 'restore');
                return;
              }
              mainWindow?.webContents.send('server:event', change);
            } catch (error) {
              console.error('Événement du serveur central invalide.', error);
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn('Connexion aux notifications centrales interrompue.', error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  })();

  lockRenewalTimer = setInterval(() => {
    for (const [key, lock] of editLocks) {
      centralRequest('/api/locks/renew', {
        method: 'POST',
        body: {
          entityType: lock.entityType,
          entityId: lock.entityId,
          lockToken: lock.lockToken
        }
      }).catch((error) => {
        editLocks.delete(key);
        mainWindow?.webContents.send('server:lock-lost', {
          entityType: lock.entityType,
          entityId: lock.entityId,
          message: error.message
        });
      });
    }
  }, 10_000);
}

async function acquireCaseLock(entityType, entityId) {
  const id = entityType === 'gu'
    ? validateGuCaseId(entityId)
    : validateRecCaseId(entityId);
  const key = `${entityType}:${id}`;
  const result = await centralRequest('/api/locks/acquire', {
    method: 'POST',
    body: { entityType, entityId: id }
  });
  editLocks.delete(key);
  if (result.acquired) {
    editLocks.set(key, {
      entityType,
      entityId: id,
      lockToken: result.lockToken
    });
  }
  return result;
}

async function releaseCaseLock(entityType, entityId) {
  const id = entityType === 'gu'
    ? validateGuCaseId(entityId)
    : validateRecCaseId(entityId);
  const key = `${entityType}:${id}`;
  const lock = editLocks.get(key);
  if (!lock) return { released: true };
  editLocks.delete(key);
  return centralRequest('/api/locks/release', {
    method: 'POST',
    body: { entityType, entityId: id, lockToken: lock.lockToken }
  });
}

function completeLogin(result) {
  sessionToken = result.token;
  currentUser = result.user;
  startCentralEvents();
  mainWindow?.webContents.send('server:authenticated', currentUser);
  return currentUser;
}

ipcMain.handle('server:connection:get', (event) => {
  assertTrustedRenderer(event);
  return { serverUrl: centralUrl };
});

ipcMain.handle('server:connection:set', async (event, value) => {
  assertTrustedRenderer(event);
  const serverUrl = normalizeCentralUrl(value);
  await centralRequest('/health', { serverUrl, requireAuth: false, timeout: 5000 });
  const directory = path.dirname(connectionPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${connectionPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ serverUrl }, null, 2)}\n`, {
    flag: 'w',
    mode: 0o600
  });
  fs.renameSync(temporary, connectionPath);
  clearSession();
  centralUrl = serverUrl;
  return { serverUrl };
});

ipcMain.handle('server:auth:bootstrap', async (event, credentials) => {
  assertTrustedRenderer(event);
  const result = await centralRequest('/api/bootstrap', {
    serverUrl: credentials.serverUrl || centralUrl,
    requireAuth: false,
    method: 'POST',
    body: credentials
  });
  if (credentials.serverUrl) centralUrl = normalizeCentralUrl(credentials.serverUrl);
  return completeLogin(result);
});

ipcMain.handle('server:auth:login', async (event, credentials) => {
  assertTrustedRenderer(event);
  const result = await centralRequest('/api/login', {
    serverUrl: credentials.serverUrl || centralUrl,
    requireAuth: false,
    method: 'POST',
    body: credentials
  });
  if (credentials.serverUrl) centralUrl = normalizeCentralUrl(credentials.serverUrl);
  return completeLogin(result);
});

ipcMain.handle('server:auth:logout', async (event) => {
  assertTrustedRenderer(event);
  try {
    if (sessionToken) await centralRequest('/api/logout', { method: 'POST', body: {} });
  } finally {
    clearSession();
  }
  return true;
});

ipcMain.handle('server:auth:me', (event) => {
  assertTrustedRenderer(event);
  return currentUser;
});

ipcMain.handle('gu:save', async (event, value) => {
  assertTrustedRenderer(event);
  const guCase = validateGuCase(value);
  const result = await centralRequest('/api/gu', { method: 'PUT', body: guCase,
    lockKey: guCase.id == null ? undefined : `gu:${guCase.id}` });
  if (result.id && !result.duplicateEmptyIdentity && guCase.id == null) {
    await acquireCaseLock('gu', result.id);
  }
  return result;
});

ipcMain.handle('gu:load', async (event, id) => {
  assertTrustedRenderer(event);
  return centralRequest(`/api/gu/${validateGuCaseId(id)}`);
});

ipcMain.handle('gu:search', (event, query) => {
  assertTrustedRenderer(event);
  const normalized = requireText(query, 'La recherche GU', 100);
  return centralRequest(`/api/gu/search?q=${encodeURIComponent(normalized)}`);
});

ipcMain.handle('gu:list', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/gu');
});

ipcMain.handle('gu:delete', async (event, id) => {
  assertTrustedRenderer(event);
  const validatedId = validateGuCaseId(id);
  const result = await centralRequest(`/api/gu/${validatedId}`, {
    method: 'DELETE',
    lockKey: `gu:${validatedId}`
  });
  editLocks.delete(`gu:${validatedId}`);
  return result;
});

ipcMain.handle('rec:list-available-gu', (event, recCaseId) => {
  assertTrustedRenderer(event);
  const id = recCaseId == null ? '' : validateRecCaseId(recCaseId);
  return centralRequest(`/api/gu/available${id ? `?recCaseId=${id}` : ''}`);
});

ipcMain.handle('rec:create', async (event, value) => {
  assertTrustedRenderer(event);
  const result = await centralRequest('/api/rec', {
    method: 'POST',
    body: validateRecCase(value)
  });
  await acquireCaseLock('rec', result.id);
  return result;
});

ipcMain.handle('rec:list', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/rec');
});

ipcMain.handle('rec:load', (event, id) => {
  assertTrustedRenderer(event);
  return centralRequest(`/api/rec/${validateRecCaseId(id)}`);
});

ipcMain.handle('rec:update', async (event, value) => {
  assertTrustedRenderer(event);
  const id = validateRecCaseId(value?.id);
  return centralRequest(`/api/rec/${id}`, {
    method: 'PUT',
    body: { ...validateRecCase(value), id },
    lockKey: `rec:${id}`
  });
});

ipcMain.handle('rec:link-gu', async (event, recCaseId, guCaseId) => {
  assertTrustedRenderer(event);
  const id = validateRecCaseId(recCaseId);
  const linkedGuCaseId = validateGuCaseId(guCaseId);
  try {
    return await centralRequest(`/api/rec/${id}/gu-link`, {
      method: 'PATCH',
      body: { guCaseId: linkedGuCaseId },
      lockKey: `rec:${id}`
    });
  } catch (error) {
    if (error.statusCode !== 404) throw error;

    const recCase = await centralRequest(`/api/rec/${id}`);
    if (!recCase) throw new Error('ملف التكلفة الحقيقية غير موجود. حدّث القائمة.');
    return centralRequest(`/api/rec/${id}`, {
      method: 'PUT',
      body: { ...recCase, guCaseId: linkedGuCaseId },
      lockKey: `rec:${id}`
    });
  }
});

ipcMain.handle('comparison:list', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/comparisons');
});

ipcMain.handle('comparison:load', (event, id) => {
  assertTrustedRenderer(event);
  return centralRequest(`/api/comparisons/${validateComparisonId(id)}`);
});

ipcMain.handle('comparison:save', (event, value) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/comparisons', {
    method: 'PUT',
    body: validateComparison(value)
  });
});

function validateButtonPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Les préférences des boutons sont invalides.');
  }

  const preferences = {};
  const entries = Object.entries(value);
  if (entries.length > 200) {
    throw new Error('Le nombre de préférences des boutons est invalide.');
  }

  for (const [key, preference] of entries) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(key) ||
        !preference || typeof preference !== 'object' || Array.isArray(preference)) {
      throw new Error('Une préférence de bouton est invalide.');
    }

    const validated = {};
    if (preference.label !== undefined) {
      if (typeof preference.label !== 'string' ||
          !preference.label.trim() || preference.label.trim().length > 80) {
        throw new Error('Le libellé d’un bouton doit contenir de 1 à 80 caractères.');
      }
      validated.label = preference.label.trim();
    }

    for (const colorKey of ['backgroundColor', 'textColor']) {
      if (preference[colorKey] !== undefined) {
        if (typeof preference[colorKey] !== 'string' ||
            !/^#[0-9a-fA-F]{6}$/.test(preference[colorKey])) {
          throw new Error('Une couleur de bouton est invalide.');
        }
        validated[colorKey] = preference[colorKey].toLowerCase();
      }
    }

    if (Object.keys(validated).length) preferences[key] = validated;
  }

  return preferences;
}

ipcMain.handle('preferences:buttons:load', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/preferences/buttons');
});

ipcMain.handle('preferences:buttons:save', (event, value) => {
  assertTrustedRenderer(event);
  const preferences = validateButtonPreferences(value);
  return centralRequest('/api/preferences/buttons', { method: 'PUT', body: preferences });
});

ipcMain.handle('case:lock:acquire', (event, entityType, id) => {
  assertTrustedRenderer(event);
  return acquireCaseLock(entityType, id);
});

ipcMain.handle('case:lock:release', (event, entityType, id) => {
  assertTrustedRenderer(event);
  return releaseCaseLock(entityType, id);
});

ipcMain.handle('reports:data', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/reports');
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function invoiceTotal(invoices) {
  return (invoices || []).reduce((total, invoice) => total + invoice.amountMinor, 0) / 100;
}

function reportHtml(report) {
  const rows = [
    ['ملفات التكلفة التقديرية (GU)', (report.guCases || []).map((item) => [
      item.reference || 'بدون مرجع',
      item.companyName || 'بدون اسم',
      invoiceTotal(item.invoices).toFixed(2),
      String(item.invoices?.length || 0)
    ])],
    ['ملفات التكلفة الحقيقية (REC)', (report.recCases || []).map((item) => [
      item.reference,
      item.lotName,
      item.guReference || 'غير مرتبط',
      invoiceTotal(item.invoices).toFixed(2)
    ])],
    ['المقارنات', (report.comparisons || []).map((item) => [
      item.name,
      item.sourceReference,
      ((item.referenceTotalMinor || 0) / 100).toFixed(2),
      ((item.invoiceTotalMinor || 0) / 100).toFixed(2),
      ((item.differenceMinor || 0) / 100).toFixed(2)
    ])]
  ];
  const sections = rows.map(([title, values]) =>
    `<section><h2>${escapeHtml(title)}</h2><table><tbody>${
      values.length
        ? values.map((row) => `<tr>${row.map((cell) =>
          `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
        : '<tr><td>لا توجد بيانات</td></tr>'
    }</tbody></table></section>`
  ).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تقرير الرسوم</title>
    <style>body{font-family:Tahoma,Arial,sans-serif;color:#263445;margin:24px}
    h1,h2{color:#173b60}h2{font-size:18px;margin:24px 0 8px}
    table{border-collapse:collapse;width:100%}td{border:1px solid #cbd5e1;padding:7px}
    tr:nth-child(even){background:#f3f5f8}.meta{color:#64748b;font-size:12px}
    @page{size:A4 landscape;margin:12mm}</style>
    <h1>تقرير تدبير رسوم التجزئات العقارية</h1>
    <p class="meta">${escapeHtml(report.generatedAt || new Date().toISOString())}</p>
    ${sections}</html>`;
}

async function getReportData() {
  return centralRequest('/api/reports');
}

async function chooseReportPath(extension, filters) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le rapport',
    defaultPath: `rapport-lotissement.${extension}`,
    filters
  });
  return result.canceled ? null : result.filePath;
}

async function renderReportWindow(report, printer) {
  const reportWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try {
    await reportWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(reportHtml(report))}`);
    if (printer) {
      return await new Promise((resolve, reject) => {
        reportWindow.webContents.print({ printBackground: true }, (success, failureReason) => {
          if (success) resolve({ printed: true });
          else reject(new Error(failureReason || 'L’impression a échoué.'));
        });
      });
    }
    const pdf = await reportWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      landscape: true
    });
    const filePath = await chooseReportPath('pdf', [{ name: 'Document PDF', extensions: ['pdf'] }]);
    if (!filePath) return { cancelled: true };
    fs.writeFileSync(filePath, pdf);
    return { filePath };
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
}

ipcMain.handle('reports:export:pdf', async (event) => {
  assertTrustedRenderer(event);
  return renderReportWindow(await getReportData(), false);
});

ipcMain.handle('reports:print', async (event) => {
  assertTrustedRenderer(event);
  return renderReportWindow(await getReportData(), true);
});

ipcMain.handle('reports:export:excel', async (event) => {
  assertTrustedRenderer(event);
  const report = await getReportData();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = currentUser?.username || 'MonPremierElectron';
  workbook.created = new Date();
  const guSheet = workbook.addWorksheet('GU');
  guSheet.columns = [
    { header: 'Référence GU', key: 'reference', width: 24 },
    { header: 'Projet', key: 'project', width: 30 },
    { header: 'Taxe (%)', key: 'tax', width: 14 },
    { header: 'Avance (%)', key: 'advance', width: 14 },
    { header: 'Total factures (MAD)', key: 'total', width: 22 },
    { header: 'Nombre de factures', key: 'count', width: 20 }
  ];
  (report.guCases || []).forEach((item) => guSheet.addRow({
    reference: item.reference || '',
    project: item.companyName || '',
    tax: item.taxRatePercent,
    advance: item.advanceRatePercent,
    total: invoiceTotal(item.invoices),
    count: item.invoices.length
  }));
  const recSheet = workbook.addWorksheet('REC');
  recSheet.columns = [
    { header: 'Référence REC', key: 'reference', width: 24 },
    { header: 'Tranche', key: 'lot', width: 30 },
    { header: 'Référence GU liée', key: 'gu', width: 24 },
    { header: 'Total réel (MAD)', key: 'total', width: 20 },
    { header: 'Nombre de factures', key: 'count', width: 20 }
  ];
  (report.recCases || []).forEach((item) => recSheet.addRow({
    reference: item.reference,
    lot: item.lotName,
    gu: item.guReference || '',
    total: invoiceTotal(item.invoices),
    count: item.invoices.length
  }));
  const comparisonSheet = workbook.addWorksheet('Comparaisons');
  comparisonSheet.columns = [
    { header: 'Nom', key: 'name', width: 30 },
    { header: 'Référence REC', key: 'reference', width: 24 },
    { header: 'Montant de référence (MAD)', key: 'referenceTotal', width: 28 },
    { header: 'Factures comparées (MAD)', key: 'invoiceTotal', width: 28 },
    { header: 'Différence (MAD)', key: 'difference', width: 22 },
    { header: 'État', key: 'status', width: 18 }
  ];
  (report.comparisons || []).forEach((item) => comparisonSheet.addRow({
    name: item.name,
    reference: item.sourceReference,
    referenceTotal: item.referenceTotalMinor / 100,
    invoiceTotal: item.invoiceTotalMinor / 100,
    difference: item.differenceMinor / 100,
    status: item.resultStatus
  }));
  [guSheet, recSheet, comparisonSheet].forEach((sheet) => {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length }
    };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF173B60' }
    };
  });
  const filePath = await chooseReportPath('xlsx', [{
    name: 'Classeur Excel',
    extensions: ['xlsx']
  }]);
  if (!filePath) return { cancelled: true };
  const buffer = await workbook.xlsx.writeBuffer();
  fs.writeFileSync(filePath, buffer);
  return { filePath };
});
ipcMain.handle('admin:users:list', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/users');
});

ipcMain.handle('admin:users:create', (event, value) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/users', { method: 'POST', body: value });
});

ipcMain.handle('admin:users:update', (event, id, value) => {
  assertTrustedRenderer(event);
  return centralRequest(`/api/users/${validateRecCaseId(id)}`, {
    method: 'PATCH',
    body: value
  });
});

ipcMain.handle('admin:settings:get', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/admin/settings');
});

ipcMain.handle('admin:settings:save', (event, value) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/admin/settings', { method: 'PUT', body: value });
});

ipcMain.handle('admin:storage:save', (event, value) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/admin/storage', { method: 'PUT', body: value });
});

ipcMain.handle('admin:backups:list', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/admin/backups');
});

ipcMain.handle('admin:backups:create', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/admin/backups', { method: 'POST', body: {} });
});

ipcMain.handle('admin:backups:restore', (event, name) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/admin/backups/restore', {
    method: 'POST',
    body: { name }
  });
});

ipcMain.handle('admin:audit:list', (event) => {
  assertTrustedRenderer(event);
  return centralRequest('/api/admin/audit');
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'تدبير رسوم التجزئات العقارية',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile('previsionnel/index.html');

  if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopCentralEvents();
  });
}

app.whenReady().then(() => {
  loadCentralUrl();
  createWindow();
}).catch((error) => {
  console.error('Impossible de démarrer le client Electron.', error);
  app.quit();
});

app.on('before-quit', () => {
  stopCentralEvents();
});
