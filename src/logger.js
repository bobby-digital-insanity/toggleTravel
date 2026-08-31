'use strict';

const winston = require('winston');
const Sentry = require('@sentry/node');

const isDev = process.env.NODE_ENV !== 'production';

// Winston level → Sentry severity. Sentry uses 'warning', not 'warn'.
const SENTRY_LEVELS = { error: 'error', warn: 'warning', info: 'info', debug: 'debug', verbose: 'debug' };

// Forward every Winston line to Sentry TWICE, because breadcrumbs and logs are
// different products and each answers a different question:
//
//   1. addBreadcrumb — rides along with the next captured event on this scope.
//      Open an error in Sentry and you see the ~10 lines that led to it (booking
//      stages, flag reads, payment result). Sends nothing on its own, so it is
//      free when the app is healthy — but it is not searchable, and lines from a
//      request that never errored are discarded.
//   2. Sentry.logger — a real structured log, searchable in Sentry Logs whether
//      or not an error occurred. This is the analogue of what the datadog branch
//      gets from Log Management; without it this branch looked thinner than
//      Sentry actually is.
//
// Winston's `level` strings don't all map onto Sentry's logger methods
// ('warn' -> warning for breadcrumbs, but the logger method is `warn`; there is
// no `verbose`), so both mappings are explicit below.
const LOGGER_METHODS = { error: 'error', warn: 'warn', info: 'info', debug: 'debug', verbose: 'debug' };

class SentryTransport extends winston.Transport {
  log(info, callback) {
    try {
      const { message, level, timestamp, service, ...metadata } = info;

      Sentry.addBreadcrumb({
        category: 'app.log',
        message: String(message),
        level: SENTRY_LEVELS[level] || 'info',
        data: metadata,
      });

      // Structured log. Attributes must be flat scalars, so anything object-ish
      // in the Winston metadata is JSON-stringified rather than dropped.
      const method = LOGGER_METHODS[level] || 'info';
      if (typeof Sentry.logger?.[method] === 'function') {
        const attributes = {};
        for (const [k, v] of Object.entries(metadata)) {
          attributes[k] = (v === null || typeof v === 'object') ? JSON.stringify(v) : v;
        }
        Sentry.logger[method](String(message), attributes);
      }
    } catch (_) {
      // A telemetry failure must never break logging.
    }
    callback();
  }
}

const transports = [new winston.transports.Console(), new SentryTransport()];

const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  defaultMeta: { service: 'toggle-travel' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, service, ...rest }) => {
            const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
            return `${timestamp} [${service}] ${level}: ${message}${extra}`;
          })
        )
      : winston.format.json()
  ),
  transports,
});

module.exports = logger;
