'use strict';

/**
 * AI Planner HTTP surface. Thin on purpose: validation, gates, limits and the
 * SSE/JSON envelope live here; the turns themselves live in src/ai/
 * (conversation.js) and src/agents/supervisor.js (agent mode).
 *
 *   GET  /config         model banner (conversation mode)
 *   GET  /agent-config   model banner (agent mode: the graph in effect)
 *   POST /chat           conversation turn — SSE when Accept: text/event-stream, else JSON
 *   POST /agent-chat     agent turn       — same envelope
 *   POST /feedback       thumbs up/down for a prior run
 */

const express = require('express');
const router = express.Router();
const { getFlagFor, recordFeedback } = require('../launchdarkly');
const { runAgentTurn, buildRoster } = require('../agents/supervisor');
const { GRAPH_KEY, resolveAgentGraph } = require('../aiGraph');
const { TOOL_REGISTRY } = require('../tools');
const { buildContext, buildPromptVariables, describeContext } = require('../ai/context');
const { runConversationTurn, AI_CONFIG_KEY, paramsOf } = require('../ai/conversation');
const { inspectPlanner } = require('../ai/invoke');
const { getHandlers } = require('../ai/handlers');
const { checkLimit, recordTurn } = require('../ai/limits');
const logger = require('../logger');

// ── Input caps ────────────────────────────────────────────────────────────────
// express.json() caps the body at 100 KB; these cap what reaches a model.
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 4000;

// Whole-turn ceiling for agent mode — per-specialist timeouts already exist,
// but PLAN + COMPOSE had none.
const AGENT_TURN_TIMEOUT_MS = Number(process.env.AGENT_TURN_TIMEOUT_MS || 90000);

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function readMessage(body) {
  const { message } = body || {};
  if (typeof message !== 'string' || !message.trim()) throw httpError(400, 'Field "message" must be a non-empty string');
  if (message.length > MAX_MESSAGE_CHARS) throw httpError(413, `Message is too long (max ${MAX_MESSAGE_CHARS} characters)`);
  return message;
}

// The browser holds the conversation and resends it every turn: keep the last
// N turns, and clip any single turn that is implausibly long.
function readHistory(body) {
  const history = Array.isArray(body?.conversationHistory) ? body.conversationHistory : [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.length > MAX_HISTORY_CHARS ? m.content.slice(0, MAX_HISTORY_CHARS) : m.content }));
}

// ── Response envelope: SSE or JSON ───────────────────────────────────────────

function wantsStream(req) {
  return /text\/event-stream/i.test(req.get('accept') || '');
}

// Server-sent events. `Cache-Control: no-transform` makes the compression
// middleware leave the stream alone (it would otherwise buffer it), and
// X-Accel-Buffering does the same for nginx.
function openSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
  return { send, end: () => { if (!res.writableEnded) res.end(); } };
}

// A cancelled request (the customer navigated away) aborts the model calls
// instead of leaving a 60 s fan-out running for nobody.
function abortOnClose(req, res) {
  const controller = new AbortController();
  req.on('close', () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')); });
  return controller;
}

function withTurnTimeout(promise, ms, controller, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out`));
      reject(httpError(504, `${label} took longer than ${Math.round(ms / 1000)}s and was stopped.`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Shared prologue for both chat endpoints: context, gates, limits.
async function admit(req, mode) {
  const context = buildContext(req);
  const who = describeContext(context);

  // Both gates evaluate against the full context, so LD can target them by
  // tier ("agent mode for Platinum and above") — not just by key.
  if (!(await getFlagFor('ai-planner-api', false, context))) {
    logger.info('ai_planner_api_disabled', { session_id: who.key, mode });
    throw httpError(503, 'The AI Planner is currently unavailable.');
  }
  if (mode === 'agent' && !(await getFlagFor('ai-planner-agent-enabled', false, context))) {
    logger.info('ai_planner_agent_disabled', { session_id: who.key, tier: who.tier });
    throw httpError(503, 'Agent mode is not available right now.');
  }

  const limit = await checkLimit(context, mode);
  if (!limit.allowed) {
    logger.info('ai_planner_rate_limited', { session_id: who.key, mode, used: limit.used, max: limit.max, window_min: limit.windowMin });
    throw httpError(429, `You've reached the ${mode} limit (${limit.max} per ${limit.windowMin} min). Try again in about ${limit.retryAfterSec}s.`, { retryAfterSec: limit.retryAfterSec });
  }
  return { context, who, limit };
}

// Run a turn and deliver it as SSE or JSON. `run(emit, signal)` resolves to the
// full turn (reply, meta, feedbackToken, debug).
async function deliver(req, res, next, { mode, run }) {
  const controller = abortOnClose(req, res);
  if (!wantsStream(req)) {
    try {
      const out = await run(() => {}, controller.signal);
      res.json(out);
    } catch (err) {
      if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
      next(err);
    }
    return;
  }

  const sse = openSse(res);
  try {
    const out = await run(sse.send, controller.signal);
    sse.send('done', out);
  } catch (err) {
    logger.warn(`ai_planner_${mode}_stream_error`, { error: err.message });
    sse.send('error', { error: err.message, status: err.status || 500, retryAfterSec: err.retryAfterSec || null });
  } finally {
    sse.end();
  }
}

// ── Banners ───────────────────────────────────────────────────────────────────

// GET /api/ai-planner/config — the model + parameters currently in effect,
// for the model banner on the page. Reflects live LD AI Config changes. No
// `complexity` on the context here, so this is the fallthrough (simple-path)
// variation; a complex request routes to the strong model at request time.
router.get('/config', async (req, res, next) => {
  try {
    const { enabled, config, meta } = await inspectPlanner(AI_CONFIG_KEY, buildContext(req));
    res.json({
      configKey: AI_CONFIG_KEY,
      enabled,
      model: config?.model?.name || null,
      parameters: paramsOf(config),
      variationKey: meta?.variationKey || null,
      version: meta?.version ?? null,
    });
  } catch (err) {
    logger.warn('ai_planner_config_error', { error: err.message });
    next(err);
  }
});

// GET /api/ai-planner/agent-config — the graph currently in effect, for the
// banner while the page is in Agent mode: the composer (the config that writes
// the reply) plus every specialist LD has wired to the root.
router.get('/agent-config', async (req, res, next) => {
  try {
    const context = buildContext(req);
    const def = await resolveAgentGraph(context, buildPromptVariables(context), TOOL_REGISTRY, { handlers: await getHandlers() });
    if (!def || !def.root) {
      return res.json({ mode: 'agent', configKey: GRAPH_KEY, graphKey: GRAPH_KEY, enabled: false, model: null, parameters: {}, specialists: [] });
    }
    const roster = buildRoster(def, def.root);
    const composeNode = def.getNode('ai-planner-agent-compose') || def.root;
    res.json({
      mode: 'agent',
      configKey: composeNode.key,
      variationKey: composeNode.meta?.variationKey || null,
      version: composeNode.meta?.version ?? null,
      graphKey: GRAPH_KEY,
      enabled: true,
      model: composeNode.config?.model?.name || null,
      parameters: composeNode.config?.model?.parameters || {},
      specialists: roster.map((r) => ({
        name: r.name,
        label: r.label,
        configKey: r.node.key,
        variationKey: r.node.meta?.variationKey || null,
        model: r.node.config?.model?.name || null,
        enabled: true, // a disabled node disables the whole graph, so reaching here means on
      })),
    });
  } catch (err) {
    logger.warn('ai_planner_agent_config_error', { error: err.message });
    next(err);
  }
});

// ── Feedback ──────────────────────────────────────────────────────────────────

// POST /api/ai-planner/feedback — thumbs up/down against a prior run.
// Body: { token: <feedbackToken from the turn>, kind: 'up' | 'down' }
router.post('/feedback', (req, res, next) => {
  try {
    const { token, kind } = req.body || {};
    if (typeof token !== 'string' || !token) throw httpError(400, 'Field "token" is required');
    const context = buildContext(req);
    const ok = recordFeedback(token, context, kind === 'down' ? 'down' : 'up');
    logger.info('ai_planner_feedback', { session_id: describeContext(context).key, kind: kind === 'down' ? 'down' : 'up', recorded: ok });
    res.json({ ok });
  } catch (err) {
    logger.warn('ai_planner_feedback_error', { error: err.message });
    next(err);
  }
});

// ── Turns ─────────────────────────────────────────────────────────────────────

// POST /api/ai-planner/chat — conversation mode: message + history in, the
// assistant's reply out (streamed as SSE when the client asks for it).
router.post('/chat', async (req, res, next) => {
  let message;
  let history;
  let admitted;
  try {
    message = readMessage(req.body);
    history = readHistory(req.body);
    admitted = await admit(req, 'conversation');
  } catch (err) {
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    return next(err);
  }
  const { context } = admitted;
  recordTurn(context, 'conversation');

  await deliver(req, res, next, {
    mode: 'chat',
    run: (emit, signal) => runConversationTurn({
      message, history, context, variables: buildPromptVariables(context), emit, signal,
    }),
  });
});

// POST /api/ai-planner/agent-chat — the multi-agent path behind the page's
// "Agent" toggle. Same request shape as /chat so the browser switches modes by
// changing the URL and nothing else. Costs roughly 30x a conversation turn,
// so it sits behind its own flag and a tighter limit.
router.post('/agent-chat', async (req, res, next) => {
  let message;
  let admitted;
  try {
    message = readMessage(req.body);
    admitted = await admit(req, 'agent');
  } catch (err) {
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    return next(err);
  }
  const { context } = admitted;
  recordTurn(context, 'agent');

  await deliver(req, res, next, {
    mode: 'agent_chat',
    run: async (emit, signal) => {
      // Same classifier as conversation mode, and the same purpose: the
      // verdict is stamped on the context so the supervisor config's LD rule
      // picks Sonnet 5 for simple requests and Opus 5 for complex ones.
      const { classifyMessage } = require('../ai/classifier');
      const { withComplexity } = require('../ai/context');
      const variables = buildPromptVariables(context);
      const { complexity, debug: classifierDebug } = await classifyMessage(message, context, variables);
      withComplexity(context, complexity);
      emit('routing', { context: describeContext(context), classifier: classifierDebug, promptVariables: variables });

      const controller = new AbortController();
      if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      const out = await withTurnTimeout(
        runAgentTurn({ message, context, variables, onEvent: emit, signal: controller.signal }),
        AGENT_TURN_TIMEOUT_MS,
        controller,
        'Agent turn',
      );
      return {
        reply: out.reply,
        meta: out.meta,
        feedbackToken: out.feedbackToken,
        debug: { ...out.debug, classifier: classifierDebug },
      };
    },
  });
});

module.exports = router;
