'use strict';

/**
 * Running an LD AI Config through the new AI SDK, three ways:
 *
 *   invokeConfig(key, …)   — one tracked call via the SDK's own `config().invoke()`
 *                            with `skipJudges` (the judges are run separately,
 *                            see judges.js, so this app controls their variables,
 *                            parallelism and attribution).
 *   streamConfig(key, …)   — token streaming. A thin executor of this repo's,
 *                            because the SDK's `config().stream()` drops the
 *                            run's trackData from its `done` event — and that
 *                            trackData is what deferred feedback and judge
 *                            scores attribute to. It emits exactly the events
 *                            the SDK's executor emits ($ld:ai:duration:total,
 *                            generation:success|error, tokens:*) plus
 *                            $ld:ai:tokens:ttf, and resolves the variation the
 *                            same way (`inspectConfig`).
 *   inspectPlanner(key, …) — read a config without invoking anything (banner).
 *
 * Every function throws a `ConfigDisabledError` (status 503) when LD serves
 * the config off or unreachable; there are no local fallback prompts any more —
 * `ai-planner-api` already 503s the route when LD is down, so a fallback model
 * would never have been reached.
 */

const crypto = require('node:crypto');
const { loadSdk } = require('../aiGraph');
const { getHandlers } = require('./handlers');
const { getRawClient } = require('../launchdarkly');
const logger = require('../logger');

class ConfigDisabledError extends Error {
  constructor(key) {
    super(`AI Config "${key}" is not enabled`);
    this.status = 503;
    this.code = 'config_disabled';
    this.configKey = key;
  }
}

function isDisabledError(err) {
  return err?.code === 'config_disabled' || /is not enabled/i.test(err?.message || '');
}

// Handler selection, same order as the SDK: exact provider+mode, then wildcard
// provider for the mode.
function selectHandler(cfg, meta, handlers) {
  const provider = cfg.provider?.name;
  const mode = meta?.mode === 'agent' ? 'agent' : 'messages';
  const exact = handlers.find((h) => h.providesFor?.[0] === provider && h.providesFor?.[1] === mode);
  if (exact) return exact;
  const wildcard = handlers.find((h) => h.providesFor?.[0] === '*' && h.providesFor?.[1] === mode);
  if (wildcard) return wildcard;
  throw new Error(`Handler for provider ${provider} with mode ${mode} not found`);
}

function tryGetEnvironmentId(client) {
  try { return client?._featureStore?.getInitMetaData?.()?.environmentId; } catch { return undefined; }
}

// The SDK's TrackData shape — what every $ld:ai:* event carries.
function buildTrackData(key, cfg, meta) {
  return {
    runId: crypto.randomUUID(),
    configKey: key,
    variationKey: meta?.variationKey ?? '',
    version: meta?.version ?? 1,
    modelName: cfg.model?.name ?? '',
    providerName: cfg.provider?.name ?? '',
    environmentId: tryGetEnvironmentId(getRawClient()),
  };
}

function track(context, event, trackData, value) {
  const client = getRawClient();
  if (!client) return;
  try { client.track(event, context, trackData, value); } catch (err) {
    logger.warn('ai_track_failed', { event, error: err.message });
  }
}

// Model + parameters + variation for a config, with no events emitted.
async function inspectPlanner(key, context) {
  const sdk = await loadSdk();
  const { enabled, config: cfg, meta } = await sdk.inspectConfig(key, context);
  return { enabled: !!enabled && !!cfg, config: cfg, meta: meta || {} };
}

/**
 * One tracked, non-streaming call. Returns the SDK's result plus the judge
 * tasks LD attached to the served variation (already sampled), for judges.js.
 */
async function invokeConfig(key, { context, input, variables = {}, history, tools }) {
  const sdk = await loadSdk();
  await getHandlers();
  const { invoke } = sdk.config({ key, registry: sdk.globalRegistry, toolHandlers: tools, skipJudges: true });
  try {
    const result = await invoke(input, context, variables, history);
    return {
      response: typeof result.response === 'string' ? result.response : JSON.stringify(result.response ?? ''),
      usage: result.usage,
      trackData: result.trackData,
      judgeTasks: result.judgeTasks || [],
    };
  } catch (err) {
    if (isDisabledError(err)) throw new ConfigDisabledError(key);
    throw err;
  }
}

/**
 * Token streaming. Yields
 *   { type: 'start', trackData, config, meta }
 *   { type: 'chunk', text }
 *   { type: 'done', response, usage, trackData, judgeTasks, durationMs, ttfMs }
 */
async function* streamConfig(key, { context, input, variables = {}, history, tools }) {
  const sdk = await loadSdk();
  const handlers = await getHandlers();
  const { enabled, config: cfg, meta } = await sdk.inspectConfig(key, context);
  if (!enabled || !cfg) throw new ConfigDisabledError(key);

  const handler = selectHandler(cfg, meta, handlers);
  const trackData = buildTrackData(key, cfg, meta);
  const mergedVariables = { ...variables, ldContext: { ...context }, __ld: trackData };
  yield { type: 'start', trackData, config: cfg, meta };

  const startedAt = Date.now();
  let ttfMs = null;
  let fullText = '';
  let rawUsage = {};
  try {
    if (handler.stream) {
      for await (const ev of handler.stream(cfg, input, tools || {}, mergedVariables, history)) {
        if (ev.type === 'chunk' && ev.text) {
          if (ttfMs === null) { ttfMs = Date.now() - startedAt; track(context, '$ld:ai:tokens:ttf', trackData, ttfMs); }
          fullText += ev.text;
          yield { type: 'chunk', text: ev.text };
        } else if (ev.type === 'done') {
          if (typeof ev.output === 'string' && ev.output) fullText = ev.output;
          rawUsage = ev.usage || {};
        }
      }
    } else {
      const result = await handler(cfg, input, tools || {}, mergedVariables, history);
      fullText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
      rawUsage = result.usage || {};
      if (fullText) yield { type: 'chunk', text: fullText };
    }
  } catch (err) {
    track(context, '$ld:ai:duration:total', trackData, Date.now() - startedAt);
    track(context, '$ld:ai:generation:error', trackData, 1);
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  track(context, '$ld:ai:duration:total', trackData, durationMs);
  track(context, '$ld:ai:generation:success', trackData, 1);
  // Same fold as the SDK's parseUsage (not exported): Anthropic's cache
  // buckets sit beside input_tokens and are added into input exactly once.
  const usage = parseUsageFallback(rawUsage);
  if (usage.total > 0) track(context, '$ld:ai:tokens:total', trackData, usage.total);
  if (usage.input > 0) track(context, '$ld:ai:tokens:input', trackData, usage.input);
  if (usage.output > 0) track(context, '$ld:ai:tokens:output', trackData, usage.output);

  // Which judges LD attached to THIS variation, already sampled.
  const judgeTasks = await sdk.buildJudgeTasks({
    config: cfg, userContext: context, handler, handlers, llmResponse: fullText, baseTrackData: trackData,
  });

  yield { type: 'done', response: fullText, usage, trackData, judgeTasks, durationMs, ttfMs };
}

function parseUsageFallback(u = {}) {
  const input = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
  const output = Number(u.output_tokens || 0);
  return { input, output, total: input + output };
}

// Base64url of the run's trackData — the browser hands it back with a thumbs
// up/down so feedback attributes to this exact run, across PM2 workers.
function feedbackTokenFor(trackData) {
  return trackData ? Buffer.from(JSON.stringify(trackData)).toString('base64url') : null;
}

module.exports = { invokeConfig, streamConfig, inspectPlanner, feedbackTokenFor, ConfigDisabledError, isDisabledError, track };
