'use strict';

/**
 * Thin wrapper around the Anthropic (Claude) Messages API.
 *
 * Mirrors src/gemini.js and src/openai.js — same chat(messages, opts) signature
 * and the same normalized return shape — so the LD AI SDK provider handlers in
 * src/ai/handlers.js can wrap any of the three identically. The model and
 * generation parameters are supplied per-call (they come from the LaunchDarkly
 * AI Config). Auth is a simple API key (ANTHROPIC_API_KEY).
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
// maxRetries: the SDK retries 408/409/429/5xx (and 529 overloaded) with
// exponential backoff + jitter. Explicit so the policy is visible here.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });

// Anthropic reports cache reads/writes BESIDE input_tokens, so the raw fields
// are kept (the LD AI SDK's parseUsage folds them into input exactly once).
function normalizeUsage(u = {}) {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    cacheReadInputTokens: u.cache_read_input_tokens || 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
  };
}

function buildParams(messages, opts) {
  // The system prompt is identical across turns of a conversation and across
  // every judge/classifier call, so mark it cacheable. Below the model's
  // minimum cacheable size this is a no-op; above it, input cost drops.
  const system = opts.system
    ? (opts.cache === false
      ? opts.system
      : [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }])
    : undefined;
  return {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    // Only send sampling params when provided — newer models reject some of them.
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.topP != null ? { top_p: opts.topP } : {}),
    ...(opts.topK != null ? { top_k: opts.topK } : {}),
    // Anthropic takes the system prompt as a top-level field, not a message.
    ...(system ? { system } : {}),
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  };
}

// Newer Claude models reject some sampling params (e.g. temperature is
// deprecated on the Claude 5 family). If the API flags a param as
// deprecated/unsupported, drop it and retry so LD can serve any model.
function droppableParam(err, params) {
  const bad = /`?([a-z_]+)`? is (?:deprecated|not supported|unsupported)/i.exec(err?.message || '')?.[1];
  return err?.status === 400 && bad && bad in params ? bad : null;
}

/**
 * Send a conversation to Claude and get back the assistant's text reply.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {Object} [opts]
 * @param {string} [opts.system]      Optional system prompt (AI Config instructions).
 * @param {number} [opts.maxTokens]   Default 2048 (Anthropic requires max_tokens).
 * @param {number} [opts.temperature] Optional.
 * @param {number} [opts.topP]        Optional nucleus-sampling value.
 * @param {number} [opts.topK]        Optional top-k value.
 * @param {string} [opts.model]       Override the default model.
 * @param {AbortSignal} [opts.signal] Cancels the request (client navigated away).
 * @param {boolean} [opts.cache]      false to skip the cache_control marker.
 * @returns {Promise<{ text: string, usage: object, stopReason: string }>}
 */
async function chat(messages, opts = {}) {
  const params = buildParams(messages, opts);
  const reqOpts = opts.signal ? { signal: opts.signal } : undefined;

  let response, lastErr;
  for (let attempt = 0; attempt < 5 && !response; attempt++) {
    try {
      response = await client.messages.create(params, reqOpts);
    } catch (err) {
      lastErr = err;
      const bad = droppableParam(err, params);
      if (bad) { delete params[bad]; continue; }
      throw err;
    }
  }
  if (!response) throw lastErr;

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return { text, usage: normalizeUsage(response.usage), stopReason: response.stop_reason };
}

/**
 * Streaming twin of chat(): an async generator that yields
 *   { type: 'chunk', text }        as text arrives, then
 *   { type: 'done', text, usage, stopReason }
 * Same params, same self-healing on rejected sampling params (a 400 arrives
 * before any token, so the retry loop is safe to run around the stream).
 */
async function* chatStream(messages, opts = {}) {
  const params = buildParams(messages, opts);
  const reqOpts = opts.signal ? { signal: opts.signal } : undefined;

  for (let attempt = 0; attempt < 5; attempt++) {
    const stream = client.messages.stream(params, reqOpts);
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'chunk', text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      const text = (final.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      yield { type: 'done', text, usage: normalizeUsage(final.usage), stopReason: final.stop_reason };
      return;
    } catch (err) {
      const bad = droppableParam(err, params);
      if (bad) { delete params[bad]; continue; }
      throw err;
    }
  }
  throw new Error('Anthropic request kept rejecting parameters');
}

module.exports = { chat, chatStream, MODEL };
