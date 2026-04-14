'use strict';

const { trace, context } = require('@opentelemetry/api');
const logger = require('../logger');

function requestLogger(req, res, next) {
  const start = Date.now();

  // Inject trace ID into response header as early as possible
  const earlySpan = trace.getActiveSpan();
  if (earlySpan) {
    const traceId = earlySpan.spanContext().traceId;
    res.setHeader('X-Trace-Id', traceId);
  }

  res.on('finish', () => {
    const span = trace.getActiveSpan();
    const traceId = span ? span.spanContext().traceId
      : res.getHeader('X-Trace-Id');
    const spanId = span ? span.spanContext().spanId : undefined;

    const durationMs = Date.now() - start;
    logger.info('http_request', {
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: durationMs,
      user_agent: req.get('user-agent'),
      ip: req.ip,
      trace_id: traceId,
      span_id: spanId,
    });
  });

  next();
}

module.exports = requestLogger;
