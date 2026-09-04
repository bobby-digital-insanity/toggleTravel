'use strict';

/**
 * Agent mode for the AI Planner — the multi-agent path behind the page's
 * "Agent" toggle.
 *
 * Shape of a turn:
 *   1. Supervisor, PLAN phase   — decompose the request, choose specialists
 *   2. Specialists, in parallel — each runs its own LD agent config + tools
 *   3. Supervisor, COMPOSE phase — write the single customer-facing answer
 *
 * Every model choice lives in LaunchDarkly, not here. The supervisor config
 * (`ai-planner-agent`) carries a targeting rule on the `complexity` context
 * attribute — Sonnet 5 for simple, Opus 5 for complex — so this file never
 * picks a model. Which specialists run is the supervisor's call, not the code's.
 */

const { getAgent, track } = require('../launchdarkly');
const { TOOL_REGISTRY } = require('../tools');
const logger = require('../logger');

const SUPERVISOR_KEY = 'ai-planner-agent';

const SPECIALISTS = {
  weather: { key: 'ai-planner-agent-weather', label: 'Weather' },
  location: { key: 'ai-planner-agent-location', label: 'Location' },
  budget: { key: 'ai-planner-agent-budget', label: 'Budget' },
  timing: { key: 'ai-planner-agent-timing', label: 'Trip Timing' },
};

// A disabled default is the right fallback for agent mode. Supplying real
// instructions here would fork the prompt between LD and code — the thing this
// demo exists to avoid — so if LD is unreachable the route reports that plainly
// instead of quietly answering from a hardcoded prompt.
const DISABLED_DEFAULT = { enabled: false };

const SPECIALIST_TIMEOUT_MS = Number(process.env.AGENT_SPECIALIST_TIMEOUT_MS || 60000);

// The installed LangChain provider extracts reply text only when the model
// returns a plain string (extractLastMessageContent bails to "" otherwise).
// Claude Opus 5 has thinking on by default and returns content as an array of
// blocks — [{type:'thinking'}, {type:'text'}] — so ManagedResult.content comes
// back empty even though the answer is present. Recover it from the raw
// LangChain messages. Without this, every Opus 5 turn returns an empty reply.
function extractText(result) {
  if (result?.content && String(result.content).trim()) return result.content;

  const raw = result?.raw;
  const messages = Array.isArray(raw?.messages) ? raw.messages : (Array.isArray(raw) ? raw : []);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The supervisor answers PHASE "PLAN" with JSON. Models sometimes wrap it in a
// fence or add a sentence, so parse defensively.
function parsePlan(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function buildPlanPrompt(message, variables) {
  return [
    'PHASE "PLAN"',
    `Today's date is ${today()}.`,
    `The traveler is ${variables.name} (${variables.tier} tier).`,
    '',
    'Customer request:',
    message,
  ].join('\n');
}

function buildSpecialistPrompt(message, plan, variables) {
  const constraints = plan?.constraints ? JSON.stringify(plan.constraints) : 'not extracted';
  return [
    `Today's date is ${today()}.`,
    `The traveler is ${variables.name} (${variables.tier} tier).`,
    '',
    'Customer request:',
    message,
    '',
    `Constraints extracted by the supervisor: ${constraints}`,
    '',
    'Do your specialist analysis and report back in your required format.',
  ].join('\n');
}

function buildComposePrompt(message, plan, findings, variables) {
  const reports = findings.map((f) => (
    f.error
      ? `--- ${f.label} specialist: UNAVAILABLE (${f.error}). Do not invent its findings.`
      : `--- ${f.label} specialist:\n${f.content}`
  )).join('\n\n');

  return [
    'PHASE "COMPOSE"',
    `Today's date is ${today()}.`,
    `The traveler is ${variables.name} (${variables.tier} tier).`,
    '',
    'Customer request:',
    message,
    '',
    'Specialist findings:',
    reports || '(no specialists were consulted)',
    '',
    'Write the answer the customer reads now.',
  ].join('\n');
}

// Run one specialist end to end. Never throws: a specialist that fails becomes
// a finding the supervisor is told to acknowledge rather than paper over.
async function runSpecialist(name, message, plan, context, variables) {
  const spec = SPECIALISTS[name];
  const started = Date.now();
  try {
    const agent = await getAgent(spec.key, DISABLED_DEFAULT, context, variables, TOOL_REGISTRY);
    if (!agent) {
      return { name, label: spec.label, configKey: spec.key, error: 'agent config disabled or unavailable', durationMs: Date.now() - started };
    }
    const result = await withTimeout(agent.run(buildSpecialistPrompt(message, plan, variables)), SPECIALIST_TIMEOUT_MS, spec.label);
    const cfg = agent.getConfig?.() || {};
    return {
      name,
      label: spec.label,
      configKey: spec.key,
      model: cfg.model?.name || null,
      content: extractText(result),
      toolCalls: result.metrics?.toolCalls || [],
      tokens: result.metrics?.tokens || null,
      durationMs: result.metrics?.durationMs ?? Date.now() - started,
    };
  } catch (err) {
    logger.warn('ai_agent_specialist_failed', { specialist: name, config_key: spec.key, error: err.message });
    return { name, label: spec.label, configKey: spec.key, error: err.message, durationMs: Date.now() - started };
  }
}

/**
 * Run one agent-mode turn.
 * @returns {Promise<{reply: string, meta: object, feedbackToken: ?string, debug: object}>}
 */
async function runAgentTurn({ message, context, variables }) {
  const startedAt = Date.now();

  // ── 1. PLAN ───────────────────────────────────────────────────────────────
  const planner = await getAgent(SUPERVISOR_KEY, DISABLED_DEFAULT, context, variables, TOOL_REGISTRY);
  if (!planner) {
    const err = new Error('Agent mode is not available right now.');
    err.status = 503;
    throw err;
  }

  const planCfg = planner.getConfig?.() || {};
  const planRun = await planner.run(buildPlanPrompt(message, variables));
  const planText = extractText(planRun);
  const plan = parsePlan(planText);

  // An unparseable plan means we do not know what the request needs. Consult
  // everyone rather than guess — the cost is visible in the dev view.
  const requested = Array.isArray(plan?.specialists) ? plan.specialists : null;
  const chosen = (requested || Object.keys(SPECIALISTS)).filter((s) => SPECIALISTS[s]);
  const planDebug = {
    configKey: SUPERVISOR_KEY,
    phase: 'plan',
    model: planCfg.model?.name || null,
    constraints: plan?.constraints || null,
    specialists: chosen,
    reasoning: plan?.reasoning || null,
    parsed: !!plan,
    fellBackToAll: !requested,
    tokens: planRun.metrics?.tokens || null,
    durationMs: planRun.metrics?.durationMs ?? null,
  };

  // ── 2. SPECIALISTS (parallel) ─────────────────────────────────────────────
  const findings = await Promise.all(chosen.map((name) => runSpecialist(name, message, plan, context, variables)));

  // ── 3. COMPOSE ────────────────────────────────────────────────────────────
  // A fresh agent instance gives a fresh tracker, so LD attributes the compose
  // call separately from the plan call on the same config.
  const composer = await getAgent(SUPERVISOR_KEY, DISABLED_DEFAULT, context, variables, TOOL_REGISTRY);
  if (!composer) {
    const err = new Error('Agent mode is not available right now.');
    err.status = 503;
    throw err;
  }
  const composeCfg = composer.getConfig?.() || {};
  const composeRun = await composer.run(buildComposePrompt(message, plan, findings, variables));

  // NOTE: judges are deliberately NOT attached to the supervisor config via LD's
  // judgeConfiguration. ManagedAgent.run() feeds the judge `result.content`,
  // which is the empty string whenever the model returns array content — and
  // Claude Opus 5 always does, because thinking is on by default. An attached
  // judge therefore scores a blank answer and writes a meaningless score to the
  // config's Monitoring tab. The route judges the extracted reply instead.

  const toolCallCount = findings.reduce((n, f) => n + (f.toolCalls?.length || 0), 0);

  // Custom LD metric event — how much machinery a turn actually used.
  track('ai-planner-agent-turn', context.key, {
    specialists: chosen.join(','),
    specialist_count: chosen.length,
    tool_calls: toolCallCount,
    supervisor_model: composeCfg.model?.name || null,
    complexity: context.complexity || null,
  });

  logger.info('ai_planner_agent_turn', {
    specialists: chosen,
    specialist_count: chosen.length,
    tool_calls: toolCallCount,
    supervisor_model: composeCfg.model?.name || null,
    complexity: context.complexity || null,
    failed_specialists: findings.filter((f) => f.error).map((f) => f.name),
    duration_ms: Date.now() - startedAt,
  });

  return {
    reply: extractText(composeRun),
    meta: {
      mode: 'agent',
      configKey: SUPERVISOR_KEY,
      model: composeCfg.model?.name || null,
      parameters: composeCfg.model?.parameters || {},
      complexity: context.complexity || null,
      specialists: chosen,
      toolCalls: toolCallCount,
    },
    feedbackToken: composeRun.metrics?.resumptionToken || null,
    debug: {
      mode: 'agent',
      context: { key: context.key, name: context.name || null, tier: context.tier || null, complexity: context.complexity || null },
      promptVariables: variables,
      plan: planDebug,
      specialists: findings.map((f) => ({
        name: f.name, label: f.label, configKey: f.configKey, model: f.model || null,
        toolCalls: f.toolCalls || [], tokens: f.tokens || null,
        durationMs: f.durationMs, error: f.error || null,
        content: f.content || null,
      })),
      compose: {
        configKey: SUPERVISOR_KEY,
        phase: 'compose',
        model: composeCfg.model?.name || null,
        tokens: composeRun.metrics?.tokens || null,
        durationMs: composeRun.metrics?.durationMs ?? null,
      },

      totalDurationMs: Date.now() - startedAt,
    },
  };
}

module.exports = { runAgentTurn, SPECIALISTS };
