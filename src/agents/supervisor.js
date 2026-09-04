'use strict';

/**
 * Agent mode for the AI Planner — the multi-agent path behind the page's
 * "Agent" toggle, driven by a LaunchDarkly **agent graph**.
 *
 * Shape of a turn:
 *   1. Supervisor, PLAN phase   — decompose the request, choose specialists
 *   2. Specialists, in parallel — one graph node each, with its own LD tools
 *   3. Supervisor, COMPOSE phase — write the single customer-facing answer
 *
 * Nothing about the team lives in this file any more. The LD agent graph
 * (`ai-planner-graph`) owns the roster and the wiring: its root is the
 * supervisor, its edges are the specialists, and each edge's handoff JSON
 * carries that specialist's label, timeout and reporting format. Adding a fifth
 * specialist is a graph edit in LaunchDarkly — no deploy. Model choice stays in
 * each node's AI Config, and which specialists actually run on a given turn
 * stays the supervisor's decision.
 *
 * This path runs on the new AI SDK (see `src/aiGraph.js`); conversation mode
 * still uses the older `@launchdarkly/server-sdk-ai`.
 */

const { getRawClient, getGraphMeta, track } = require('../launchdarkly');
const { GRAPH_KEY, resolveAgentGraph, instrumentTools, createGraphRun } = require('../aiGraph');
const { TOOL_REGISTRY } = require('../tools');
const logger = require('../logger');

// Fallback only — a specialist whose edge carries no timeoutMs.
const SPECIALIST_TIMEOUT_MS = Number(process.env.AGENT_SPECIALIST_TIMEOUT_MS || 60000);

// The COMPOSE phase runs as its own agent config/graph node — a sibling of the
// specialists, not a second call against the root. Splitting it out (instead
// of calling the root node twice, once for PLAN and once for COMPOSE) means
// the agent graph is a real DAG (root -> specialists -> compose) rather than a
// cycle that draws the same "Supervisor" box twice in the LD graph UI with
// identical Monitoring numbers for both. It also gives PLAN and COMPOSE their
// own separate duration/token/error stats instead of one blended total.
const COMPOSE_KEY = 'ai-planner-agent-compose';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Human label for a node when its edge has no handoff.label: turn
// "ai-planner-agent-trip-timing" into "Trip Timing".
function labelFor(nodeKey, handoff) {
  if (typeof handoff?.label === 'string' && handoff.label.trim()) return handoff.label;
  return nodeKey
    .replace(/^ai-planner-agent-?/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || nodeKey;
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

// The roster the supervisor is allowed to choose from, built from the graph's
// own edges so the PLAN prompt can never offer a specialist that LD removed.
function buildPlanPrompt(message, variables, roster) {
  return [
    'PHASE "PLAN"',
    `Today's date is ${today()}.`,
    `The traveler is ${variables.user_name} (${variables.product_tier} tier).`,
    '',
    'Specialists available on this turn (use these exact names):',
    ...roster.map((r) => `- ${r.name} — ${r.label}${r.purpose ? `: ${r.purpose}` : ''}`),
    '',
    'Customer request:',
    message,
  ].join('\n');
}

function buildSpecialistPrompt(message, plan, variables, handoff) {
  const constraints = plan?.constraints ? JSON.stringify(plan.constraints) : 'not extracted';
  const wanted = Array.isArray(handoff?.pass) && handoff.pass.length
    ? `Constraints this specialist owns: ${handoff.pass.join(', ')}`
    : null;
  return [
    `Today's date is ${today()}.`,
    `The traveler is ${variables.user_name} (${variables.product_tier} tier).`,
    '',
    'Customer request:',
    message,
    '',
    `Constraints extracted by the supervisor: ${constraints}`,
    ...(wanted ? [wanted] : []),
    '',
    // Reporting format comes from the graph edge in LD, not from this file.
    handoff?.reportFormat || 'Do your specialist analysis and report back in your required format.',
  ].filter((line) => line !== null).join('\n');
}

function buildComposePrompt(message, findings, variables) {
  const reports = findings.map((f) => (
    f.error
      ? `--- ${f.label} specialist: UNAVAILABLE (${f.error}). Do not invent its findings.`
      : `--- ${f.label} specialist:\n${f.content}`
  )).join('\n\n');

  return [
    'PHASE "COMPOSE"',
    `Today's date is ${today()}.`,
    `The traveler is ${variables.user_name} (${variables.product_tier} tier).`,
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

function usageOf(result) {
  const u = result?.usage;
  if (!u) return null;
  return { input: u.input ?? 0, output: u.output ?? 0, total: u.total ?? 0 };
}

// Run one specialist node end to end. Never throws: a specialist that fails
// becomes a finding the supervisor is told to acknowledge rather than paper
// over. `from` makes runNode emit the graph handoff event for this edge.
async function runSpecialist(def, root, entry, message, plan, variables) {
  const started = Date.now();
  const toolCalls = [];
  const timeoutMs = Number(entry.handoff?.timeoutMs) || SPECIALIST_TIMEOUT_MS;
  try {
    const result = await withTimeout(
      def.runNode(entry.node, buildSpecialistPrompt(message, plan, variables, entry.handoff), {
        variables,
        toolHandlers: instrumentTools(TOOL_REGISTRY, toolCalls),
        from: root,
      }),
      timeoutMs,
      entry.label,
    );
    return {
      name: entry.name,
      label: entry.label,
      configKey: entry.node.key,
      model: entry.node.config?.model?.name || null,
      content: result.response || '',
      toolCalls,
      tokens: usageOf(result),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    logger.warn('ai_agent_specialist_failed', { specialist: entry.name, config_key: entry.node.key, error: err.message });
    return {
      name: entry.name,
      label: entry.label,
      configKey: entry.node.key,
      model: entry.node.config?.model?.name || null,
      toolCalls,
      error: err.message,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * The graph's specialist roster: one entry per outgoing edge of the root, with
 * the handoff JSON LD attached to that edge. `name` is the short handle the
 * supervisor uses in its PLAN JSON.
 */
function buildRoster(def, root) {
  return def.edgesFrom(root.key).map((edge) => {
    const node = def.getNode(edge.targetKey);
    const handoff = edge.handoff || {};
    const label = labelFor(edge.targetKey, handoff);
    return {
      name: edge.targetKey.replace(/^ai-planner-agent-/, ''),
      label,
      purpose: typeof handoff.purpose === 'string' ? handoff.purpose : (node?.config?.instructions ? null : null),
      edgeKey: edge.key,
      handoff,
      node,
    };
  }).filter((entry) => entry.node);
}

/**
 * Run one agent-mode turn.
 * @returns {Promise<{reply: string, meta: object, feedbackToken: ?string, debug: object}>}
 */
async function runAgentTurn({ message, context, variables }) {
  const startedAt = Date.now();

  const def = await resolveAgentGraph(context, variables, TOOL_REGISTRY);
  if (!def || !def.root) {
    const err = new Error('Agent mode is not available right now.');
    err.status = 503;
    throw err;
  }

  const root = def.root;
  const roster = buildRoster(def, root);
  // Graceful degrade: an older/unrewired graph (root -> specialists only, no
  // compose node) falls back to running COMPOSE on the root, matching the
  // previous behavior — the graph still works, it just draws the duplicate
  // Supervisor box again until the graph is rewired.
  const composeNode = def.getNode(COMPOSE_KEY) || root;
  if (composeNode === root) {
    logger.warn('ai_agent_compose_node_missing', { config_key: COMPOSE_KEY, message: 'Falling back to the root node for COMPOSE — add the compose node + edges to the agent graph.' });
  }
  const graphMeta = await getGraphMeta(GRAPH_KEY, context);
  const run = createGraphRun(getRawClient(), context, graphMeta);

  try {
    // ── 1. PLAN ─────────────────────────────────────────────────────────────
    const planToolCalls = [];
    const planRun = await def.runNode(root, buildPlanPrompt(message, variables, roster), {
      variables,
      toolHandlers: instrumentTools(TOOL_REGISTRY, planToolCalls),
    });
    const plan = parsePlan(planRun.response);

    // An unparseable plan means we do not know what the request needs. Consult
    // everyone on the graph rather than guess — the cost shows in the dev view.
    const requested = Array.isArray(plan?.specialists) ? plan.specialists : null;
    const chosen = (requested
      ? roster.filter((r) => requested.some((s) => String(s).toLowerCase().includes(r.name)))
      : roster);

    const planDebug = {
      configKey: root.key,
      phase: 'plan',
      model: root.config?.model?.name || null,
      constraints: plan?.constraints || null,
      specialists: chosen.map((r) => r.name),
      reasoning: plan?.reasoning || null,
      parsed: !!plan,
      fellBackToAll: !requested,
      tokens: usageOf(planRun),
      durationMs: Date.now() - startedAt,
    };

    // ── 2. SPECIALISTS (parallel) ───────────────────────────────────────────
    const findings = await Promise.all(chosen.map((entry) => runSpecialist(def, root, entry, message, plan, variables)));

    // ── 3. COMPOSE ──────────────────────────────────────────────────────────
    // Runs on its own node (see COMPOSE_KEY above), not a second call against
    // the root — that's what keeps PLAN and COMPOSE as two distinct boxes with
    // two distinct Monitoring histories in the LD graph UI.
    const composeStarted = Date.now();
    const composeRun = await def.runNode(composeNode, buildComposePrompt(message, findings, variables), { variables });

    const toolCallCount = findings.reduce((n, f) => n + (f.toolCalls?.length || 0), 0);
    const totalTokens = [planRun, composeRun].reduce((n, r) => n + (r.usage?.total || 0), 0)
      + findings.reduce((n, f) => n + (f.tokens?.total || 0), 0);

    // Graph-level metrics for the whole workflow. Node-level duration, tokens,
    // tool calls and per-edge handoffs are already tracked by runNode().
    run.path([root.key, ...findings.map((f) => f.configKey), composeNode.key]);
    run.duration(Date.now() - startedAt);
    run.tokens(totalTokens);
    run.success();

    // Custom LD metric event — how much machinery a turn actually used.
    track('ai-planner-agent-turn', context.key, {
      graph_key: GRAPH_KEY,
      specialists: chosen.map((r) => r.name).join(','),
      specialist_count: chosen.length,
      tool_calls: toolCallCount,
      plan_model: root.config?.model?.name || null,
      compose_model: composeNode.config?.model?.name || null,
      complexity: context.complexity || null,
    });

    logger.info('ai_planner_agent_turn', {
      graph_key: GRAPH_KEY,
      specialists: chosen.map((r) => r.name),
      specialist_count: chosen.length,
      tool_calls: toolCallCount,
      plan_model: root.config?.model?.name || null,
      compose_model: composeNode.config?.model?.name || null,
      complexity: context.complexity || null,
      failed_specialists: findings.filter((f) => f.error).map((f) => f.name),
      total_tokens: totalTokens,
      duration_ms: Date.now() - startedAt,
    });

    return {
      reply: composeRun.response || '',
      meta: {
        mode: 'agent',
        // The config that actually wrote the reply the customer reads — the
        // composer, not the planner — matching what the banner shows for
        // conversation mode (the config that generated the text).
        configKey: composeNode.key,
        graphKey: GRAPH_KEY,
        model: composeNode.config?.model?.name || null,
        parameters: composeNode.config?.model?.parameters || {},
        complexity: context.complexity || null,
        specialists: chosen.map((r) => r.name),
        toolCalls: toolCallCount,
      },
      // The new SDK has no resumption token; the compose call's trackData is
      // what attributes deferred feedback to this run, so hand that back.
      feedbackToken: Buffer.from(JSON.stringify(composeRun.trackData || {})).toString('base64url'),
      debug: {
        mode: 'agent',
        context: { key: context.key, name: context.name || null, tier: context.tier || null, complexity: context.complexity || null },
        promptVariables: variables,
        graph: {
          key: GRAPH_KEY,
          root: root.key,
          composeKey: composeNode.key,
          variationKey: graphMeta.variationKey || null,
          version: graphMeta.version || null,
          runId: run.trackData.runId,
          nodes: roster.length + 2,
          edges: roster.map((r) => ({ key: r.edgeKey, target: r.node.key, handoff: r.handoff })),
        },
        plan: planDebug,
        specialists: findings.map((f) => ({
          name: f.name, label: f.label, configKey: f.configKey, model: f.model || null,
          toolCalls: f.toolCalls || [], tokens: f.tokens || null,
          durationMs: f.durationMs, error: f.error || null,
          content: f.content || null,
        })),
        compose: {
          configKey: composeNode.key,
          phase: 'compose',
          model: composeNode.config?.model?.name || null,
          tokens: usageOf(composeRun),
          durationMs: Date.now() - composeStarted,
        },
        totalDurationMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    run.duration(Date.now() - startedAt);
    run.failure();
    throw err;
  }
}

module.exports = { runAgentTurn, buildRoster };
