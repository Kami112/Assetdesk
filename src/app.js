'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { loadUser, requireAjaxHeader } = require('./auth');
const { ValidationError } = require('./validate');

const UNIQUE_MESSAGES = {
  'assets.tag': { tag: 'Another asset already uses this tag.' },
  'assets.serial': { serial: 'Another asset already has this serial number.' },
  'employees.email': { email: 'Another employee already uses this email.' },
  'users.email': { email: 'A user with this email already exists.' },
};

function createApp({ db, demo = false, publicUrl = null }) {
  const app = express();
  const ctx = { db, demo, publicUrl };

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(loadUser(db));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', requireAjaxHeader);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', require('./routes/auth')(ctx));
  app.use('/api', require('./routes/assets')(ctx));
  app.use('/api', require('./routes/people')(ctx));
  app.use('/api', require('./routes/reports')(ctx));
  app.use('/api', require('./routes/io')(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Short links printed in QR labels.
  app.get('/a/:tag', (req, res) => res.redirect(`/#/scan/${encodeURIComponent(req.params.tag)}`));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: demo ? 0 : '1h' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, errors: err.errors });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (max 5 MB).' });
    const unique = /UNIQUE constraint failed: (\w+\.\w+)/.exec(err?.message || '');
    if (unique) {
      const errors = UNIQUE_MESSAGES[unique[1]] || { _: 'That value is already in use.' };
      return res.status(409).json({ error: Object.values(errors)[0], errors });
    }
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

module.exports = { createApp };
