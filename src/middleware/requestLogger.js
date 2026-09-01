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

    // ── LaunchDarkly's Sentry integration ────────────────────────────────────
    // The integration ingests Sentry ERROR events into an LD metric, and it
    // attributes them using a Sentry custom context that must be named exactly
    // `launchdarklyContext`. If the name is wrong or the context is missing,
    // LaunchDarkly silently ignores the event — no warning, the metric just
    // stays empty. This is the whole reason a guarded rollout can be guarded by
    // Sentry errors with no custom pipeline.
    //
    // The shape mirrors the LD context the SDKs evaluate against, so treatment
    // and control arms attribute to the same keys the flag was bucketed on.
    Sentry.setContext('launchdarklyContext', { kind: 'user', key: sessionId });
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
