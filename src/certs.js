'use strict';
// Read a domain's live SSL certificate (from this PC) to show expiry.
const tls = require('tls');

function checkCert(domain, timeout = 10000) {
  return new Promise((resolve) => {
    if (!domain) return resolve({ ok: false, error: 'No domain' });
    const host = String(domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { socket.destroy(); } catch {} resolve(r); } };
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return done({ ok: false, error: 'No certificate' });
      const validTo = new Date(cert.valid_to);
      const daysLeft = Math.round((validTo.getTime() - Date.now()) / 86400000);
      done({
        ok: true,
        validTo: cert.valid_to,
        daysLeft,
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'unknown',
        subject: (cert.subject && cert.subject.CN) || host
      });
    });
    socket.on('error', (e) => done({ ok: false, error: e.message }));
    socket.on('timeout', () => done({ ok: false, error: 'Timeout' }));
  });
}

module.exports = { checkCert };
