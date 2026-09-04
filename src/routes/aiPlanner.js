'use strict';

const express = require('express');
const router = express.Router();
const { chat: geminiChat } = require('../gemini');
const { chat: claudeChat } = require('../anthropic');
const { chat: openaiChat } = require('../openai');
const { getFlag, getCompletionConfig, getJudgeConfig, track, recordFeedback, recordGraphFeedback } = require('../launchdarkly');
const { runAgentTurn, buildRoster } = require('../agents/supervisor');
const { GRAPH_KEY, resolveAgentGraph } = require('../aiGraph');
const { TOOL_REGISTRY } = require('../tools');
const logger = require('../logger');

// The LaunchDarkly AI Config (completion mode) that drives this planner.
const AI_CONFIG_KEY = 'ai-planner';

// Route to the right provider SDK based on the model/provider the AI Config
// serves. Choosing a Claude model in LD sends the call to Anthropic; anything
// else defaults to Gemini. Both modules expose an identical chat() interface.
function pickChat(provider, model) {
  const hay = `${provider || ''} ${model || ''}`.toLowerCase();
  if (hay.includes('openai') || hay.includes('gpt') || /\bo[0-9]\b/.test(hay)) return openaiChat;
  if (hay.includes('anthropic') || hay.includes('claude')) return claudeChat;
  return geminiChat; // default / Gemini + Google
}

// Claude's 4.6+ generation removed the sampling parameters: sending
// `temperature`, `topP`, or `topK` to Opus 5 or Sonnet 5 returns a hard 400
// ("`temperature` is deprecated for this model"), while Haiku 4.5 still accepts
// them. LD serves one parameter set per variation, so strip the sampling knobs
// for models that reject them rather than making every variation's author
// remember which generation they are on.
function rejectsSamplingParams(model) {
  return /claude-(?:opus|sonnet|fable|mythos)-(?:5|4-[678])/.test(String(model || ''));
}

function sanitizeParameters(model, parameters = {}) {
  if (!rejectsSamplingParams(model)) return parameters;
  const { temperature, topP, top_p: topPSnake, topK, top_k: topKSnake, ...rest } = parameters;
  return rest;
}

// Build the LD evaluation context from headers the AI Planner page sends. Key,
// name, and tier mirror the browser's signed-in identity so server-side
// evaluations (the model split, tier-based targeting) match the client SDK and
// can target on tier (e.g. "Diamond users get Claude"). Falls back to the
// anonymous session id when no user is signed in.
function buildContext(req) {
  const context = { kind: 'user', key: req.get('x-user-key') || req.sessionId || 'anonymous' };
  const name = req.get('x-user-name');
  const tier = req.get('x-user-tier');
  if (name) context.name = name;
  if (tier) context.tier = tier;
  return context;
}

// Prompt variables for every AI Config resolution on this route. The LD AI SDK
// Mustache-renders these into the config's messages (completion/judge configs)
// or instructions (agent configs), so a prompt authored in LaunchDarkly can say
//
//   You are a support agent for {{product_tier}} customers.
//   Address the user as {{user_name}}.
//
// and the personalization is config, not string-building in code. Editing that
// sentence is a variation change in the LD UI — no deploy.
//
// The SDK also injects the raw evaluation context as `ldctx`, so a prompt can
// reach anything on it directly ({{ldctx.tier}}, {{ldctx.key}}) without the
// variable having to be listed here.
function buildPromptVariables(context) {
  const displayName = String(context.name || '').trim();
  const rawTier = String(context.tier || 'standard');
  return {
    // Display name — falls back to a neutral noun so the prompt never renders
    // "Address the user as ." for anonymous visitors.
    user_name: displayName || 'traveler',
    user_key: context.key,
    // Title Case for the prompt ("Diamond"); context.tier stays lowercase
    // because that is what the targeting rules in LD match on.
    product_tier: rawTier.charAt(0).toUpperCase() + rawTier.slice(1),
    tier_key: rawTier.toLowerCase(),
    // Truthy/falsy so prompts can use Mustache sections:
    // {{#signed_in}}Greet {{user_name}} by name.{{/signed_in}}
    signed_in: !!displayName,
    today: new Date().toISOString().slice(0, 10),
    // Legacy aliases — earlier variations of these prompts referenced
    // {{name}}/{{tier}}. Kept so an unedited variation keeps rendering.
    name: displayName || 'traveler',
    tier: rawTier.charAt(0).toUpperCase() + rawTier.slice(1),
  };
}

// Fallback used only if LD is unreachable or the config is missing. The model,
// parameters, and instructions normally come from the AI Config in LD.
const SYSTEM_PROMPT = `You are the AI Travel Planner for Toggle Travel, a friendly travel booking site.
Help the user plan trips: suggest destinations, talk through dates and budget, and answer travel questions.
Keep replies concise and conversational. Plain text — no markdown headings or long bullet lists.`;

// ── Complexity classifier ────────────────────────────────────────────────────
// Its model + prompt live in the LD AI Config `ai-planner-classifier`, so the
// routing "brain" is LD config, not code. The verdict is stamped onto the LD
// context as `complexity`, and the ai-planner config's TARGETING RULES in LD
// decide which model serves — the code never picks cheap vs. strong itself.
const CLASSIFIER_CONFIG_KEY = 'ai-planner-classifier';

const CLASSIFIER_FALLBACK_PROMPT = `You are a router for a travel-support chatbot. Classify the user's message as "simple" or "complex".
complex = multi-part questions, or anything involving a disruption (cancellation, refund, missed connection, rebooking, insurance claims).
simple = everything else (single factual travel questions).
Respond with exactly one word: simple or complex.`;

const DEFAULT_CLASSIFIER_CONFIG = {
  enabled: true,
  model: {
    name: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    parameters: { temperature: 0, maxOutputTokens: 1024 },
  },
  messages: [{ role: 'system', content: CLASSIFIER_FALLBACK_PROMPT }],
};

// Classify one message. Fails safe to 'simple' (the cheap path) on any error.
// Records its own metrics against the classifier config's Monitoring tab.
// Returns { complexity, debug } — debug feeds the page's developer view.
async function classifyMessage(message, context) {
  const startedAt = Date.now();
  try {
    const cfg = await getCompletionConfig(CLASSIFIER_CONFIG_KEY, DEFAULT_CLASSIFIER_CONFIG, context, buildPromptVariables(context));
    const src = cfg || DEFAULT_CLASSIFIER_CONFIG;
    if (src.enabled === false) {
      return { complexity: 'simple', debug: { configKey: CLASSIFIER_CONFIG_KEY, skipped: 'config disabled' } };
    }

    const msgs = Array.isArray(src.messages) ? src.messages : [];
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || CLASSIFIER_FALLBACK_PROMPT;
    const model = String(src.model?.name || DEFAULT_CLASSIFIER_CONFIG.model.name).replace(/^.*\//, '');
    const params = src.model?.parameters || {};
    const tracker = typeof cfg?.createTracker === 'function' ? cfg.createTracker() : null;

    const chat = pickChat(typeof src.provider === 'string' ? src.provider : src.provider?.name, model);
    const call = () => chat([{ role: 'user', content: message }], {
      system,
      model,
      // Generous default: Gemini-style thinking models spend output tokens
      // reasoning before the one-word answer.
      maxTokens: params.maxOutputTokens ?? params.maxTokens ?? params.max_tokens ?? 1024,
      ...sanitizeParameters(model, { temperature: params.temperature ?? 0 }),
    });

    let result;
    try {
      result = tracker ? await tracker.trackDurationOf(call) : await call();
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

    const complexity = (result.text || '').toLowerCase().includes('complex') ? 'complex' : 'simple';
    return {
      complexity,
      debug: {
        configKey: CLASSIFIER_CONFIG_KEY,
        model,
        verdict: complexity,
        durationMs: Date.now() - startedAt,
        tokens: result.usage || null,
      },
    };
  } catch (err) {
    logger.warn('ai_planner_classify_failed', { error: err.message });
    return {
      complexity: 'simple',
      debug: { configKey: CLASSIFIER_CONFIG_KEY, error: err.message, durationMs: Date.now() - startedAt, fellBackTo: 'simple' },
    };
  }
}

const DEFAULT_COMPLETION_CONFIG = {
  enabled: true,
  model: {
    name: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    parameters: { temperature: 0.7, maxTokens: 2048 },
  },
  messages: [{ role: 'system', content: SYSTEM_PROMPT }],
};

// ── Answer judge ─────────────────────────────────────────────────────────────
// Quality gate that runs BEFORE the reply reaches the customer. The judge's
// model + rubric live in the LD judge config `ai-planner-judge`; the pass/fail
// threshold is the LD number flag `ai-planner-judge-threshold`. On a fail for a
// cheap-path answer, the route re-asks with complexity forced to 'complex' so
// the STRONG model comes from the same LD targeting rule — never from code.
const JUDGE_CONFIG_KEY = 'ai-planner-judge';

const JUDGE_FALLBACK_RUBRIC = `You are a strict quality judge for Toggle Travel's AI assistant. Score the ASSISTANT RESPONSE to the USER QUESTION between 0.0 and 1.0.
Score LOW (below 0.5) if the response states, estimates, or implies specific live data it cannot verify — prices, fees, seat availability, flight status, or refund amounts. Guessed numbers or price ranges presented as answers are failures.
Score HIGH (0.8 or above) only if the response uses verified data from the conversation or clearly avoids asserting unverifiable specifics.
Respond ONLY with raw JSON: {"score": <0.0-1.0>, "reasoning": "<one sentence>"}`;

// Judge fallback runs on OpenAI (an independent, non-Claude judge — avoids the
// self-preference bias of grading Claude answers with Claude). The real judge
// model/rubric come from the LD judge config `ai-planner-judge`.
const DEFAULT_JUDGE_CONFIG = {
  enabled: true,
  model: {
    name: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    parameters: { temperature: 0, maxTokens: 1024 },
  },
  messages: [{ role: 'system', content: JUDGE_FALLBACK_RUBRIC }],
};

function tryParseJson(text) {
  if (!text) return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

// Judge one answer. Returns a debug object; never throws (a judge outage must
// not take down the chat). Records its own metrics on the judge config.
async function judgeAnswer(question, answer, context) {
  const startedAt = Date.now();
  try {
    // The rubric gets the user context too, so a judge prompt can hold
    // {{product_tier}} answers to a different bar. message/response come last:
    // they are the judge's own reserved template fields.
    const cfg = await getJudgeConfig(JUDGE_CONFIG_KEY, DEFAULT_JUDGE_CONFIG, context, {
      ...buildPromptVariables(context),
      message: question,
      response: answer,
    });
    const src = cfg || DEFAULT_JUDGE_CONFIG;
    if (src.enabled === false) return { configKey: JUDGE_CONFIG_KEY, skipped: 'judge disabled' };

    const msgs = Array.isArray(src.messages) ? src.messages : [];
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || JUDGE_FALLBACK_RUBRIC;
    // Non-system entries are the (Mustache-filled) eval template from LD; if
    // there are none, build the question/answer block ourselves.
    const userPrompt = msgs.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n')
      || `USER QUESTION:\n${question}\n\nASSISTANT RESPONSE:\n${answer}\n\nReturn the verdict JSON now.`;
    const model = String(src.model?.name || DEFAULT_JUDGE_CONFIG.model.name).replace(/^.*\//, '');
    const params = src.model?.parameters || {};
    const tracker = typeof cfg?.createTracker === 'function' ? cfg.createTracker() : null;

    const chat = pickChat(typeof src.provider === 'string' ? src.provider : src.provider?.name, model);
    const call = () => chat([{ role: 'user', content: userPrompt }], {
      system,
      model,
      maxTokens: params.maxOutputTokens ?? params.maxTokens ?? params.max_tokens ?? 1024,
      ...sanitizeParameters(model, { temperature: params.temperature ?? 0 }),
    });

    let result;
    try {
      result = tracker ? await tracker.trackDurationOf(call) : await call();
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

    const parsed = tryParseJson(result.text) || {};
    const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : null;
    return {
      configKey: JUDGE_CONFIG_KEY,
      model,
      score,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
      evaluationMetricKey: src.evaluationMetricKey || null,
      durationMs: Date.now() - startedAt,
      tokens: result.usage || null,
    };
  } catch (err) {
    logger.warn('ai_planner_judge_failed', { error: err.message });
    return { configKey: JUDGE_CONFIG_KEY, error: err.message, durationMs: Date.now() - startedAt };
  }
}

/**
 * Resolve the AI Config for a session into the exact values the request will
 * use — model, effective parameters, instructions (from the config's system
 * message), any preset non-system messages, and the metrics tracker. Parameters
 * are merged over sane defaults so what we display always equals what we send.
 */
async function resolvePlannerConfig(context, variables = {}) {
  const cfg = await getCompletionConfig(AI_CONFIG_KEY, DEFAULT_COMPLETION_CONFIG, context, variables);
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

  const provider = (typeof src.provider === 'string' ? src.provider : src.provider?.name) || '';

  return {
    enabled: src.enabled !== false,
    instructions,
    presetMessages,
    provider,
    // Strip any provider prefix (e.g. "google/gemini-...") for the SDK.
    model: String(rawModel).replace(/^.*\//, ''),
    // Show exactly the parameters LD serves (all of them). Only fall back to
    // defaults if the config provides none (e.g. LD unreachable).
    parameters: sanitizeParameters(
      String(rawModel).replace(/^.*\//, ''),
      Object.keys(src.model?.parameters || {}).length
        ? src.model.parameters
        : { temperature: 0.7, maxOutputTokens: 2048 },
    ),
    // The completion config exposes a createTracker() factory (NOT a .tracker
    // property). A fresh tracker per request is required and gives correct
    // per-variation attribution on LD's Monitoring tab.
    tracker: typeof cfg?.createTracker === 'function' ? cfg.createTracker() : null,
  };
}

// GET /api/ai-planner/config — the model + parameters currently in effect,
// for the model banner on the page. Reflects live LD AI Config changes.
router.get('/config', async (req, res, next) => {
  try {
    const { enabled, model, parameters } = await resolvePlannerConfig(buildContext(req));
    res.json({ configKey: AI_CONFIG_KEY, enabled, model, parameters });
  } catch (err) {
    logger.warn('ai_planner_config_error', { error: err.message });
    next(err);
  }
});

// GET /api/ai-planner/agent-config — the graph currently in effect, for the
// banner while the page is in Agent mode: the root (supervisor) plus every
// specialist LD has wired to it. Resolved without a `complexity` attribute, so
// this reports the fallthrough (simple-path) variation; a complex request
// routes to the strong model via the same LD rule at request time.
router.get('/agent-config', async (req, res, next) => {
  try {
    const context = buildContext(req);
    const def = await resolveAgentGraph(context, buildPromptVariables(context), TOOL_REGISTRY);
    if (!def || !def.root) {
      return res.json({ mode: 'agent', configKey: GRAPH_KEY, graphKey: GRAPH_KEY, enabled: false, model: null, parameters: {}, specialists: [] });
    }
    const roster = buildRoster(def, def.root);
    res.json({
      mode: 'agent',
      configKey: def.root.key,
      graphKey: GRAPH_KEY,
      enabled: true,
      model: def.root.config?.model?.name || null,
      parameters: def.root.config?.model?.parameters || {},
      specialists: roster.map((r) => ({
        name: r.name,
        label: r.label,
        configKey: r.node.key,
        model: r.node.config?.model?.name || null,
        enabled: true, // a disabled node disables the whole graph, so reaching here means on
      })),
    });
  } catch (err) {
    logger.warn('ai_planner_agent_config_error', { error: err.message });
    next(err);
  }
});

// POST /api/ai-planner/feedback — record a thumbs up/down against a prior run.
// Body: { token: <resumptionToken from /chat>, kind: 'up' | 'down' }
router.post('/feedback', (req, res, next) => {
  try {
    const { token, kind } = req.body || {};
    if (typeof token !== 'string' || !token) {
      const err = new Error('Field "token" is required');
      err.status = 400;
      throw err;
    }
    const context = buildContext(req);
    // Two token shapes reach here: conversation mode sends the old SDK's
    // resumption token, agent mode sends the graph run's base64url trackData.
    const ok = recordGraphFeedback(token, context, kind === 'down' ? 'down' : 'up')
      || recordFeedback(token, context, kind === 'down' ? 'down' : 'up');
    logger.info('ai_planner_feedback', { session_id: context.key, kind: kind === 'down' ? 'down' : 'up', recorded: ok });
    res.json({ ok });
  } catch (err) {
    logger.warn('ai_planner_feedback_error', { error: err.message });
    next(err);
  }
});

// POST /api/ai-planner/agent-chat — the multi-agent path behind the page's
// "Agent" toggle. Same request shape as /chat so the browser can switch modes
// by changing the URL and nothing else.
//
// Agent mode costs roughly 30x a conversation turn (an Opus 5 supervisor, up to
// four specialists, and a dozen-plus tool calls), so it sits behind its own flag
// on top of the ai-planner-api gate.
router.post('/agent-chat', async (req, res, next) => {
  try {
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      const err = new Error('Field "message" must be a non-empty string');
      err.status = 400;
      throw err;
    }

    const context = buildContext(req);

    const apiEnabled = await getFlag('ai-planner-api', false, context.key);
    if (!apiEnabled) {
      logger.info('ai_planner_api_disabled', { session_id: context.key, mode: 'agent' });
      return res.status(503).json({ error: 'The AI Planner is currently unavailable.' });
    }

    const agentEnabled = await getFlag('ai-planner-agent-enabled', false, context.key);
    if (!agentEnabled) {
      logger.info('ai_planner_agent_disabled', { session_id: context.key });
      return res.status(503).json({ error: 'Agent mode is not available right now.' });
    }

    // Same classifier as conversation mode, and the same purpose: the verdict is
    // stamped on the context so the supervisor config's LD targeting rule picks
    // Sonnet 5 for simple requests and Opus 5 for complex ones. The routing
    // decision stays in LaunchDarkly.
    const { complexity, debug: classifierDebug } = await classifyMessage(message, context);
    context.complexity = complexity;

    // Same variables conversation mode uses — every agent config's
    // instructions can reference {{user_name}} / {{product_tier}}.
    const variables = buildPromptVariables(context);

    const out = await runAgentTurn({ message, context, variables });

    // Judge the composed reply with the same LD judge config conversation mode
    // uses, so both modes are scored by the same rubric on the same metric.
    // Unlike conversation mode there is no retry: the answer already came from
    // the full specialist fan-out, so re-asking has nothing new to work with.
    // The score is a report on the answer, recorded for LD's Monitoring tab.
    const judge = await judgeAnswer(message, out.reply, context);
    if (judge && !judge.skipped && judge.score != null) {
      judge.threshold = await getFlag('ai-planner-judge-threshold', 0.7, context.key);
      judge.verdict = judge.score >= judge.threshold ? 'pass' : 'fail';
    }

    res.json({
      reply: out.reply,
      meta: out.meta,
      feedbackToken: out.feedbackToken,
      debug: {
        ...out.debug,
        classifier: classifierDebug,
        judges: judge ? [{
          configKey: judge.configKey,
          metricKey: judge.evaluationMetricKey || null,
          model: judge.model || null,
          score: judge.score ?? null,
          threshold: judge.threshold ?? null,
          verdict: judge.verdict || null,
          reasoning: judge.reasoning || null,
          durationMs: judge.durationMs ?? null,
          error: judge.error || null,
        }] : [],
      },
    });
  } catch (err) {
    logger.warn('ai_planner_agent_chat_error', { error: err.message });
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
    const context = buildContext(req);
    const apiEnabled = await getFlag('ai-planner-api', false, context.key);
    if (!apiEnabled) {
      logger.info('ai_planner_api_disabled', { session_id: context.key });
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

    // 1. Classify the message (classifier model+prompt live in LD) and stamp
    //    the verdict onto the context. The ai-planner config's targeting rules
    //    in LD route on this attribute — cheap model for simple, strong for complex.
    const { complexity, debug: classifierDebug } = await classifyMessage(message, context);
    context.complexity = complexity;

    // 2. Prompt variables: the LD prompt references {{user_name}},
    //    {{product_tier}} and friends (Mustache), so personalization is config,
    //    not string-building in code. See buildPromptVariables above.
    const variables = buildPromptVariables(context);

    // Model, params, provider, instructions, and any preset messages come from
    // the LD AI Config. `let` — a judge-triggered retry swaps these for the
    // strong path's values.
    let { instructions, presetMessages, provider, model, parameters, tracker } = await resolvePlannerConfig(context, variables);

    // Preset few-shot turns from the config go before the live conversation.
    const messages = [...presetMessages, ...convo];

    // One generation attempt against a resolved config; metrics go to that
    // config's tracker so LD attributes them to the right variation.
    async function generate(resolved) {
      const call = () => pickChat(resolved.provider, resolved.model)(messages, {
        system: resolved.instructions,
        model: resolved.model,
        // LD may name the token budget maxOutputTokens (Gemini), maxTokens, or max_tokens (Anthropic).
        maxTokens: resolved.parameters.maxOutputTokens ?? resolved.parameters.maxTokens ?? resolved.parameters.max_tokens,
        temperature: resolved.parameters.temperature,
        topP: resolved.parameters.topP,
        topK: resolved.parameters.topK,
      });
      const startedAt = Date.now();
      let res;
      try {
        res = resolved.tracker ? await resolved.tracker.trackDurationOf(call) : await call();
        resolved.tracker?.trackSuccess?.();
        if (res.usage) {
          resolved.tracker?.trackTokens?.({
            total: res.usage.totalTokens,
            input: res.usage.inputTokens,
            output: res.usage.outputTokens,
          });
        }
      } catch (err) {
        resolved.tracker?.trackError?.();
        throw err;
      }
      return { ...res, durationMs: Date.now() - startedAt };
    }

    let result = await generate({ instructions, presetMessages, provider, model, parameters, tracker });
    const firstGeneration = {
      configKey: AI_CONFIG_KEY,
      provider: provider || null,
      model,
      parameters,
      durationMs: result.durationMs,
      tokens: result.usage || null,
      stopReason: result.stopReason || null,
    };

    // ── Judge + retry (the quality safety net) ──────────────────────────────
    // The judge (LD config: ai-planner-judge) scores the draft before the
    // customer sees it. Below the LD threshold flag on the cheap path → re-ask
    // with complexity forced to 'complex', so LD's own targeting rule picks the
    // strong model. The judge score is recorded against the answering variation.
    let judgeDebug = null;
    let retryDebug = null;
    judgeDebug = await judgeAnswer(message, result.text, context);
    if (!judgeDebug.skipped && !judgeDebug.error && judgeDebug.score != null) {
      const threshold = await getFlag('ai-planner-judge-threshold', 0.7, context.key);
      judgeDebug.threshold = threshold;
      judgeDebug.verdict = judgeDebug.score >= threshold ? 'pass' : 'fail';
      tracker?.trackJudgeResult?.({
        judgeConfigKey: judgeDebug.configKey,
        success: true,
        sampled: true,
        ...(judgeDebug.evaluationMetricKey ? { metricKey: judgeDebug.evaluationMetricKey } : {}),
        score: judgeDebug.score,
        reasoning: judgeDebug.reasoning || undefined,
      });

      if (judgeDebug.verdict === 'fail' && context.complexity === 'simple') {
        const draft = result.text;
        try {
          const retryResolved = await resolvePlannerConfig({ ...context, complexity: 'complex' }, variables);
          const retryResult = await generate(retryResolved);
          retryDebug = {
            retried: true,
            firstModel: model,
            model: retryResolved.model,
            provider: retryResolved.provider || null,
            parameters: retryResolved.parameters,
            durationMs: retryResult.durationMs,
            tokens: retryResult.usage || null,
            draft,
          };
          // Custom LD metric event — "how often does the retry kick in".
          track('ai-planner-judge-retry', context.key, {
            from_model: model,
            to_model: retryResolved.model,
            judge_score: judgeDebug.score,
          });
          // The retry's values become the response the customer sees.
          result = retryResult;
          ({ instructions, provider, model, parameters, tracker } = retryResolved);
        } catch (err) {
          logger.warn('ai_planner_retry_failed', { error: err.message });
          retryDebug = { retried: false, error: err.message };
        }
      }
    }

    logger.info('ai_planner_chat', {
      turns: messages.length,
      model,
      complexity: context.complexity,
      judge_verdict: judgeDebug?.verdict || null,
      retried: !!retryDebug?.retried,
      output_tokens: result.usage?.outputTokens,
      stop_reason: result.stopReason,
    });

    // meta lets the page's model banner update to exactly what was used.
    // feedbackToken lets the browser attach a later thumbs up/down to this run.
    // debug feeds the page's developer view (hidden unless dev mode is on).
    res.json({
      reply: result.text,
      meta: { configKey: AI_CONFIG_KEY, model, parameters, complexity: context.complexity },
      feedbackToken: tracker?.resumptionToken || null,
      debug: {
        context: {
          key: context.key,
          name: context.name || null,
          tier: context.tier || null,
          complexity: context.complexity,
        },
        promptVariables: variables,
        // The system prompt exactly as sent — variables already substituted, so
        // the dev view shows the personalization rather than the template.
        systemPrompt: instructions,
        classifier: classifierDebug,
        generation: firstGeneration,
        judge: judgeDebug,
        retry: retryDebug,
      },
    });
  } catch (err) {
    logger.warn('ai_planner_chat_error', { error: err.message });
    next(err);
  }
});

module.exports = router;
