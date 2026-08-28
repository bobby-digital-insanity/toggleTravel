'use strict';

// ── Module load order is critical ────────────────────────────────────────────
// instrument.js → launchdarkly.js → express
//
// Sentry patches Express, HTTP and the rest of the module graph when it
// initializes, so it has to run before anything it should instrument is
// required. instrument.js also loads dotenv, which is why there is no separate
// dotenv call above it.
require('./instrument');

const Sentry = require('@sentry/node');
const ld = require('./launchdarkly');
const db = require('./db');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const logger = require('./logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');

const healthRouter = require('./routes/health');
const destinationsRouter = require('./routes/destinations');
const searchRouter = require('./routes/search');
const bookingsRouter = require('./routes/bookings');
const demoRouter = require('./routes/demo');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & perf middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  allowedHeaders: ['Content-Type', 'Authorization', 'sentry-trace', 'baggage', 'x-session-id'],
  // x-trace-id carries the Sentry trace id back to the browser for the trace
  // banner; it must be explicitly exposed or fetch() cannot read it.
  exposedHeaders: ['x-trace-id'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Request logging
app.use(requestLogger);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health routes (no /api prefix)
app.use('/', healthRouter);

// Expose client-side LD ID and the Sentry DSN to the frontend. The browser needs
// the DSN at runtime and this app has no build step to bake it in, so it is
// served here alongside the LD client ID. A DSN is a public, write-only
// credential — it is designed to ship to browsers.
app.get('/api/config', (req, res) => {
  res.json({
    ldClientSideId: ld.getClientSideId(),
    sentryDsn: process.env.SENTRY_DSN || null,
    sentryEnvironment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    sentryRelease: process.env.SENTRY_RELEASE || null,
  });
});

// API routes
app.use('/api/destinations', destinationsRouter);
app.use('/api/search', searchRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/demo', demoRouter);

// SPA fallback for client-side routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Sentry's Express error handler must come after all routes but before any other
// error-handling middleware, so it sees the error first and still passes it down
// to errorHandler for the JSON response.
//
// shouldHandleError is widened from the default (5xx only) to include 404s,
// because two of this app's most interesting demo errors are deliberate 404s:
// the Atlantis booking (dest-013) and a missing destination/booking lookup.
// Without this they would never reach Sentry and the Errors view would look
// artificially quiet. Unrouted URLs don't throw — they return JSON from the SPA
// fallback — so this doesn't turn crawler noise into issues.
Sentry.setupExpressErrorHandler(app, {
  shouldHandleError(error) {
    const status = error.status || error.statusCode || 500;
    return status >= 500 || status === 404;
  },
});

// Centralized error handler (must be last)
app.use(errorHandler);

ld.init().then(() => {
  db.init();
  app.listen(PORT, () => {
    logger.info('server_started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  });
});

module.exports = app;
