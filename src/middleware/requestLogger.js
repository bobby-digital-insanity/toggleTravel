'use strict';

const Sentry = require('@sentry/node');
const logger = require('./../logger');

function requestLogger(req, res, next) {
  const start = Date.now();
  const sessionId = req.get('x-session-id') || null;

  // Attach session ID so routes/services can include it in their own logs
  if (sessionId) req.sessionId = sessionId;

  // The session id is the LaunchDarkly context key, so tagging it here is what
  // lets you pivot from a Sentry error to "which LD context saw this" — and it
  // is the join key between a Sentry issue and an LD flag evaluation.
  if (sessionId) {
    Sentry.setTag('session_id', sessionId);
    Sentry.setUser({ id: sessionId });
  }

  // Surface the Sentry trace id on the response. public/js/api.js already looks
  // for x-trace-id and pops a "Trace: …" banner with it — that banner was dead
  // on main (nothing set the header). This makes it live and gives a copyable id
  // that pastes straight into Sentry's trace search.
  const activeSpan = Sentry.getActiveSpan();
  const traceId = activeSpan?.spanContext?.().traceId;
  if (traceId) res.setHeader('x-trace-id', traceId);

  res.on('finish', () => {
    const fields = {
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
      user_agent: req.get('user-agent'),
      ip: req.ip,
    };
    if (sessionId) fields.session_id = sessionId;
    logger.info('http_request', fields);
  });

  next();
}

module.exports = requestLogger;
