'use strict';

// Must be required before express in server.js for Observability auto-instrumentation
const { Observability } = require('@launchdarkly/observability-node');
const LaunchDarkly = require('@launchdarkly/node-server-sdk');
const { initAi } = require('@launchdarkly/server-sdk-ai');
const logger = require('./logger');

// Initialize client synchronously on module load so the Observability plugin
// patches Node.js HTTP internals before Express is required
const sdkKey = process.env.LD_SDK_KEY;
let client = sdkKey
  ? LaunchDarkly.init(sdkKey, {
      plugins: [new Observability({ serviceName: 'toggle-travel' })],
    })
  : null;

// AI SDK client wraps the base LD client — must come after `client` exists.
const aiClient = client ? initAi(client) : null;

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

async function getFlag(key, defaultValue, sessionId = 'anonymous') {
  if (!client) return defaultValue;
  const context = { kind: 'user', key: sessionId };
  return client.variation(key, context, defaultValue);
}
// AI Config (completion mode). The `ai-planner` config in LD is a completion
// config, so we resolve it with completionConfig — model, params, and the
// prompt messages come back already evaluated for this context.
async function getCompletionConfig(key, defaultConfig, sessionId = 'anonymous', variables = {}) {
  if (!aiClient) return null; // graceful degrade — route falls back to local defaults
  const context = { kind: 'user', key: sessionId }; // same context shape as getFlag
  return aiClient.completionConfig(key, context, defaultConfig, variables);
}

function getClientSideId() {
  return process.env.LD_CLIENT_SIDE_ID || null;
}

function track(eventName, sessionId = 'anonymous', data = undefined, metricValue = undefined) {
  if (!client) return;
  const context = { kind: 'user', key: sessionId };
  try {
    client.track(eventName, context, data, metricValue);
  } catch (err) {
    logger.warn('ld_track_failed', { event: eventName, error: err.message });
  }
}

module.exports = { init, getFlag, getClientSideId, track, getCompletionConfig };
