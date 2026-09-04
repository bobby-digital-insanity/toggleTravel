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
      // `name` is PII (the signed-in user's display name / email). Private
      // attributes are still evaluated on for targeting but are redacted from
      // the events sent to LaunchDarkly, so they never appear in the Contexts
      // list or in event exports.
      privateAttributes: ['name'],
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
    // Hand the same client to the AI SDK (AgentControl), which drives both
    // planner modes. Sharing the client keeps this process on one flag stream.
    await require('./aiGraph').initGraphSdk(client);
  } catch (err) {
    logger.warn('ld_init_timeout', { message: 'LaunchDarkly failed to initialize — using flag defaults', error: err.message });
  }
}

async function getFlag(key, defaultValue, sessionId = 'anonymous') {
  if (!client) return defaultValue;
  const context = { kind: 'user', key: sessionId };
  return client.variation(key, context, defaultValue);
}

// Same as getFlag, but evaluated against a FULL context (e.g. the AI Planner's
// multi-context with name, tier, complexity and session). The key-only
// getFlag() above drops every attribute, which makes tier-based rules on flags
// like ai-planner-agent-enabled or ai-planner-judge-threshold impossible.
async function getFlagFor(key, defaultValue, context) {
  if (!client) return defaultValue;
  if (!context) return getFlag(key, defaultValue);
  return client.variation(key, context, defaultValue);
}

// Deferred thumbs up/down for an AI run. The browser sends back the run's
// trackData (base64url-encoded — see ai/invoke.js feedbackTokenFor) and we emit
// the same feedback event the AI SDK would, attributed to that run and
// variation. Works across PM2 workers: nothing is held in memory between
// requests. One shape serves both planner modes.
function recordFeedback(token, context, kind = 'up') {
  if (!client || !token) return false;
  try {
    const trackData = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!trackData?.runId || !trackData?.configKey) return false;
    const event = kind === 'down' ? '$ld:ai:feedback:user:negative' : '$ld:ai:feedback:user:positive';
    client.track(event, context, trackData, 1);
    return true;
  } catch (err) {
    logger.warn('ai_planner_feedback_failed', { error: err.message });
    return false;
  }
}

// Raw client, for the paths that talk to LaunchDarkly directly: the AI SDK's
// initClient(), the graph-level $ld:ai:graph:* events in aiGraph.js, and the
// streaming executor in ai/invoke.js.
function getRawClient() {
  return client;
}

// Record a judge's score against the ANSWERING config's run, not the judge's.
// This is the event LD's Monitoring tab reads for `$ld:ai:judge:*` — the same
// shape the AI SDK's runJudges() emits: the evaluation metric key from the
// judge config, the answer's trackData plus `judgeConfigKey`, and the score as
// the metric value.
function trackJudgeScore(metricKey, context, trackData, judgeConfigKey, score) {
  if (!client || !metricKey || !trackData || typeof score !== 'number') return false;
  try {
    client.track(metricKey, context, { ...trackData, judgeConfigKey }, score);
    return true;
  } catch (err) {
    logger.warn('ld_track_judge_failed', { metric: metricKey, error: err.message });
    return false;
  }
}

// Variation metadata for a graph flag (variationKey + version), which the
// graph-level events need. The AI SDK keeps this internal to its own router,
// so read it off the raw flag value.
async function getGraphMeta(key, context) {
  if (!client) return {};
  const value = await client.variation(key, context, {});
  return value?._ldMeta || {};
}

function getClientSideId() {
  return process.env.LD_CLIENT_SIDE_ID || null;
}

function track(eventName, sessionId = 'anonymous', data = undefined, metricValue = undefined) {
  if (!client) return;
  const context = { kind: 'user', key: sessionId };
  trackFor(eventName, context, data, metricValue);
}

// Custom event against a FULL context, so LD metrics built on it can be
// broken down (or experimented on) by the context's attributes — tier, for
// one. `metricValue` is the number a numeric metric reads; put it here, not in
// `data`, or the metric charts nothing.
function trackFor(eventName, context, data = undefined, metricValue = undefined) {
  if (!client || !context) return;
  try {
    client.track(eventName, context, data, metricValue);
  } catch (err) {
    logger.warn('ld_track_failed', { event: eventName, error: err.message });
  }
}

module.exports = { init, getFlag, getFlagFor, getClientSideId, track, trackFor, trackJudgeScore, recordFeedback, getRawClient, getGraphMeta };
