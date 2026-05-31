'use strict';

const express = require('express');
const router = express.Router();
const { getFlag, track } = require('../launchdarkly');
const { runAIPlannerAgents } = require('../services/aiPlannerService');
const logger = require('../logger');

router.post('/chat', async (req, res, next) => {
  try {
    const { message, conversationHistory, sessionId } = req.body || {};

    if (typeof message !== 'string' || !message.trim()) {
      const err = new Error('Field "message" must be a non-empty string');
      err.status = 400;
      throw err;
    }

    const session = typeof sessionId === 'string' && sessionId ? sessionId : 'anonymous';
    const history = Array.isArray(conversationHistory) ? conversationHistory : [];

    // LD gate — if AI Planner is disabled, return 503
    const enabled = await getFlag('ai-planner-enabled', true, session);
    if (!enabled) {
      logger.info('ai_planner_blocked_by_flag', { session_id: session });
      return res.status(503).json({ error: 'AI Planner is currently unavailable.' });
    }

    // LD AI Config — resolves the explainer model (the hook for LD AgentControl model swaps).
    // The AI SDK isn't in this branch's deps, so we read a string flag with the model name.
    const explainerModel = await getFlag('ai-planner-config', process.env.CLAUDE_MODEL || 'claude-opus-4-5', session);

    const result = await runAIPlannerAgents(message, history, {
      explainerModel,
      sessionId: session,
    });

    // Track a custom LD metric event for each successful pipeline run
    track('ai-planner-conversation-turn', session, {
      agent_used: result.agentUsed,
      done: result.done,
      explainer_model: explainerModel,
    });

    res.json(result);
  } catch (err) {
    logger.warn('ai_planner_chat_error', { error: err.message });
    next(err);
  }
});

module.exports = router;
