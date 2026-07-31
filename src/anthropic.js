'use strict';

/**
 * Thin wrapper around the Anthropic (Claude) Messages API.
 *
 * Mirrors src/gemini.js — same chat(messages, opts) signature and the same
 * normalized return shape — so the route can call either provider identically.
 * The model + generation parameters are supplied per-call (they come from the
 * LaunchDarkly AI Config). Auth is a simple API key (ANTHROPIC_API_KEY).
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Send a conversation to Claude and get back the assistant's text reply.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {Object} [opts]
 * @param {string} [opts.system]      Optional system prompt (AI Config instructions).
 * @param {number} [opts.maxTokens]   Default 2048 (Anthropic requires max_tokens).
 * @param {number} [opts.temperature] Default 0.7.
 * @param {number} [opts.topP]        Optional nucleus-sampling value.
 * @param {number} [opts.topK]        Optional top-k value.
 * @param {string} [opts.model]       Override the default model.
 * @returns {Promise<{ text: string, usage: object, stopReason: string }>}
 */
async function chat(messages, opts = {}) {
  const params = {
    model: opts.model || MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    // Only send sampling params when provided — newer models reject some of them.
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.topP != null ? { top_p: opts.topP } : {}),
    ...(opts.topK != null ? { top_k: opts.topK } : {}),
    // Anthropic takes the system prompt as a top-level field, not a message.
    ...(opts.system ? { system: opts.system } : {}),
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  };

  // Newer Claude models reject some sampling params (e.g. temperature is
  // deprecated on the Claude 5 family). If the API flags a param as
  // deprecated/unsupported, drop it and retry so LD can serve any model.
  let response, lastErr;
  for (let attempt = 0; attempt < 5 && !response; attempt++) {
    try {
      response = await client.messages.create(params);
    } catch (err) {
      lastErr = err;
      const bad = /`?([a-z_]+)`? is (?:deprecated|not supported|unsupported)/i.exec(err?.message || '')?.[1];
      if (err?.status === 400 && bad && bad in params) {
        delete params[bad];
        continue;
      }
      throw err;
    }
  }
  if (!response) throw lastErr;

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const u = response.usage || {};

  return {
    // Normalized to match gemini.js so the route/logging are provider-agnostic.
    text,
    usage: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
    stopReason: response.stop_reason,
  };
}

module.exports = { chat, MODEL };
