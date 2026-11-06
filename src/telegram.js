'use strict';
// Send a Telegram alert via a bot. Admin sets botToken + chatId in Settings.
const https = require('https');

function sendMessage(botToken, chatId, text) {
  return new Promise((resolve) => {
    if (!botToken || !chatId) return resolve({ ok: false, error: 'Telegram not configured' });
    const data = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 12000
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve({ ok: !!j.ok, error: j.ok ? null : (j.description || 'Failed') }); }
        catch { resolve({ ok: false, error: 'Bad response from Telegram' }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    req.write(data);
    req.end();
  });
}

module.exports = { sendMessage };
