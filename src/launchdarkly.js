'use strict';

// Must be required before express in server.js for Observability auto-instrumentation
const { Observability } = require('@launchdarkly/observability-node');
const LaunchDarkly = require('@launchdarkly/node-server-sdk');
const logger = require('./logger');

// Initialize client synchronously on module load so the Observability plugin
// patches Node.js HTTP internals before Express is required
const sdkKey = process.env.LD_SDK_KEY;
let client = sdkKey
  ? LaunchDarkly.init(sdkKey, {
      plugins: [new Observability({ serviceName: 'toggle-travel' })],
    })
  : null;

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

function getClientSideId() {
  return process.env.LD_CLIENT_SIDE_ID || null;
}

module.exports = { init, getFlag, getClientSideId };
