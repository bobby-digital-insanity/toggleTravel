'use strict';

/**
 * Thin wrapper around the OpenAI API (Chat Completions).
 *
 * Same chat() signature as src/gemini.js and src/anthropic.js, so the router in
 * routes/aiPlanner.js can dispatch to it transparently. Used as the independent
 * (non-Claude) JUDGE for the AI Planner. Auth: OPENAI_API_KEY.
 */

const OpenAI = require('openai');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} messages
 * @param {Object} [opts] system, model, maxTokens, temperature, topP
 * @returns {Promise<{ text: string, usage: object, stopReason: string }>}
 */
async function chat(messages, opts = {}) {
  const msgs = [];
  if (opts.system) msgs.push({ role: 'system', content: opts.system });
  for (const m of messages) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  const params = {
    model: opts.model || MODEL,
    messages: msgs,
    // Current param name; newer models require it. We swap to max_tokens on retry
    // if a model rejects it, and vice-versa.
    max_completion_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.temperature != null) params.temperature = opts.temperature;
  if (opts.topP != null) params.top_p = opts.topP;

  // Resilient to per-model param quirks: some models reject temperature/top_p,
  // or want max_tokens instead of max_completion_tokens. Drop/swap and retry.
  let response, lastErr;
  for (let attempt = 0; attempt < 5 && !response; attempt++) {
    try {
      response = await client.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      const msg = err?.message || '';
      if (err?.status === 400) {
        if (/temperature/i.test(msg) && 'temperature' in params) { delete params.temperature; continue; }
        if (/top_p/i.test(msg) && 'top_p' in params) { delete params.top_p; continue; }
        if (/max_completion_tokens/i.test(msg) && 'max_completion_tokens' in params) {
          params.max_tokens = params.max_completion_tokens;
          delete params.max_completion_tokens;
          continue;
        }
        if (/max_tokens/i.test(msg) && 'max_tokens' in params) {
          params.max_completion_tokens = params.max_tokens;
          delete params.max_tokens;
          continue;
        }
      }
      throw err;
    }
  }
  if (!response) throw lastErr;

  const choice = response.choices?.[0];
  const u = response.usage || {};
  return {
    text: choice?.message?.content || '',
    usage: {
      inputTokens: u.prompt_tokens,
      outputTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
    },
    stopReason: choice?.finish_reason || null,
  };
}

module.exports = { chat, MODEL };
