'use strict';

const express = require('express');
const router = express.Router();
const { chat } = require('../gemini');
const { getFlag, getCompletionConfig } = require('../launchdarkly');
const logger = require('../logger');

// The LaunchDarkly AI Config (agent config) that drives this planner.
const AI_CONFIG_KEY = 'ai-planner';

// Fallback used only if LD is unreachable or the config is missing. The model,
// parameters, and instructions normally come from the AI Config in LD.
const SYSTEM_PROMPT = `You are the AI Travel Planner for Toggle Travel, a friendly travel booking site.
Help the user plan trips: suggest destinations, talk through dates and budget, and answer travel questions.
Keep replies concise and conversational. Plain text — no markdown headings or long bullet lists.`;

const DEFAULT_COMPLETION_CONFIG = {
  enabled: true,
  model: {
    name: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    parameters: { temperature: 0.7, maxTokens: 2048 },
  },
  messages: [{ role: 'system', content: SYSTEM_PROMPT }],
};

/**
 * Resolve the AI Config for a session into the exact values the request will
 * use — model, effective parameters, instructions (from the config's system
 * message), any preset non-system messages, and the metrics tracker. Parameters
 * are merged over sane defaults so what we display always equals what we send.
 */
async function resolvePlannerConfig(sessionId) {
  const cfg = await getCompletionConfig(AI_CONFIG_KEY, DEFAULT_COMPLETION_CONFIG, sessionId);
  const src = cfg || DEFAULT_COMPLETION_CONFIG;
  const rawModel = src.model?.name || DEFAULT_COMPLETION_CONFIG.model.name;
  const msgs = Array.isArray(src.messages) ? src.messages : [];

  // A completion config carries the prompt as messages: the system entries
  // become the system instruction; any user/assistant entries are preset
  // few-shot turns that go before the live conversation.
  const instructions = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || SYSTEM_PROMPT;
  const presetMessages = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    enabled: src.enabled !== false,
    instructions,
    presetMessages,
    // Strip any provider prefix (e.g. "google/gemini-...") for the Gemini SDK.
    model: String(rawModel).replace(/^.*\//, ''),
    // Show exactly the parameters LD serves (all of them). Only fall back to
    // defaults if the config provides none (e.g. LD unreachable).
    parameters: Object.keys(src.model?.parameters || {}).length
      ? src.model.parameters
      : { temperature: 0.7, maxOutputTokens: 2048 },
    tracker: cfg?.tracker,
  };
}

// GET /api/ai-planner/config — the model + parameters currently in effect,
// for the model banner on the page. Reflects live LD AI Config changes.
router.get('/config', async (req, res, next) => {
  try {
    const sessionId = req.sessionId || 'anonymous';
    const { enabled, model, parameters } = await resolvePlannerConfig(sessionId);
    res.json({ configKey: AI_CONFIG_KEY, enabled, model, parameters });
  } catch (err) {
    logger.warn('ai_planner_config_error', { error: err.message });
    next(err);
  }
});

// POST /api/ai-planner/chat — send a message + history, get the assistant's reply
router.post('/chat', async (req, res, next) => {
  try {
    const { message, conversationHistory } = req.body || {};

    if (typeof message !== 'string' || !message.trim()) {
      const err = new Error('Field "message" must be a non-empty string');
      err.status = 400;
      throw err;
    }

    // Backend gate: ai-planner-api controls whether the Gemini API is reachable.
    // Server-side only flag (not exposed to the browser), default false. When
    // off, refuse before spending any Gemini tokens. This is also the
    // prerequisite behind ai-planner-enabled, so the UI is hidden in lockstep.
    const sessionId = req.sessionId || 'anonymous';
    const apiEnabled = await getFlag('ai-planner-api', false, sessionId);
    if (!apiEnabled) {
      logger.info('ai_planner_api_disabled', { session_id: sessionId });
      return res.status(503).json({ error: 'The AI Planner is currently unavailable.' });
    }

    // Build the live conversation: prior turns (if any) + the new user message.
    const history = Array.isArray(conversationHistory) ? conversationHistory : [];
    const convo = [
      ...history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // Model, params, instructions, and any preset messages come from the LD AI Config.
    const { instructions, presetMessages, model, parameters, tracker } = await resolvePlannerConfig(sessionId);

    // Preset few-shot turns from the config go before the live conversation.
    const messages = [...presetMessages, ...convo];

    const callGemini = () => chat(messages, {
      system: instructions,
      model,
      // LD may name the token budget maxOutputTokens (Gemini) or maxTokens.
      maxTokens: parameters.maxOutputTokens ?? parameters.maxTokens,
      temperature: parameters.temperature,
      topP: parameters.topP,
      topK: parameters.topK,
    });

    // Record latency/tokens/success against the AI Config (LD Monitoring tab).
    let result;
    try {
      result = tracker ? await tracker.trackDurationOf(callGemini) : await callGemini();
      tracker?.trackSuccess?.();
      if (result.usage) {
        tracker?.trackTokens?.({
          total: result.usage.totalTokens,
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
        });
      }
    } catch (err) {
      tracker?.trackError?.();
      throw err;
    }

    logger.info('ai_planner_chat', {
      turns: messages.length,
      model,
      output_tokens: result.usage?.outputTokens,
      stop_reason: result.stopReason,
    });

    // meta lets the page's model banner update to exactly what was used.
    res.json({ reply: result.text, meta: { configKey: AI_CONFIG_KEY, model, parameters } });
  } catch (err) {
    logger.warn('ai_planner_chat_error', { error: err.message });
    next(err);
  }
});

module.exports = router;
