'use strict';

const LaunchDarkly = require('@launchdarkly/node-server-sdk');
const logger = require('./logger');

let client = null;

async function init() {
  const sdkKey = process.env.LD_SDK_KEY;
  if (!sdkKey) {
    logger.warn('ld_sdk_key_missing', { message: 'LD_SDK_KEY not set — all flags will use defaults' });
    return;
  }

  client = LaunchDarkly.init(sdkKey);

  try {
    await client.waitForInitialization({ timeout: 5 });
    logger.info('ld_initialized', { message: 'LaunchDarkly server SDK ready' });
  } catch (err) {
    logger.warn('ld_init_timeout', { message: 'LaunchDarkly failed to initialize — using flag defaults', error: err.message });
  }
}

// Evaluate a flag for a given session context.
// Falls back to defaultValue if LD is unavailable.
async function getFlag(key, defaultValue, sessionId = 'anonymous') {
  if (!client) return defaultValue;
  const context = { kind: 'user', key: sessionId };
  return client.variation(key, context, defaultValue);
}

function getClientSideId() {
  return process.env.LD_CLIENT_SIDE_ID || null;
}

module.exports = { init, getFlag, getClientSideId };
