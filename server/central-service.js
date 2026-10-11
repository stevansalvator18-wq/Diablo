'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const data = require('../database');

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const ROLES = new Set(['admin', 'editor', 'viewer']);
const CATEGORIES = new Set([
  'voirie', 'eau-potable', 'assainissement', 'electricite',
  'telecommunications', 'eclairage-public', 'espaces-publics', 'autre'
]);

function requireText(value, label, maximum) {
  if (typeof value !== 'string') throw new Error(`${label} doit être un texte.`);
  const result = value.trim();
  if (!result || result.length > maximum) {
    throw new Error(`${label} est obligatoire et limité à ${maximum} caractères.`);
  }
  return result;
}

function validateId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} invalide.`);
  return id;
}

function validateInvoices(invoices, label = 'factures') {
  if (!Array.isArray(invoices) || invoices.length > 2000) {
    throw new Error(`La liste des ${label} est invalide.`);
  }
  return invoices.map((invoice) => {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice) ||
        !CATEGORIES.has(invoice.categoryCode) ||
        !Number.isSafeInteger(invoice.amountMinor) || invoice.amountMinor < 0) {
      throw new Error('Une facture contient des données invalides.');
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
    throw new Error('Les données du dossier GU sont invalides.');
  }
  const id = value.id == null ? null : validateId(value.id, 'Identifiant GU');
  const rates = [value.taxRatePercent, value.advanceRatePercent];
  if (rates.some((rate) => typeof rate !== 'number' ||
      !Number.isFinite(rate) || rate < 0)) {
    throw new Error('Les taux doivent être des nombres positifs ou nuls.');
  }
  const optional = (input, label, maximum) => {
    if (input == null) return null;
    if (typeof input !== 'string' || input.trim().length > maximum) {
      throw new Error(`${label} est invalide.`);
    }
    return input.trim() || null;
  };
  return {
    id,
    reference: optional(value.reference, 'La référence GU', 100),
    companyName: optional(value.companyName, 'Le nom du projet', 200),
    taxRatePercent: value.taxRatePercent,
    advanceRatePercent: value.advanceRatePercent,
    invoices: validateInvoices(value.invoices)
  };
}

function validateRecCase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Les données du dossier REC sont invalides.');
  }
  return {
    id: value.id == null ? null : validateId(value.id, 'Identifiant REC'),
    reference: requireText(value.reference, 'La référence REC', 100),
    lotName: requireText(value.lotName, 'Le nom de la tranche', 200),
    guCaseId: value.guCaseId == null ? null : validateId(value.guCaseId, 'Identifiant GU'),
    invoices: validateInvoices(value.invoices, 'factures REC')
  };
}

function validateComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Les données de comparaison sont invalides.');
  }
  return {
    id: value.id == null ? null : validateId(value.id, 'Identifiant de comparaison'),
    name: requireText(value.name, 'Le nom de la comparaison', 200),
    sourceRecCaseId: value.sourceRecCaseId == null
      ? null
      : validateId(value.sourceRecCaseId, 'Identifiant REC'),
    invoices: validateInvoices(value.invoices, 'factures de comparaison')
  };
}

function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length > 200) {
    throw new Error('Les préférences des boutons sont invalides.');
  }
  const preferences = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(key) ||
        !item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Une préférence de bouton est invalide.');
    }
    const result = {};
    if (item.label !== undefined) {
      result.label = requireText(item.label, 'Le libellé', 80);
    }
    for (const field of ['backgroundColor', 'textColor']) {
      if (item[field] !== undefined) {
        if (typeof item[field] !== 'string' || !/^#[\da-f]{6}$/i.test(item[field])) {
          throw new Error('Une couleur de bouton est invalide.');
        }
        result[field] = item[field].toLowerCase();
      }
    }
    if (Object.keys(result).length) preferences[key] = result;
  }
  return preferences;
}

function passwordRecord(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('Le mot de passe doit contenir de 12 à 256 caractères.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function safeUsername(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{3,50}$/.test(value.trim())) {
    throw new Error('Le nom d’utilisateur doit contenir de 3 à 50 caractères valides.');
  }
  return value.trim();
}

function safePrivatePeer(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (net.isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254) ||
      octets[0] === 127;
  }
  if (net.isIP(normalized) !== 6) return false;
  const lower = normalized.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') ||
    lower.startsWith('fd') || lower.startsWith('fe8') ||
    lower.startsWith('fe9') || lower.startsWith('fea') ||
    lower.startsWith('feb');
}

function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function initializeServiceSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS central_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);
  const version = database.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM central_schema_migrations'
  ).get().version;
  if (version > 1) throw new Error('La base centrale utilise une version incompatible.');
  if (version === 0) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS central_users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE TABLE IF NOT EXISTS central_user_preferences (
        user_id INTEGER PRIMARY KEY REFERENCES central_users(id) ON DELETE CASCADE,
        button_preferences TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(button_preferences)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE TABLE IF NOT EXISTS central_audit_log (
        id INTEGER PRIMARY KEY,
        actor_id INTEGER REFERENCES central_users(id) ON DELETE SET NULL,
        actor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(details)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_central_audit_created
        ON central_audit_log(created_at DESC);
      CREATE TABLE IF NOT EXISTS central_server_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      INSERT INTO central_schema_migrations(version) VALUES (1);
      COMMIT;
    `);
  }
}

async function createCentralService(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory ||
    path.join(__dirname, 'data'));
  const configPath = path.join(dataDirectory, 'server-config.json');
  fs.mkdirSync(dataDirectory, { recursive: true });
  let config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  let databasePath = path.resolve(options.databasePath ||
    config.databasePath || path.join(dataDirectory, 'lotissement.sqlite'));
  let backupDirectory = path.resolve(options.backupDirectory ||
    config.backupDirectory || path.join(dataDirectory, 'backups'));
  let backupTime = options.backupTime || config.backupTime || '02:00';
  let lockLeaseSeconds = options.lockLeaseSeconds || config.lockLeaseSeconds || 30;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(backupDirectory, { recursive: true });
  const initialDatabaseExists = fs.existsSync(databasePath);
  let database = await data.initializeDatabase(databasePath);
  initializeServiceSchema(database);

  const sessions = new Map();
  const locks = new Map();
  const eventClients = new Set();
  const loginFailures = new Map();
  const loginAttempts = new Map();
  const bootstrapToken = options.bootstrapToken || crypto.randomBytes(24).toString('base64url');
  let bootstrapAvailable = true;
  let lastScheduledBackup = '';
  let closed = false;

  const audit = (user, action, entityType, entityId = null, details = {}) => {
    database.prepare(`
      INSERT INTO central_audit_log
        (actor_id, actor_name, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user?.id ?? null, user?.username || 'system', action, entityType,
      entityId == null ? null : String(entityId), JSON.stringify(details));
  };

  const publish = (event) => {
    const payload = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of eventClients) response.write(payload);
  };

  const cleanExpired = () => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(token);
        for (const [key, lock] of locks) {
          if (lock.token === token) {
            locks.delete(key);
            publish({ type: 'lock-released', entityType: lock.entityType, entityId: lock.entityId });
          }
        }
      }
    }
    for (const [key, lock] of locks) {
      if (lock.expiresAt <= now) {
        locks.delete(key);
        publish({ type: 'lock-released', entityType: lock.entityType, entityId: lock.entityId });
      }
    }
    for (const [key, failure] of loginFailures) {
      if (failure.resetAt <= now) loginFailures.delete(key);
    }
    for (const [key, attempt] of loginAttempts) {
      if (attempt.resetAt <= now) loginAttempts.delete(key);
    }
  };

  const timers = [];
  timers.push(setInterval(cleanExpired, 5000));

  function commitConfiguration() {
    atomicWrite(configPath, `${JSON.stringify({
      databasePath,
      backupDirectory,
      backupTime,
      lockLeaseSeconds
    }, null, 2)}\n`);
  }

  async function createBackup(destination, user = null, scheduled = false) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) throw new Error('Le fichier de sauvegarde existe déjà.');
    await backup(database, destination);
    const verification = new DatabaseSync(destination, { readOnly: true });
    try {
      if (verification.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
          verification.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('La sauvegarde créée a échoué aux contrôles d’intégrité.');
      }
    } catch (error) {
      try { verification.close(); } catch {}
      try { fs.unlinkSync(destination); } catch {}
      throw error;
    }
    verification.close();
    if (!scheduled) audit(user, 'backup.create', 'backup', path.basename(destination));
    return destination;
  }

  function pruneBackups() {
    const dailyPattern = /^backup-(\d{8})\.sqlite$/;
    const daily = fs.readdirSync(backupDirectory)
      .map((name) => {
        const match = dailyPattern.exec(name);
        return match ? { name, date: match[1] } : null;
      })
      .filter(Boolean)
      .sort((left, right) => right.date.localeCompare(left.date));
    for (const item of daily.slice(7)) {
      fs.unlinkSync(path.join(backupDirectory, item.name));
    }
  }

  async function scheduledBackupTick(now = new Date()) {
    const [hour, minute] = backupTime.split(':').map(Number);
    if (now.getHours() !== hour || now.getMinutes() !== minute) return;
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}`;
    if (lastScheduledBackup === day) return;
    const destination = path.join(backupDirectory, `backup-${day}.sqlite`);
    if (!fs.existsSync(destination)) await createBackup(destination, null, true);
    lastScheduledBackup = day;
    pruneBackups();
  }

  timers.push(setInterval(() => {
    scheduledBackupTick().catch((error) => {
      console.error('Échec de la sauvegarde quotidienne.', error);
    });
  }, 30_000));

  function authenticated(request) {
    const authorization = request.headers.authorization || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      throw Object.assign(new Error('Authentification requise.'), { statusCode: 401 });
    }
    session.expiresAt = Date.now() + SESSION_LIFETIME_MS;
    return { ...session.user, token, expiresAt: session.expiresAt };
  }

  function requireRole(user, roles) {
    if (!roles.includes(user.role)) {
      throw Object.assign(new Error('Cette opération n’est pas autorisée.'), { statusCode: 403 });
    }
  }

  async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        throw Object.assign(new Error('La requête dépasse la taille maximale autorisée.'), {
          statusCode: 413
        });
      }
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('Le corps JSON de la requête est invalide.'), {
        statusCode: 400
      });
    }
  }

  function getLockKey(entityType, entityId) {
    if (!['gu', 'rec'].includes(entityType)) {
      throw Object.assign(new Error('Type de dossier invalide.'), { statusCode: 400 });
    }
    return `${entityType}:${validateId(entityId, 'Identifiant de dossier')}`;
  }

  function assertEditLock(user, entityType, entityId, request) {
    const key = getLockKey(entityType, entityId);
    const lock = locks.get(key);
    const suppliedToken = request.headers['x-edit-lock'];
    if (!lock || lock.expiresAt <= Date.now() ||
        lock.userId !== user.id || lock.lockToken !== suppliedToken) {
      throw Object.assign(
        new Error('Ce dossier est verrouillé par un autre utilisateur ou votre verrou a expiré. Rechargez-le.'),
        { statusCode: 423 }
      );
    }
    lock.expiresAt = Date.now() + lockLeaseSeconds * 1000;
  }

  async function restoreBackup(name, user) {
    if (typeof name !== 'string' || !/^backup-[\da-zA-ZT._-]{8,80}\.sqlite$/.test(name)) {
      throw Object.assign(new Error('Nom de sauvegarde invalide.'), { statusCode: 400 });
    }
    const source = path.join(backupDirectory, name);
    if (!fs.existsSync(source)) {
      throw Object.assign(new Error('Sauvegarde introuvable.'), { statusCode: 404 });
    }
    const candidate = `${databasePath}.${process.pid}.restore.tmp`;
    if (fs.existsSync(candidate)) {
      throw new Error('Un fichier temporaire de restauration existe déjà.');
    }
    const backupDatabase = new DatabaseSync(source, { readOnly: true });
    try {
      if (backupDatabase.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
          backupDatabase.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('La sauvegarde sélectionnée n’est pas intègre.');
      }
      await backup(backupDatabase, candidate);
    } finally {
      backupDatabase.close();
    }
    const restored = new DatabaseSync(candidate, { readOnly: true });
    try {
      if (restored.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
          restored.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error('La copie restaurée n’a pas passé les contrôles d’intégrité.');
      }
      if (!restored.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'central_users'"
      ).get()) {
        throw new Error('La sauvegarde ne contient pas le schéma central requis.');
      }
    } finally {
      restored.close();
    }
    const beforeRestore = path.join(
      backupDirectory,
      `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`
    );
    await createBackup(beforeRestore, user);
    database.close();
    fs.renameSync(candidate, databasePath);
    database = await data.initializeDatabase(databasePath);
    initializeServiceSchema(database);
    sessions.clear();
    locks.clear();
    audit(null, 'backup.restore', 'backup', name, {
      actor: user.username,
      beforeRestore: path.basename(beforeRestore)
    });
    publish({ type: 'restore', actor: user.username });
  }

  async function changeStorage(body, user) {
    const nextBackupDirectory = body.backupDirectory === undefined
      ? backupDirectory
      : path.resolve(requireText(body.backupDirectory, 'Le dossier des sauvegardes', 1000));
    const nextDatabasePath = body.databasePath === undefined
      ? databasePath
      : path.resolve(requireText(body.databasePath, 'Le chemin de la base', 1000));
    let newDatabase = null;
    let temporaryDatabasePath = null;

    if (nextDatabasePath !== databasePath) {
      if (fs.existsSync(nextDatabasePath)) {
        throw Object.assign(new Error('La base cible existe déjà; aucune donnée ne sera écrasée.'), {
          statusCode: 409
        });
      }
      fs.mkdirSync(path.dirname(nextDatabasePath), { recursive: true });
      temporaryDatabasePath = `${nextDatabasePath}.${process.pid}.move.tmp`;
      if (fs.existsSync(temporaryDatabasePath)) {
        throw new Error('Un fichier temporaire de transfert existe déjà.');
      }
      await backup(database, temporaryDatabasePath);
      newDatabase = new DatabaseSync(temporaryDatabasePath, { readOnly: true });
      if (newDatabase.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
          newDatabase.prepare('PRAGMA foreign_key_check').all().length) {
        newDatabase.close();
        newDatabase = null;
        fs.unlinkSync(temporaryDatabasePath);
        throw new Error('La copie vers le nouveau stockage n’est pas intègre.');
      }
      newDatabase.close();
      newDatabase = null;
    }

    fs.mkdirSync(nextBackupDirectory, { recursive: true });
    const probe = path.join(nextBackupDirectory, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok', { flag: 'wx' });
    fs.unlinkSync(probe);
    const nextConfig = {
      databasePath: nextDatabasePath,
      backupDirectory: nextBackupDirectory,
      backupTime,
      lockLeaseSeconds
    };
    atomicWrite(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

    if (temporaryDatabasePath) {
      database.close();
      fs.renameSync(temporaryDatabasePath, nextDatabasePath);
      databasePath = nextDatabasePath;
      database = await data.initializeDatabase(nextDatabasePath);
      initializeServiceSchema(database);
    }
    backupDirectory = nextBackupDirectory;
    databasePath = nextDatabasePath;
    audit(user, 'storage.update', 'settings', null, nextConfig);
    publish({ type: 'storage-updated', actor: user.username });
    return { databasePath: nextDatabasePath, backupDirectory };
  }

  async function route(request, response) {
    if (!safePrivatePeer(request.socket.remoteAddress)) {
      throw Object.assign(new Error('Connexions autorisées uniquement depuis le réseau local.'), {
        statusCode: 403
      });
    }
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      return { status: 'ok', database: database.prepare('PRAGMA quick_check').get().quick_check };
    }

    if (request.method === 'POST' && url.pathname === '/api/bootstrap') {
      if (!bootstrapAvailable ||
          database.prepare('SELECT 1 FROM central_users LIMIT 1').get()) {
        throw Object.assign(new Error('La configuration initiale est déjà terminée.'), {
          statusCode: 409
        });
      }
      const body = await readBody(request);
      if (body.setupCode !== bootstrapToken) {
        throw Object.assign(new Error('Le code initial de configuration est incorrect.'), {
          statusCode: 403
        });
      }
      const username = safeUsername(body.username);
      const password = passwordRecord(body.password);
      database.prepare(`
        INSERT INTO central_users (username, password_salt, password_hash, role)
        VALUES (?, ?, ?, 'admin')
      `).run(username, password.salt, password.hash);
      bootstrapAvailable = false;
      const user = database.prepare(
        'SELECT id, username, role FROM central_users WHERE username = ?'
      ).get(username);
      audit(user, 'account.bootstrap', 'user', user.id);
      return { token: createSession(user), user };
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(request);
      const username = safeUsername(body.username);
      const ip = request.socket.remoteAddress || 'unknown';
      const rateKey = `${ip}:${username.toLowerCase()}`;
      const now = Date.now();
      const throttle = loginAttempts.get(ip);
      if (throttle && throttle.count >= 30 && throttle.resetAt > now) {
        throw Object.assign(new Error('Trop de tentatives; réessayez dans quelques minutes.'), {
          statusCode: 429
        });
      }
      const failures = loginFailures.get(rateKey);
      if (failures && failures.count >= 5 && failures.resetAt > now) {
        throw Object.assign(new Error('Identifiants invalides ou compte temporairement bloqué.'), {
          statusCode: 429
        });
      }
      const account = database.prepare(`
        SELECT id, username, password_salt AS salt, password_hash AS hash,
               role, disabled
        FROM central_users WHERE username = ? COLLATE NOCASE
      `).get(username);
      const candidate = account && typeof body.password === 'string'
        ? crypto.scryptSync(body.password, Buffer.from(account.salt, 'hex'), 64, {
          N: 16384, r: 8, p: 1
        })
        : crypto.scryptSync(String(body.password || ''), Buffer.alloc(16), 64, {
          N: 16384, r: 8, p: 1
        });
      const valid = account && !account.disabled &&
        crypto.timingSafeEqual(candidate, account
          ? Buffer.from(account.hash, 'hex')
          : Buffer.alloc(64));
      if (!valid) {
        const current = failures && failures.resetAt > now
          ? failures
          : { count: 0, resetAt: now + 15 * 60 * 1000 };
        current.count += 1;
        loginFailures.set(rateKey, current);
        const ipAttempts = throttle && throttle.resetAt > now
          ? throttle
          : { count: 0, resetAt: now + 15 * 60 * 1000 };
        ipAttempts.count += 1;
        loginAttempts.set(ip, ipAttempts);
        throw Object.assign(new Error('Identifiants invalides.'), { statusCode: 401 });
      }
      loginFailures.delete(rateKey);
      const user = { id: account.id, username: account.username, role: account.role };
      audit(user, 'auth.login', 'session');
      return { token: createSession(user), user };
    }

    const user = authenticated(request);
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      sessions.delete(user.token);
      for (const [key, lock] of locks) {
        if (lock.token === user.token) locks.delete(key);
      }
      audit(user, 'auth.logout', 'session');
      return { status: 'ok' };
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      return { id: user.id, username: user.username, role: user.role };
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.write('event: ready\ndata: {}\n\n');
      eventClients.add(response);
      response.on('close', () => eventClients.delete(response));
      return undefined;
    }
    if (request.method === 'GET' && url.pathname === '/api/preferences/buttons') {
      const row = database.prepare(
        'SELECT button_preferences FROM central_user_preferences WHERE user_id = ?'
      ).get(user.id);
      return row ? JSON.parse(row.button_preferences) : {};
    }
    if (request.method === 'PUT' && url.pathname === '/api/preferences/buttons') {
      const preferences = validatePreferences(await readBody(request));
      database.prepare(`
        INSERT INTO central_user_preferences (user_id, button_preferences, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          button_preferences = excluded.button_preferences,
          updated_at = CURRENT_TIMESTAMP
      `).run(user.id, JSON.stringify(preferences));
      audit(user, 'preferences.update', 'preferences');
      return preferences;
    }
    if (request.method === 'POST' && url.pathname === '/api/locks/acquire') {
      const body = await readBody(request);
      const key = getLockKey(body.entityType, body.entityId);
      const current = locks.get(key);
      if (user.role === 'viewer') {
        return { acquired: false, readOnly: true, holder: current?.username || null };
      }
      if (current && current.expiresAt > Date.now() && current.userId !== user.id) {
        return { acquired: false, readOnly: true, holder: current.username };
      }
      const lock = current?.userId === user.id
        ? current
        : { lockToken: crypto.randomBytes(24).toString('base64url') };
      Object.assign(lock, {
        token: user.token,
        userId: user.id,
        username: user.username,
        entityType: body.entityType,
        entityId: validateId(body.entityId, 'Identifiant de dossier'),
        expiresAt: Date.now() + lockLeaseSeconds * 1000
      });
      locks.set(key, lock);
      publish({ type: 'lock-acquired', entityType: lock.entityType, entityId: lock.entityId, username: user.username });
      return { acquired: true, lockToken: lock.lockToken, expiresAt: lock.expiresAt };
    }
    if (request.method === 'POST' && url.pathname === '/api/locks/renew') {
      const body = await readBody(request);
      const key = getLockKey(body.entityType, body.entityId);
      const lock = locks.get(key);
      if (!lock || lock.userId !== user.id || lock.lockToken !== body.lockToken) {
        throw Object.assign(new Error('Le verrou n’existe plus; rechargez le dossier.'), {
          statusCode: 423
        });
      }
      lock.expiresAt = Date.now() + lockLeaseSeconds * 1000;
      return { expiresAt: lock.expiresAt };
    }
    if (request.method === 'POST' && url.pathname === '/api/locks/release') {
      const body = await readBody(request);
      const key = getLockKey(body.entityType, body.entityId);
      const lock = locks.get(key);
      if (lock && lock.userId === user.id && lock.lockToken === body.lockToken) {
        locks.delete(key);
        publish({ type: 'lock-released', entityType: body.entityType, entityId: Number(body.entityId) });
      }
      return { released: true };
    }
    if (request.method === 'GET' && url.pathname === '/api/users') {
      requireRole(user, ['admin']);
      return database.prepare(`
        SELECT id, username, role, disabled, created_at AS createdAt
        FROM central_users ORDER BY username COLLATE NOCASE
      `).all();
    }
    if (request.method === 'POST' && url.pathname === '/api/users') {
      requireRole(user, ['admin']);
      const body = await readBody(request);
      const username = safeUsername(body.username);
      const role = body.role;
      if (!ROLES.has(role)) throw new Error('Rôle utilisateur invalide.');
      const password = passwordRecord(body.password);
      const result = database.prepare(`
        INSERT INTO central_users (username, password_salt, password_hash, role)
        VALUES (?, ?, ?, ?)
      `).run(username, password.salt, password.hash, role);
      const created = {
        id: Number(result.lastInsertRowid),
        username,
        role,
        disabled: 0
      };
      audit(user, 'user.create', 'user', created.id, { username, role });
      publish({ type: 'users-updated', actor: user.username });
      return created;
    }
    if (request.method === 'PATCH' && /^\/api\/users\/\d+$/.test(url.pathname)) {
      requireRole(user, ['admin']);
      const id = validateId(url.pathname.split('/').at(-1), 'Identifiant utilisateur');
      const body = await readBody(request);
      const target = database.prepare(
        'SELECT id, username, role FROM central_users WHERE id = ?'
      ).get(id);
      if (!target) throw Object.assign(new Error('Utilisateur introuvable.'), { statusCode: 404 });
      if (id === user.id && (body.disabled || body.role && body.role !== 'admin')) {
        throw new Error('Vous ne pouvez pas désactiver ou rétrograder votre propre compte.');
      }
      if (body.role !== undefined && !ROLES.has(body.role)) {
        throw new Error('Rôle utilisateur invalide.');
      }
      if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
        throw new Error('État du compte invalide.');
      }
      if (body.password !== undefined && body.password !== '') {
        const password = passwordRecord(body.password);
        database.prepare(`
          UPDATE central_users SET password_salt = ?, password_hash = ? WHERE id = ?
        `).run(password.salt, password.hash, id);
      }
      database.prepare(`
        UPDATE central_users
        SET role = COALESCE(?, role), disabled = COALESCE(?, disabled)
        WHERE id = ?
      `).run(body.role ?? null, body.disabled == null ? null : Number(body.disabled), id);
      if (body.disabled || body.role !== undefined ||
          (typeof body.password === 'string' && body.password.length > 0)) {
        for (const [token, session] of sessions) {
          if (session.user.id === id) sessions.delete(token);
        }
        for (const [key, lock] of locks) {
          if (lock.userId === id) locks.delete(key);
        }
      }
      audit(user, 'user.update', 'user', id, {
        username: target.username,
        role: body.role,
        disabled: body.disabled,
        passwordChanged: typeof body.password === 'string' && body.password.length > 0
      });
      publish({ type: 'users-updated', actor: user.username });
      return database.prepare(`
        SELECT id, username, role, disabled, created_at AS createdAt
        FROM central_users WHERE id = ?
      `).get(id);
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/settings') {
      requireRole(user, ['admin']);
      return { databasePath, backupDirectory, backupTime, lockLeaseSeconds };
    }
    if (request.method === 'PUT' && url.pathname === '/api/admin/settings') {
      requireRole(user, ['admin']);
      const body = await readBody(request);
      if (body.backupTime !== undefined) {
        if (typeof body.backupTime !== 'string' ||
            !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.backupTime)) {
          throw new Error('Heure de sauvegarde invalide (HH:MM).');
        }
        backupTime = body.backupTime;
      }
      if (body.lockLeaseSeconds !== undefined) {
        if (!Number.isSafeInteger(body.lockLeaseSeconds) ||
            body.lockLeaseSeconds < 15 || body.lockLeaseSeconds > 300) {
          throw new Error('La durée du verrou doit être comprise entre 15 et 300 secondes.');
        }
        lockLeaseSeconds = body.lockLeaseSeconds;
      }
      commitConfiguration();
      audit(user, 'settings.update', 'settings', null, { backupTime, lockLeaseSeconds });
      return { databasePath, backupDirectory, backupTime, lockLeaseSeconds };
    }
    if (request.method === 'PUT' && url.pathname === '/api/admin/storage') {
      requireRole(user, ['admin']);
      return changeStorage(await readBody(request), user);
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/audit') {
      requireRole(user, ['admin']);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      return database.prepare(`
        SELECT id, actor_name AS actor, action, entity_type AS entityType,
               entity_id AS entityId, details, created_at AS createdAt
        FROM central_audit_log ORDER BY id DESC LIMIT ?
      `).all(limit).map((row) => ({ ...row, details: JSON.parse(row.details) }));
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/backups') {
      requireRole(user, ['admin']);
      return fs.readdirSync(backupDirectory)
        .filter((name) => /^backup-(?:\d{8}|manual-[\dTZ-]+)\.sqlite$/.test(name))
        .sort((left, right) => right.localeCompare(left))
        .map((name) => ({
          name,
          size: fs.statSync(path.join(backupDirectory, name)).size,
          modifiedAt: fs.statSync(path.join(backupDirectory, name)).mtime.toISOString()
        }));
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/backups') {
      requireRole(user, ['admin']);
      const name = `backup-manual-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
      await createBackup(path.join(backupDirectory, name), user);
      return { name };
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/backups/restore') {
      requireRole(user, ['admin']);
      const body = await readBody(request);
      await restoreBackup(body.name, user);
      return { restored: body.name };
    }
    if (request.method === 'GET' && url.pathname === '/api/reports') {
      const guCases = database.prepare('SELECT id FROM gu_cases ORDER BY id').all()
        .map(({ id }) => data.loadGuCase(database, id));
      const recCases = database.prepare('SELECT id FROM rec_cases ORDER BY id').all()
        .map(({ id }) => data.loadRecCase(database, id));
      const comparisons = database.prepare('SELECT id FROM comparisons ORDER BY id').all()
        .map(({ id }) => data.loadComparison(database, id));
      return { generatedAt: new Date().toISOString(), guCases, recCases, comparisons };
    }
    if (request.method === 'GET' && url.pathname === '/api/gu') return data.listGuCases(database);
    if (request.method === 'GET' && url.pathname === '/api/gu/available') {
      const id = url.searchParams.get('recCaseId');
      return data.listAvailableGuCases(database, id == null ? null : validateId(id, 'Identifiant REC'));
    }
    if (request.method === 'GET' && url.pathname === '/api/gu/search') {
      const query = requireText(url.searchParams.get('q'), 'La recherche GU', 100);
      return data.searchGuCases(database, query);
    }
    const guLoad = /^\/api\/gu\/(\d+)$/.exec(url.pathname);
    if (request.method === 'GET' && guLoad) {
      return data.loadGuCase(database, validateId(guLoad[1], 'Identifiant GU'));
    }
    if (request.method === 'PUT' && url.pathname === '/api/gu') {
      requireRole(user, ['admin', 'editor']);
      const value = validateGuCase(await readBody(request));
      if (value.id != null) assertEditLock(user, 'gu', value.id, request);
      const result = data.saveGuCase(database, value);
      audit(user, 'gu.save', 'gu', result.id ?? result.existingCaseId, {
        reference: result.reference
      });
      publish({ type: 'gu.changed', id: result.id ?? result.existingCaseId, actor: user.username });
      return result;
    }
    if (request.method === 'DELETE' && guLoad) {
      requireRole(user, ['admin', 'editor']);
      const id = validateId(guLoad[1], 'Identifiant GU');
      assertEditLock(user, 'gu', id, request);
      const result = data.deleteGuCase(database, id);
      locks.delete(`gu:${id}`);
      audit(user, 'gu.delete', 'gu', id);
      publish({ type: 'gu.changed', id, actor: user.username });
      return result;
    }
    if (request.method === 'GET' && url.pathname === '/api/rec') return data.listRecCases(database);
    const recLoad = /^\/api\/rec\/(\d+)$/.exec(url.pathname);
    if (request.method === 'GET' && recLoad) {
      return data.loadRecCase(database, validateId(recLoad[1], 'Identifiant REC'));
    }
    if (request.method === 'POST' && url.pathname === '/api/rec') {
      requireRole(user, ['admin', 'editor']);
      const value = validateRecCase(await readBody(request));
      const result = await data.createRecCase(database, value);
      audit(user, 'rec.create', 'rec', result.id, { reference: result.reference });
      publish({ type: 'rec.changed', id: result.id, actor: user.username });
      return result;
    }
    if (request.method === 'PUT' && recLoad) {
      requireRole(user, ['admin', 'editor']);
      const id = validateId(recLoad[1], 'Identifiant REC');
      assertEditLock(user, 'rec', id, request);
      const value = validateRecCase(await readBody(request));
      if (value.id != null && value.id !== id) throw new Error('Identifiant REC incohérent.');
      const result = data.updateRecCase(database, { ...value, id });
      audit(user, 'rec.update', 'rec', id, { reference: result.reference });
      publish({ type: 'rec.changed', id, actor: user.username });
      return result;
    }
    const recGuLink = /^\/api\/rec\/(\d+)\/gu-link$/.exec(url.pathname);
    if (request.method === 'PATCH' && recGuLink) {
      requireRole(user, ['admin', 'editor']);
      const id = validateId(recGuLink[1], 'Identifiant REC');
      assertEditLock(user, 'rec', id, request);
      const body = await readBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Le lien entre les dossiers REC et GU est invalide.');
      }
      const guCaseId = validateId(body.guCaseId, 'Identifiant GU');
      const result = data.updateRecGuLink(database, id, guCaseId);
      audit(user, 'rec.link-gu', 'rec', id, { guCaseId });
      publish({ type: 'rec.changed', id, actor: user.username });
      return result;
    }
    if (request.method === 'GET' && url.pathname === '/api/comparisons') {
      return data.listComparisons(database);
    }
    const comparisonLoad = /^\/api\/comparisons\/(\d+)$/.exec(url.pathname);
    if (request.method === 'GET' && comparisonLoad) {
      return data.loadComparison(database, validateId(comparisonLoad[1], 'Identifiant comparaison'));
    }
    if (request.method === 'PUT' && url.pathname === '/api/comparisons') {
      requireRole(user, ['admin', 'editor']);
      const value = validateComparison(await readBody(request));
      const result = data.saveComparison(database, value);
      audit(user, 'comparison.save', 'comparison', result.id, { name: result.name });
      publish({ type: 'comparison.changed', id: result.id, actor: user.username });
      return result;
    }

    throw Object.assign(new Error('Route introuvable.'), { statusCode: 404 });
  }

  function createSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    sessions.set(token, { user, expiresAt });
    return token;
  }

  const server = http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    Promise.resolve(route(request, response)).then((result) => {
      if (response.writableEnded || response.headersSent) return;
      const body = Buffer.from(JSON.stringify(result === undefined ? null : result));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      response.end(body);
    }).catch((error) => {
      if (response.writableEnded || response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 400;
      if (status >= 500) console.error('Erreur du service central.', error);
      const body = Buffer.from(JSON.stringify({
        error: error.message || 'La requête a échoué.'
      }));
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      response.end(body);
    });
  });

  const host = options.host || '0.0.0.0';
  const port = options.port ?? 8765;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  if (!options.bootstrapToken) {
    console.log(`Code de configuration initiale (usage unique): ${bootstrapToken}`);
  }
  console.log(`Base centrale: ${databasePath}`);
  console.log(`Sauvegardes: ${backupDirectory}`);
  console.log(`Service central: http://${host}:${server.address().port}`);
  if (initialDatabaseExists) {
    console.log('Une base centrale existante a été ouverte; aucune base métier locale n’a été importée.');
  }

  return {
    server,
    get databasePath() {
      return databasePath;
    },
    configPath,
    bootstrapToken,
    address: server.address(),
    getDatabase: () => database,
    runScheduledBackup: scheduledBackupTick,
    async close() {
      if (closed) return;
      closed = true;
      timers.forEach(clearInterval);
      for (const response of eventClients) response.end();
      eventClients.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      database.close();
    }
  };
}

module.exports = { createCentralService, safePrivatePeer };
