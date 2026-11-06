'use strict';
// Upload a local project folder TO any VPS over SSH/SFTP.
// 1) pack the folder into a .tgz locally (Windows 10+/Linux/mac all ship `tar`)
// 2) send the archive via SFTP
// 3) extract it into the source path on the server
const { Client } = require('ssh2');
const { buildAuth, attach } = require('./ssh');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function makeTar(localPath) {
  return new Promise((resolve, reject) => {
    if (!localPath || !fs.existsSync(localPath)) return reject(new Error('Local folder not found: ' + localPath));
    const tmp = path.join(os.tmpdir(), `cloudforge-upload-${Date.now()}.tgz`);
    const args = ['-czf', tmp, '--exclude=node_modules', '--exclude=.git', '--exclude=.next', '--exclude=dist', '-C', localPath, '.'];
    const p = spawn('tar', args);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', e => reject(new Error('Could not run tar on this PC: ' + e.message)));
    p.on('close', code => code === 0 ? resolve(tmp) : reject(new Error('Packing failed: ' + (err.trim() || 'exit ' + code))));
  });
}

function uploadProject({ vps, localPath, remotePath }, onProgress) {
  const log = (l) => { if (onProgress) onProgress(l); };
  return new Promise((resolve, reject) => {
    if (!remotePath) return reject(new Error('No source path on the VPS set.'));
    if (!vps || !vps.host || !vps.user) return reject(new Error('VPS host or SSH user missing.'));

    log('Packing project (skipping node_modules, .git, dist)…\n');
    makeTar(localPath).then((tmp) => {
      const remoteTmp = `/tmp/cloudforge-upload-${Date.now()}.tgz`;
      const conn = attach(new Client(), vps);
      const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };

      conn.on('ready', () => {
        log('Connected to VPS. Uploading…\n');
        conn.sftp((err, sftp) => {
          if (err) { cleanup(); conn.end(); return reject(err); }
          const total = fs.statSync(tmp).size;
          let lastPct = 0;
          sftp.fastPut(tmp, remoteTmp, {
            step: (transferred) => {
              const pct = total ? Math.round(transferred / total * 100) : 0;
              if (pct >= lastPct + 10) { lastPct = pct; log(`  uploaded ${pct}%\n`); }
            }
          }, (err2) => {
            if (err2) { cleanup(); conn.end(); return reject(err2); }
            log('Extracting on the server…\n');
            const cmd = `mkdir -p "${remotePath}" && tar xzf "${remoteTmp}" -C "${remotePath}" && rm -f "${remoteTmp}"`;
            conn.exec(cmd, (err3, stream) => {
              if (err3) { cleanup(); conn.end(); return reject(err3); }
              stream.on('data', d => log(d.toString()));
              stream.stderr.on('data', d => log(d.toString()));
              stream.on('close', (code) => {
                cleanup(); conn.end();
                if (code === 0) { log(`\n✔ Project uploaded to ${remotePath}\n`); resolve({ ok: true }); }
                else { log(`\n✖ Extract exited with code ${code}\n`); resolve({ ok: false }); }
              });
            });
          });
        });
      });
      conn.on('error', (e) => { cleanup(); reject(e); });
      try { conn.connect(buildAuth(vps)); } catch (e) { cleanup(); reject(e); }
    }).catch(reject);
  });
}

module.exports = { uploadProject };
