'use strict';

const LaunchDarkly = require('@launchdarkly/node-server-sdk');
const Sentry = require('@sentry/node');
const logger = require('./logger');

// No SDK plugins on this branch. The launchdarkly branch attaches the LD
// Observability plugin here; this branch's observability is Sentry, initialized
// separately in instrument.js. Flagging and observability are deliberately
// decoupled so the two vendor branches differ in exactly one dimension.
const sdkKey = process.env.LD_SDK_KEY;
const client = sdkKey ? LaunchDarkly.init(sdkKey) : null;

async function init() {
  if (!client) {
    logger.warn('ld_sdk_key_missing', { message: 'LD_SDK_KEY not set — all flags will use defaults' });
    return;
  }
  try {
    await client.waitForInitialization({ timeout: 5 });
    logger.info('ld_initialized', { message: 'LaunchDarkly server SDK ready' });
  } catch (err) {
    logger.warn('ld_init_timeout', { message: 'LaunchDarkly failed to initialize — using flag defaults', error: err.message });
  }
}

// ── Flag evaluations → Sentry ────────────────────────────────────────────────
// Two paths, because Sentry's feature-flag support is boolean-only:
//
//   1. Booleans go through the Feature Flags integration, which populates the
//      dedicated "Feature Flags" panel on a Sentry issue and drives Sentry's
//      flag-change suspect detection. This is what makes an error say "this
//      happened while new-checkout-flow was true".
//   2. EVERY flag (booleans included) is also mirrored onto a `flag.<key>` tag,
//      because Sentry drops non-boolean values on the floor otherwise. Tags are
//      indexed, so `flag.booking-flow-variant:express` is searchable in the
//      issue stream — which is the only way string/array flags show up at all.
//
// Both write to the current isolation scope, which the Express integration
// forks per request, so tags never bleed between concurrent requests.
const SENTRY_TAG_MAX = 200;

function reportFlagToSentry(key, value) {
  try {
    if (typeof value === 'boolean') {
      const flagsIntegration = Sentry.getClient()?.getIntegrationByName('FeatureFlags');
      if (flagsIntegration) flagsIntegration.addFeatureFlag(key, value);
    }

    const asTag = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    Sentry.setTag(`flag.${key}`, asTag.slice(0, SENTRY_TAG_MAX));
  } catch (err) {
    // Never let telemetry break a flag read — the flag value is the product
    // behavior, Sentry reporting is not.
    logger.debug('sentry_flag_report_failed', { flag: key, error: err.message });
  }
}

async function getFlag(key, defaultValue, sessionId = 'anonymous') {
  if (!client) {
    reportFlagToSentry(key, defaultValue);
    return defaultValue;
  }
  const context = { kind: 'user', key: sessionId };
  const value = await client.variation(key, context, defaultValue);
  reportFlagToSentry(key, value);
  return value;
}

function getClientSideId() {
  return process.env.LD_CLIENT_SIDE_ID || null;
}

// Track a custom metric event against the same context that evaluated the flag.
// Used by the guarded-rollout checkout incident: bookings.js fires
// 'booking-error' server-side so cheap API traffic feeds the rollout guard, not
// just browser sessions.
function track(eventName, sessionId = 'anonymous', data = undefined, metricValue = undefined) {
  if (!client) return;
  try {
    const context = { kind: 'user', key: sessionId };
    client.track(eventName, context, data, metricValue);
  } catch (err) {
    logger.warn('ld_track_failed', { event: eventName, error: err.message });
  }
}

// Flush buffered analytics events. Not needed for the long-running server (the
// SDK flushes on its own interval), but the load generator and any short-lived
// script must call this or their events are lost on exit.
async function flush() {
  if (!client) return;
  try {
    await client.flush();
  } catch (err) {
    logger.warn('ld_flush_failed', { error: err.message });
  }
}

module.exports = { init, getFlag, getClientSideId, track, flush, reportFlagToSentry };
