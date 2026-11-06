'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('cf', {
  // data / projects
  getData: () => invoke('get-data'),
  saveProject: (p) => invoke('save-project', p),
  deleteProject: (id) => invoke('delete-project', id),
  saveGlobalRules: (t) => invoke('save-global-rules', t),
  setApiKeyStatus: (id, apiKeySet) => invoke('set-api-key-status', { id, apiKeySet }),
  saveSettings: (patch) => invoke('save-settings', patch),
  generateCode: (id) => invoke('generate-code', id),
  getHistory: (id) => invoke('get-history', id),

  // connection / deploy / console
  testConnection: (id) => invoke('test-connection', id),
  deploy: (id, mode) => invoke('deploy', { id, mode }),
  onDeployProgress: (cb) => ipcRenderer.on('deploy-progress', (_e, p) => cb(p)),
  runCommand: (id, cmd) => invoke('run-command', { id, cmd }),
  onConsoleProgress: (cb) => ipcRenderer.on('console-progress', (_e, p) => cb(p)),

  // monitoring & health
  httpCheck: (id) => invoke('http-check', id),
  statusAll: () => invoke('status-all'),
  serverHealth: (id) => invoke('server-health', id),
  containerLogs: (id, container, lines) => invoke('container-logs', { id, container, lines }),

  // backups & rollback
  listBackups: (id) => invoke('list-backups', id),
  restoreBackup: (id, file) => invoke('restore-backup', { id, file }),
  onRestoreProgress: (cb) => ipcRenderer.on('restore-progress', (_e, p) => cb(p)),

  // domains / ssl
  checkCert: (domain) => invoke('check-cert', domain),
  issueSsl: (id, domain) => invoke('issue-ssl', { id, domain }),
  onSslProgress: (cb) => ipcRenderer.on('ssl-progress', (_e, p) => cb(p)),

  // telegram
  telegramTest: () => invoke('telegram-test'),

  // upload project to VPS
  uploadProject: (id) => invoke('upload-project', id),
  onUploadProgress: (cb) => ipcRenderer.on('upload-progress', (_e, p) => cb(p)),

  // misc
  pickFolder: () => invoke('pick-folder'),
  pickKeyFile: () => invoke('pick-key-file')
});
