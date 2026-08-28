'use strict';

const winston = require('winston');
const Sentry = require('@sentry/node');

const isDev = process.env.NODE_ENV !== 'production';

// Winston level → Sentry severity. Sentry uses 'warning', not 'warn'.
const SENTRY_LEVELS = { error: 'error', warn: 'warning', info: 'info', debug: 'debug', verbose: 'debug' };

// Forward every log line to Sentry as a breadcrumb. Breadcrumbs are attached to
// whatever event is captured next on the same scope, so an error arriving from
// errorHandler carries the structured trail that led to it — the booking stage
// logs, the flag reads, the payment result. This is the closest analogue to the
// launchdarkly branch's LDTransport.
//
// Breadcrumbs are NOT the same as capturing: nothing is sent to Sentry on its
// own, so this stays cheap on the hot path and produces no events when the app
// is healthy.
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
