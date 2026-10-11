const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lotissementAPI', Object.freeze({
  getServerConnection: () => ipcRenderer.invoke('server:connection:get'),
  setServerConnection: (serverUrl) =>
    ipcRenderer.invoke('server:connection:set', serverUrl),
  bootstrapServerAdmin: (credentials) =>
    ipcRenderer.invoke('server:auth:bootstrap', credentials),
  login: (credentials) => ipcRenderer.invoke('server:auth:login', credentials),
  logout: () => ipcRenderer.invoke('server:auth:logout'),
  getCurrentUser: () => ipcRenderer.invoke('server:auth:me'),
  acquireCaseLock: (entityType, id) =>
    ipcRenderer.invoke('case:lock:acquire', entityType, id),
  releaseCaseLock: (entityType, id) =>
    ipcRenderer.invoke('case:lock:release', entityType, id),
  loadReportData: () => ipcRenderer.invoke('reports:data'),
  exportReportPdf: () => ipcRenderer.invoke('reports:export:pdf'),
  exportReportExcel: () => ipcRenderer.invoke('reports:export:excel'),
  printReport: () => ipcRenderer.invoke('reports:print'),
  listUsers: () => ipcRenderer.invoke('admin:users:list'),
  createUser: (user) => ipcRenderer.invoke('admin:users:create', user),
  updateUser: (id, changes) => ipcRenderer.invoke('admin:users:update', id, changes),
  loadAdminSettings: () => ipcRenderer.invoke('admin:settings:get'),
  saveAdminSettings: (settings) =>
    ipcRenderer.invoke('admin:settings:save', settings),
  saveStorageSettings: (settings) =>
    ipcRenderer.invoke('admin:storage:save', settings),
  listBackups: () => ipcRenderer.invoke('admin:backups:list'),
  createBackup: () => ipcRenderer.invoke('admin:backups:create'),
  restoreBackup: (name) => ipcRenderer.invoke('admin:backups:restore', name),
  listAuditEvents: () => ipcRenderer.invoke('admin:audit:list'),
  onServerAuthenticated: (callback) => {
    const listener = (_event, user) => callback(user);
    ipcRenderer.on('server:authenticated', listener);
    return () => ipcRenderer.removeListener('server:authenticated', listener);
  },
  onServerAuthExpired: (callback) => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on('server:auth-expired', listener);
    return () => ipcRenderer.removeListener('server:auth-expired', listener);
  },
  onServerEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('server:event', listener);
    return () => ipcRenderer.removeListener('server:event', listener);
  },
  onLockLost: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('server:lock-lost', listener);
    return () => ipcRenderer.removeListener('server:lock-lost', listener);
  },
  saveGuCase: (guCase) => ipcRenderer.invoke('gu:save', guCase),
  loadGuCase: (reference) => ipcRenderer.invoke('gu:load', reference),
  searchGuCases: (query) => ipcRenderer.invoke('gu:search', query),
  listGuCases: () => ipcRenderer.invoke('gu:list'),
  deleteGuCase: (id) => ipcRenderer.invoke('gu:delete', id),
  listAvailableGuCases: (recCaseId) => ipcRenderer.invoke('rec:list-available-gu', recCaseId),
  createRecCase: (recCase) => ipcRenderer.invoke('rec:create', recCase),
  listRecCases: () => ipcRenderer.invoke('rec:list'),
  loadRecCase: (id) => ipcRenderer.invoke('rec:load', id),
  updateRecCase: (recCase) => ipcRenderer.invoke('rec:update', recCase),
  linkRecCaseToGu: (recCaseId, guCaseId) =>
    ipcRenderer.invoke('rec:link-gu', recCaseId, guCaseId),
  listComparisons: () => ipcRenderer.invoke('comparison:list'),
  loadComparison: (id) => ipcRenderer.invoke('comparison:load', id),
  saveComparison: (comparison) => ipcRenderer.invoke('comparison:save', comparison),
  loadButtonPreferences: () => ipcRenderer.invoke('preferences:buttons:load'),
  saveButtonPreferences: (preferences) =>
    ipcRenderer.invoke('preferences:buttons:save', preferences)
}));