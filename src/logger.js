'use strict';

const winston = require('winston');

const isDev = process.env.NODE_ENV !== 'production';

// Custom transport to forward Winston logs to LaunchDarkly Observability
let LDObserve;
try {
  LDObserve = require('@launchdarkly/observability-node').LDObserve;
} catch (_) {
  // Package not available on this branch — skip
}

class LDTransport extends winston.Transport {
  log(info, callback) {
    if (LDObserve) {
      const { message, level, timestamp, service, ...metadata } = info;
      LDObserve.recordLog(message, level, undefined, undefined, metadata);
    }
    callback();
  }
}

const transports = [new winston.transports.Console()];
if (LDObserve) transports.push(new LDTransport());

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
