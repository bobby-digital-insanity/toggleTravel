'use strict';

/**
 * Thin wrapper around the Google Gemini API (Google GenAI SDK).
 *
 * The model and generation parameters are supplied per-call by the caller
 * (they come from the LaunchDarkly AI Config in routes/aiPlanner.js). Auth is a
 * simple API key (GEMINI_API_KEY), self-served from https://aistudio.google.com/apikey.
 */

const { GoogleGenAI } = require('@google/genai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Send a conversation to Gemini and get back the assistant's text reply.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {Object} [opts]
 * @param {string} [opts.system]      Optional system prompt (AI Config instructions).
 * @param {number} [opts.maxTokens]   Default 2048.
 * @param {number} [opts.temperature] Default 0.7.
 * @param {number} [opts.topP]        Optional nucleus-sampling value.
 * @param {number} [opts.topK]        Optional top-k value.
 * @param {string} [opts.model]       Override the default model.
 * @returns {Promise<{ text: string, usage: object, stopReason: string }>}
 */
async function chat(messages, opts = {}) {
  // Gemini uses role 'model' for the assistant and nests text under parts[].
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const response = await ai.models.generateContent({
    model: opts.model || MODEL,
    contents,
    config: {
      ...(opts.system ? { systemInstruction: opts.system } : {}),
      // Gemini Flash is a "thinking" model — it spends output tokens on internal
      // reasoning before replying. The budget must cover thinking + the answer,
      // or it hits MAX_TOKENS and returns empty text. Keep this generous.
      maxOutputTokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      ...(opts.topP != null ? { topP: opts.topP } : {}),
      ...(opts.topK != null ? { topK: opts.topK } : {}),
    },
  });

  const um = response.usageMetadata || {};
  return {
    text: response.text ?? '',
    usage: {
      inputTokens: um.promptTokenCount,
      outputTokens: um.candidatesTokenCount,
      totalTokens: um.totalTokenCount,
    },
    stopReason: response.candidates?.[0]?.finishReason,
  };
}

module.exports = { chat, MODEL };
