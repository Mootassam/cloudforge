'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // light security headers (no external deps)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/client', require('./routes/client'));

  const pub = path.join(__dirname, 'public');
  app.use(express.static(pub));
  app.get('/', (_req, res) => res.sendFile(path.join(pub, 'login.html')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(pub, 'admin.html')));
  app.get('/app', (_req, res) => res.sendFile(path.join(pub, 'client.html')));

  // JSON 404 for unknown API routes
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

  // error handler → always JSON, never an HTML stack trace
  app.use((err, _req, res, _next) => {
    console.error('[error]', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Server error.' });
  });

  return app;
}

module.exports = { createApp };
