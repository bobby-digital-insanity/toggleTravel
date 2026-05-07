'use strict';

const winston = require('winston');

const isDev = process.env.NODE_ENV !== 'production';

// Inject Datadog trace/span IDs for log-trace correlation
const ddTraceFormat = winston.format((info) => {
  try {
    const tracer = require('dd-trace');
    const span = tracer.scope().active();
    if (span) {
      const ctx = span.context();
      info['dd.trace_id'] = ctx.toTraceId();
      info['dd.span_id'] = ctx.toSpanId();
      info['dd.service'] = 'toggle-travel';
      info['dd.env'] = process.env.NODE_ENV || 'development';
    }
  } catch (_) {}
  return info;
});

const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  defaultMeta: { service: 'toggle-travel' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    ddTraceFormat(),
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
  transports: [new winston.transports.Console()],
});

module.exports = logger;
