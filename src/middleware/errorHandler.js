'use strict';

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const logger = require('../logger');

function errorHandler(err, req, res, next) {
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }

  const traceId = span ? span.spanContext().traceId : undefined;

  logger.error('unhandled_error', {
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    trace_id: traceId,
  });

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    trace_id: traceId,
  });
}

module.exports = errorHandler;
