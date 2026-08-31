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

function count(name, value = 1, attributes = {}) {
  safe(() => Sentry.metrics.count(name, value, { attributes }));
}

function distribution(name, value, attributes = {}, unit = undefined) {
  safe(() => Sentry.metrics.distribution(name, value, { attributes, ...(unit ? { unit } : {}) }));
}

function gauge(name, value, attributes = {}, unit = undefined) {
  safe(() => Sentry.metrics.gauge(name, value, { attributes, ...(unit ? { unit } : {}) }));
}

module.exports = { count, distribution, gauge };
