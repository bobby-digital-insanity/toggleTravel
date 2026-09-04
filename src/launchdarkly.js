'use strict';

// Must be required before express in server.js for Observability auto-instrumentation
const { Observability } = require('@launchdarkly/observability-node');
const LaunchDarkly = require('@launchdarkly/node-server-sdk');
const { initAi, LDFeedbackKind, RunnerFactory, ManagedAgent } = require('@launchdarkly/server-sdk-ai');
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
// `context` is a full LD context (e.g. { kind:'user', key, name, tier }) so the
// AI Config can target/bucket on the signed-in identity — not just a session id.
async function getCompletionConfig(key, defaultConfig, context, variables = {}) {
  if (!aiClient) return null; // graceful degrade — route falls back to local defaults
  return aiClient.completionConfig(key, context, defaultConfig, variables);
}

// AI Config (judge mode). Same pattern as completion configs — the judge's
// model + evaluation rubric live in LD. `variables` fills Mustache placeholders
// in the rubric (e.g. {{message}}, {{response}}).
async function getJudgeConfig(key, defaultConfig, context, variables = {}) {
  if (!aiClient) return null;
  return aiClient.judgeConfig(key, context, defaultConfig, variables);
}

// AI Config (agent mode). Returns a ManagedAgent whose run() drives the whole
// tool-calling loop and records metrics (tokens, duration, tool calls) against
// the answering variation automatically.
//
// Note we deliberately do NOT use aiClient.createAgent(): that convenience
// method calls RunnerFactory.createAgent(config, undefined, ...) — it passes no
// tool registry, so every tool attached in LD would be skipped as "not found in
// the tool registry". Resolving the config and building the runner ourselves is
// the only way to bind our implementations to LD's tool declarations.
//
// The runner is pinned to the 'langchain' provider: it is the installed
// provider that implements createAgent, and it maps LD's provider name
// "Anthropic" onto @langchain/anthropic.
//
// `tools` is supplied by the caller rather than imported here: the tool modules
// reach services that require this file, and importing them at module load
// would form a cycle that leaves externalMockService's getFlag undefined.
async function getAgent(key, defaultConfig, context, variables = {}, tools = {}) {
  if (!aiClient) return null; // graceful degrade — caller falls back
  const config = await aiClient.agentConfig(key, context, defaultConfig, variables);
  if (!config?.enabled) {
    logger.info('ai_agent_disabled', { config_key: key });
    return null;
  }
  const runner = await RunnerFactory.createAgent(config, tools, logger, 'langchain');
  if (!runner) {
    logger.warn('ai_agent_runner_unavailable', { config_key: key });
    return null;
  }
  return new ManagedAgent(config, runner, logger);
}

// Resolve an agent config without building a runner — for the dev view, which
// wants to show which model/variation LD picked even when nothing runs.
async function getAgentConfig(key, defaultConfig, context, variables = {}) {
  if (!aiClient) return null;
  return aiClient.agentConfig(key, context, defaultConfig, variables);
}

// Record deferred thumbs up/down feedback. The browser sends back the tracker's
// resumptionToken (from the original /chat run); we reconstruct the tracker so
// the feedback attributes to the same run/variation — works across PM2 workers.
function recordFeedback(resumptionToken, context, kind = 'up') {
  if (!aiClient || !resumptionToken) return false;
  try {
    const tracker = aiClient.createTracker(resumptionToken, context);
    tracker.trackFeedback({ kind: kind === 'down' ? LDFeedbackKind.Negative : LDFeedbackKind.Positive });
    return true;
  } catch (err) {
    logger.warn('ai_planner_feedback_failed', { error: err.message });
    return false;
  }
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

module.exports = { init, getFlag, getClientSideId, track, getCompletionConfig, getJudgeConfig, getAgent, getAgentConfig, recordFeedback };
