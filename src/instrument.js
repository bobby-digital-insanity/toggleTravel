'use strict';

// ── Sentry initialization ────────────────────────────────────────────────────
// This file MUST be the first require in the process (see server.js). The Node
// SDK patches HTTP, Express, and other module internals at init time, so
// anything required before this point is invisible to auto-instrumentation.
// This is the same ordering constraint the other vendor branches have for their
// own agents — only the vendor changed.
//
// dotenv runs here rather than in server.js because Sentry.init reads
// SENTRY_DSN at module load, which happens before server.js's own dotenv call.
require('dotenv').config();

const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;
const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';

// With no DSN, Sentry.init is a no-op that leaves the SDK's APIs safely callable
// — the app runs undisturbed and every capture/span call becomes a cheap noop.
// Same graceful-degradation contract as launchdarkly.js without LD_SDK_KEY.
Sentry.init({
  dsn,
  environment,
  release: process.env.SENTRY_RELEASE || undefined,

  // Full trace sampling: this is a demo app whose entire purpose is showing
  // traces. Real apps should lower this well below 1.0 in production.
  tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '1.0'),

  // Feature flag context on errors. Boolean-only by design in the SDK, so
  // launchdarkly.js additionally mirrors every flag (including strings, arrays
  // and numbers) onto the event context — see reportFlagToSentry() there.
  integrations: [Sentry.featureFlagsIntegration()],

  // Send structured request bodies/headers with events. Safe here because the
  // app has no real PII; drop this on anything handling live customer data.
  sendDefaultPii: true,

  // Logs and metrics. Both default to true in SDK v10, but they are stated
  // explicitly here because the default has moved across versions (they used to
  // live under `_experiments`) and because "is logging on?" should be answerable
  // by reading this file rather than the SDK changelog.
  //
  // Enabling them does nothing on its own — something has to emit. logger.js
  // forwards every Winston line as a structured log, and src/metrics.js is the
  // emitter for counters/distributions.
  enableLogs: true,
  enableMetrics: true,

  // dest-013 (Atlantis) 404s and the checkout-v2 500s are both deliberate demo
  // errors, so they are NOT filtered out — they are the signal, not noise.
});

if (dsn) {
  // eslint-disable-next-line no-console
  console.log(`[Sentry] Initialized — environment=${environment}`);
} else {
  // eslint-disable-next-line no-console
  console.warn('[Sentry] SENTRY_DSN not set — Sentry disabled, app running normally');
}

module.exports = Sentry;
