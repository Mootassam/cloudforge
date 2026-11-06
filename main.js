'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createStore } = require('./src/store');
const { testConnection, runCommand } = require('./src/ssh');
const { generateCode } = require('./src/codes');
const { httpCheck, serverHealth, containerLogs } = require('./src/monitor');
const { checkCert } = require('./src/certs');
const { sendMessage } = require('./src/telegram');
const { uploadProject } = require('./src/upload');

let win;
let store;

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b0f17', title: 'CloudForge Admin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);

  const logPath = path.join(__dirname, 'debug.log');
  const log = (line) => { try { fs.appendFileSync(logPath, line + '\n'); } catch {} };
  try { fs.writeFileSync(logPath, `CloudForge debug log — ${new Date().toISOString()}\n`); } catch {}
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => log(`[console:${level}] ${message}  (${sourceId}:${line})`));
  win.webContents.on('did-fail-load', (_e, c, d, u) => log(`[did-fail-load] ${c} ${d} ${u}`));
  win.webContents.on('preload-error', (_e, p, err) => log(`[preload-error] ${p} :: ${err && err.message}`));

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (process.env.CF_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  store = createStore(path.join(app.getPath('userData'), 'cloudforge-data.json'));
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ---- helpers ---- */
function getProjectOr(id) { const p = store.getProject(id); if (!p) throw new Error('Project not found'); return p; }
async function notify(text) {
  const tg = (store.read().settings || {}).telegram || {};
  if (tg.botToken && tg.chatId) { try { await sendMessage(tg.botToken, tg.chatId, text); } catch {} }
}

/* ---- data / projects ---- */
ipcMain.handle('get-data', () => store.read());
ipcMain.handle('save-project', (_e, project) => store.upsertProject(project));
ipcMain.handle('delete-project', (_e, id) => store.deleteProject(id));
ipcMain.handle('save-global-rules', (_e, text) => store.setGlobalRules(text));
ipcMain.handle('set-api-key-status', (_e, { id, apiKeySet }) => store.setApiKeyStatus(id, apiKeySet));
ipcMain.handle('save-settings', (_e, patch) => store.setSettings(patch));
ipcMain.handle('get-history', (_e, id) => store.getHistory(id));

ipcMain.handle('generate-code', (_e, id) => { const code = generateCode(); store.setAccessCode(id, code); return code; });

ipcMain.handle('test-connection', async (_e, id) => testConnection(getProjectOr(id).vps || {}));

/* ---- deploy (records history + alerts on failure) ---- */
ipcMain.handle('deploy', async (e, { id, mode }) => {
  const p = getProjectOr(id);
  const cmd = mode === 'containers' ? p.deployContainersCmd : p.deployFullCmd;
  const label = mode === 'containers' ? 'Deploy containers (backend + admin + server)' : 'Deploy full website';
  if (!cmd || !String(cmd).trim()) throw new Error(`No "${mode === 'containers' ? 'containers' : 'full'}" deploy command is set. Edit the project and add one.`);
  const send = (line) => { try { e.sender.send('deploy-progress', { id, line }); } catch {} };

  const steps = [];
  if (p.backupCmd && String(p.backupCmd).trim()) steps.push({ label: 'Backup first', cmd: p.backupCmd });
  steps.push({ label, cmd });

  const results = [];
  let ok = true;
  for (const s of steps) {
    send(`\n$ ── ${s.label} ──\n`);
    const r = await runCommand(p.vps || {}, s.cmd, send);
    results.push({ step: s.label, code: r.code, ok: r.code === 0 });
    if (r.code !== 0) { ok = false; send(`\n✖ "${s.label}" exited with code ${r.code}. Stopping.\n`); break; }
  }
  if (ok) send(`\n✔ All steps finished successfully.\n`);
  store.addDeploy(id, { mode, ok, label });
  if (!ok) await notify(`🚨 <b>CloudForge</b> — deploy FAILED\nProject: <b>${p.name}</b>\nMode: ${label}`);
  return { ok, steps: results };
});

ipcMain.handle('run-command', async (e, { id, cmd }) => {
  const p = getProjectOr(id);
  if (!cmd || !String(cmd).trim()) throw new Error('Empty command');
  return runCommand(p.vps || {}, cmd, (chunk) => { try { e.sender.send('console-progress', { id, line: chunk }); } catch {} });
});

/* ---- monitoring & health ---- */
ipcMain.handle('http-check', async (_e, id) => {
  const p = getProjectOr(id);
  return httpCheck((p.domains && p.domains[0]) || p.domain);
});
ipcMain.handle('server-health', async (_e, id) => serverHealth(getProjectOr(id).vps || {}));
ipcMain.handle('container-logs', async (_e, { id, container, lines }) => containerLogs(getProjectOr(id).vps || {}, container, lines));

ipcMain.handle('status-all', async () => {
  const data = store.read();
  const results = [];
  for (const p of data.projects) {
    const d = (p.domains && p.domains[0]) || p.domain;
    if (!d) { results.push({ id: p.id, ok: null, skipped: true }); continue; }
    const r = await httpCheck(d);
    results.push({ id: p.id, ok: r.ok, status: r.status, ms: r.ms, error: r.error });
  }
  const down = results.filter(r => r.ok === false);
  if (down.length) {
    const names = down.map(r => {
      const p = data.projects.find(x => x.id === r.id);
      return '• ' + (p ? p.name : '?') + (r.error ? ` (${r.error})` : ` (HTTP ${r.status})`);
    }).join('\n');
    await notify(`⚠️ <b>CloudForge</b>: ${down.length} site(s) DOWN\n${names}`);
  }
  return results;
});

/* ---- backups & rollback ---- */
ipcMain.handle('list-backups', async (_e, id) => {
  const p = getProjectOr(id);
  const dir = p.backupDir;
  if (!dir || !String(dir).trim()) throw new Error('Set a backup folder for this project first (Edit → Backup folder).');
  const r = await runCommand(p.vps || {}, `ls -lt --time-style=+%Y-%m-%d_%H:%M "${dir}" 2>/dev/null | grep -iE '\\.(tgz|tar\\.gz|zip|sql|gz)$'`);
  const items = [];
  (r.stdout || '').split('\n').forEach(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 7) items.push({ size: parts[4], date: parts[5], name: parts.slice(6).join(' ') });
  });
  return items;
});

ipcMain.handle('restore-backup', async (e, { id, file }) => {
  const p = getProjectOr(id);
  if (!p.restoreCmd || !String(p.restoreCmd).trim()) throw new Error('Set a restore command for this project first (Edit → Restore command, use {file}).');
  const dir = p.backupDir || '';
  const full = dir ? `${dir.replace(/\/$/, '')}/${file}` : file;
  const cmd = p.restoreCmd.replace(/{file}/g, full).replace(/{dir}/g, dir);
  const send = (line) => { try { e.sender.send('restore-progress', { id, line }); } catch {} };
  send(`\n$ Restoring ${file} …\n`);
  const r = await runCommand(p.vps || {}, cmd, send);
  const ok = r.code === 0;
  send(ok ? `\n✔ Restore finished.\n` : `\n✖ Restore exited with code ${r.code}.\n`);
  store.addDeploy(id, { mode: 'restore', ok, label: `Restore ${file}` });
  if (!ok) await notify(`🚨 <b>CloudForge</b> — restore FAILED\nProject: <b>${p.name}</b>\nFile: ${file}`);
  return { ok };
});

/* ---- domains, SSL ---- */
ipcMain.handle('check-cert', async (_e, domain) => checkCert(domain));

ipcMain.handle('issue-ssl', async (e, { id, domain }) => {
  const p = getProjectOr(id);
  if (!domain) throw new Error('No domain');
  const email = p.sslEmail || '';
  const cmd = (p.sslCmd && String(p.sslCmd).trim())
    ? p.sslCmd.replace(/{domain}/g, domain).replace(/{email}/g, email)
    : `certbot --nginx --non-interactive --agree-tos ${email ? '-m ' + email : '--register-unsafely-without-email'} --redirect -d ${domain}`;
  const send = (line) => { try { e.sender.send('ssl-progress', { id, line }); } catch {} };
  send(`\n$ Issuing SSL for ${domain} …\n`);
  const r = await runCommand(p.vps || {}, cmd, send);
  const ok = r.code === 0;
  send(ok ? `\n✔ SSL command finished.\n` : `\n✖ SSL command exited with code ${r.code}.\n`);
  return { ok };
});

/* ---- telegram ---- */
ipcMain.handle('telegram-test', async () => {
  const tg = (store.read().settings || {}).telegram || {};
  if (!tg.botToken || !tg.chatId) return { ok: false, error: 'Fill bot token and chat id first.' };
  return sendMessage(tg.botToken, tg.chatId, '✅ <b>CloudForge</b> test alert — Telegram is connected.');
});

/* ---- upload project to VPS ---- */
ipcMain.handle('upload-project', async (e, id) => {
  const p = getProjectOr(id);
  if (!p.localPath) throw new Error('Set a local project folder first (Edit project → Local folder).');
  if (!p.sourcePath) throw new Error('Set the source path on the VPS first (Edit project).');
  const r = await uploadProject(
    { vps: p.vps || {}, localPath: p.localPath, remotePath: p.sourcePath },
    (line) => { try { e.sender.send('upload-progress', { id, line }); } catch {} }
  );
  if (!r.ok) await notify(`🚨 <b>CloudForge</b> — upload FAILED\nProject: <b>${p.name}</b>`);
  return r;
});

/* ---- folder / key pickers ---- */
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your local project folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('pick-key-file', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose SSH private key', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return null;
  try { return fs.readFileSync(r.filePaths[0], 'utf8'); } catch (e) { throw new Error('Could not read key file: ' + e.message); }
});
