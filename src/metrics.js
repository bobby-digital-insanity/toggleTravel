'use strict';

const Sentry = require('@sentry/node');

// ── Sentry metrics ───────────────────────────────────────────────────────────
// Thin wrapper over Sentry.metrics so call sites stay readable and naming stays
// consistent. Three primitives are available in the SDK:
//
//   count(name, value?, opts)        — counter, value defaults to 1
//   distribution(name, value, opts)  — histogram (percentiles in the UI)
//   gauge(name, value, opts)         — point-in-time value
//
// Naming convention: dot-separated lowercase, `<domain>.<event>`. Dimensions go
// in `attributes`, never in the metric name — a name like
// `booking.failed.dest-013` would explode cardinality and can't be aggregated.
//
// Every call is wrapped: a telemetry failure must never break a request. This is
// the same contract as reportFlagToSentry() in launchdarkly.js.
//
// Note metrics are emitted from the request's active scope, so they inherit the
// `flag.*` tags the LD bridge already attached — a spike in booking.failed can
// be sliced by the flag that caused it.

function safe(fn) {
  try {
    fn();
  } catch (_) {
    // Intentionally silent: logging here could recurse through the Winston
    // transport, which itself reports to Sentry.
  }
}

// ── Attribution (required for the Sentry -> LaunchDarkly guard bridge) ───────
// Every metric carries `session_id`, read off the request's isolation scope
// (requestLogger sets it there). This is NOT decoration: session_id IS the
// LaunchDarkly context key, and LD's metric import API requires a
// `contextKeys` value on every event. Without this attribute a Sentry metric
// cannot be attributed to a rollout arm, so it can never guard a guarded
// rollout — the aggregate would be un-splittable between treatment and control.
//
// scripts/sentry-bridge.js reads this attribute back out of the Sentry Explore
// API and maps it to contextKeys.user.
function withAttribution(attributes) {
  try {
    const sessionId = Sentry.getIsolationScope()?.getScopeData()?.tags?.session_id;
    if (sessionId && attributes.session_id === undefined) {
      return { ...attributes, session_id: String(sessionId) };
    }
  } catch (_) { /* fall through to the un-attributed attributes */ }
  return attributes;
}

function count(name, value = 1, attributes = {}) {
  safe(() => Sentry.metrics.count(name, value, { attributes: withAttribution(attributes) }));
}

function distribution(name, value, attributes = {}, unit = undefined) {
  safe(() => Sentry.metrics.distribution(name, value, { attributes: withAttribution(attributes), ...(unit ? { unit } : {}) }));
}

function gauge(name, value, attributes = {}, unit = undefined) {
  safe(() => Sentry.metrics.gauge(name, value, { attributes: withAttribution(attributes), ...(unit ? { unit } : {}) }));
}

module.exports = { count, distribution, gauge };
