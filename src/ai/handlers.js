'use strict';

/**
 * Provider handlers for the LaunchDarkly AI SDK (`@launchdarkly/ai-server`).
 *
 * The SDK selects a handler by the AI Config's `provider.name` plus its mode
 * (`messages` for completion and judge configs, `agent` for agent configs).
 * This module registers one `messages` handler per provider this app can talk
 * to — Anthropic, Gemini, OpenAI — each wrapping the matching `chat()` in
 * src/anthropic.js / gemini.js / openai.js so the provider-specific
 * self-healing (dropping sampling params a model rejects, swapping token
 * parameter names) is kept. The agent handler lives in src/aiGraph.js.
 *
 * Everything is registered once on the SDK's `globalRegistry`, so a judge
 * config resolved from a messages-mode variation finds an exact handler
 * instead of falling back to the agent handler, and `config()` / `resolveGraph`
 * see the same set.
 *
 * Each handler also opens an OTel `ld.ai.generation` span carrying the SDK's
 * LaunchDarkly attributes (config key, variation, run id, `feature_flag` event)
 * and the gen_ai usage attributes — that is what lets LD Observability traces
 * correlate with the AI Config Monitoring tab. The SDK's own handler packages
 * do this internally; a custom handler has to do it itself.
 */

const Mustache = require('mustache');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { chat: claudeChat, chatStream: claudeStream } = require('../anthropic');
const { chat: geminiChat } = require('../gemini');
const { chat: openaiChat } = require('../openai');
const { loadSdk, loadAgentHandler } = require('../aiGraph');
const logger = require('../logger');

const tracer = trace.getTracer('toggle-travel');

// Claude's 4.6+ generation removed the sampling parameters: sending
// `temperature`, `topP`, or `topK` to Opus 5 or Sonnet 5 returns a hard 400
// ("`temperature` is deprecated for this model"), while Haiku 4.5 still accepts
// them. LD serves one parameter set per variation, so strip the sampling knobs
// for models that reject them rather than making every variation's author
// remember which generation they are on. (The wrappers also self-heal on the
// 400; this just avoids paying for the failed round-trip.)
function rejectsSamplingParams(model) {
  return /claude-(?:opus|sonnet|fable|mythos)-(?:5|4-[678])/.test(String(model || ''));
}

function sanitizeParameters(model, parameters = {}) {
  if (!rejectsSamplingParams(model)) return parameters;
  const { temperature, topP, top_p: topPSnake, topK, top_k: topKSnake, ...rest } = parameters;
  return rest;
}

// Prompts authored in LaunchDarkly are Mustache: {{user_name}}, dotted paths,
// and sections like {{#signed_in}}…{{/signed_in}}. HTML escaping off — these
// are prompts, not web pages.
function render(template, variables) {
  if (typeof template !== 'string' || !template) return template || '';
  try {
    return Mustache.render(template, variables || {}, {}, { escape: (v) => String(v) });
  } catch (err) {
    logger.warn('ai_prompt_render_failed', { error: err.message });
    return template;
  }
}

// LD names the token budget differently per provider family.
function maxTokensOf(params) {
  const v = params.max_tokens ?? params.maxTokens ?? params.maxOutputTokens;
  return Number.isFinite(Number(v)) ? Number(v) : undefined;
}

/**
 * Turn an LD completion/judge config plus the SDK's call arguments into the
 * `chat(messages, opts)` call the provider wrapper expects.
 *
 * Message assembly: the config's system entries become the system prompt;
 * its user/assistant entries are preset turns (few-shot, or a judge's filled
 * template); then the conversation `history`; then `userInput` as the final
 * user turn — unless a rendered preset already embeds that exact text, which
 * is how judge templates work (the response under evaluation is both the
 * template's {{response_to_evaluate}} and the SDK's userInput), so it is not
 * sent twice.
 */
function buildCall(cfg, userInput, variables, history) {
  const model = String(cfg.model?.name || '').replace(/^.*\//, '');
  const params = sanitizeParameters(model, cfg.model?.parameters || {});
  const rendered = (cfg.messages || []).map((m) => ({ role: m.role, content: render(m.content, variables) }));
  const system = rendered.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    || (cfg.instructions ? render(cfg.instructions, variables) : '');
  const preset = rendered.filter((m) => m.role === 'user' || m.role === 'assistant');
  const priorTurns = Array.isArray(history)
    ? history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];

  const input = typeof userInput === 'string' ? userInput : (userInput == null ? '' : JSON.stringify(userInput));
  const alreadyEmbedded = input && preset.some((m) => m.content.includes(input));
  const messages = [...preset, ...priorTurns];
  if (input && !alreadyEmbedded) messages.push({ role: 'user', content: input });
  if (!messages.length) messages.push({ role: 'user', content: input || ' ' });

  return {
    model,
    messages,
    opts: {
      system: system || undefined,
      model,
      maxTokens: maxTokensOf(params) ?? 2048,
      temperature: params.temperature,
      topP: params.topP ?? params.top_p,
      topK: params.topK ?? params.top_k,
      signal: variables?.__signal instanceof AbortSignal ? variables.__signal : undefined,
    },
  };
}

// Usage in the shape the SDK's parseUsage() understands. Anthropic's cache
// buckets are passed through raw (parseUsage folds them into input once).
function toSdkUsage(usage = {}) {
  return {
    input_tokens: Number(usage.inputTokens || 0),
    output_tokens: Number(usage.outputTokens || 0),
    ...(usage.cacheReadInputTokens ? { cache_read_input_tokens: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheCreationInputTokens ? { cache_creation_input_tokens: usage.cacheCreationInputTokens } : {}),
  };
}

function usageForSpan(usage = {}) {
  const cacheRead = Number(usage.cacheReadInputTokens || 0);
  const cacheCreation = Number(usage.cacheCreationInputTokens || 0);
  return {
    input: Number(usage.inputTokens || 0) + cacheRead + cacheCreation,
    output: Number(usage.outputTokens || 0),
    cacheRead,
    cacheCreation,
  };
}

function startSpan(sdk, providerName, model, variables) {
  const span = tracer.startSpan('ld.ai.generation');
  try {
    sdk.setLdSpanAttributes(span, variables);
    sdk.setModelIdentityAttributes(span, providerName, model);
    span.setAttribute('gen_ai.operation.name', 'chat');
  } catch (err) {
    logger.debug('ai_span_attrs_failed', { error: err.message });
  }
  return span;
}

function endSpan(sdk, span, { usage, error, model }) {
  try {
    if (usage) sdk.setUsageSpanAttributes(span, usageForSpan(usage));
    if (model) span.setAttribute('gen_ai.response.model', model);
    if (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
  } finally {
    span.end();
  }
}

/**
 * A `messages` handler for one provider. `chatFn` is the blocking wrapper;
 * `streamFn` (optional) is its async-generator twin — when present the SDK's
 * `.stream()` path yields real token chunks and records time-to-first-token.
 */
function createMessagesHandler(sdk, providerName, chatFn, streamFn) {
  const blocking = async (cfg, userInput = '', _toolHandlers = {}, variables = {}, history) => {
    const { model, messages, opts } = buildCall(cfg, userInput, variables, history);
    const span = startSpan(sdk, providerName, model, variables);
    try {
      const result = await chatFn(messages, opts);
      endSpan(sdk, span, { usage: result.usage, model });
      return { output: result.text || '', usage: toSdkUsage(result.usage) };
    } catch (err) {
      endSpan(sdk, span, { error: err, model });
      throw err;
    }
  };

  const streaming = streamFn
    ? async function* stream(cfg, userInput = '', _toolHandlers = {}, variables = {}, history) {
      const { model, messages, opts } = buildCall(cfg, userInput, variables, history);
      const span = startSpan(sdk, providerName, model, variables);
      try {
        for await (const ev of streamFn(messages, opts)) {
          if (ev.type === 'chunk') yield { type: 'chunk', text: ev.text };
          else if (ev.type === 'done') {
            endSpan(sdk, span, { usage: ev.usage, model });
            yield { type: 'done', output: ev.text || '', usage: toSdkUsage(ev.usage) };
          }
        }
      } catch (err) {
        endSpan(sdk, span, { error: err, model });
        throw err;
      }
    }
    : undefined;

  return sdk.createHandler([providerName, 'messages'], blocking, streaming);
}

let handlersPromise = null;

/**
 * All provider handlers this process serves, registered once on the SDK's
 * global registry: the agent handler (wildcard provider, agent mode) plus a
 * messages handler for Anthropic, Gemini and OpenAI. Returns the array too,
 * for callers that pass handlers explicitly (resolveGraph).
 */
function getHandlers() {
  if (!handlersPromise) {
    handlersPromise = (async () => {
      const sdk = await loadSdk();
      const agent = await loadAgentHandler();
      const handlers = [
        agent,
        createMessagesHandler(sdk, 'Anthropic', claudeChat, claudeStream),
        createMessagesHandler(sdk, 'Gemini', geminiChat),
        createMessagesHandler(sdk, 'Google', geminiChat),
        createMessagesHandler(sdk, 'OpenAI', openaiChat),
      ];
      sdk.globalRegistry.register({ handlers });
      logger.info('ai_handlers_registered', { handlers: handlers.map((h) => h.providesFor.join(':')) });
      return handlers;
    })().catch((err) => {
      handlersPromise = null;
      throw err;
    });
  }
  return handlersPromise;
}

module.exports = { getHandlers, sanitizeParameters, render, buildCall, rejectsSamplingParams };
