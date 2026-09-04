'use strict';

/**
 * Conversation mode — one turn of the AI Planner's single-model path, on the
 * LaunchDarkly AI SDK (`@launchdarkly/ai-server`).
 *
 *   1. classify   — `ai-planner-classifier` stamps `complexity` on the context
 *   2. generate   — `ai-planner`, streamed; LD's targeting rules on `complexity`
 *                   (and tier) pick the variation — the code never chooses a model
 *   3. judge      — the judges LD attached to the served variation score the
 *                   draft; the accuracy judge below its threshold on the cheap
 *                   path triggers ONE retry with `complexity` forced to complex,
 *                   so the strong model comes from the same LD rule
 *   4. judge again — the retry is judged on its own run, so each variation's
 *                   Monitoring tab shows the scores its answers earned
 *
 * `emit(event, data)` receives progress as it happens (the route forwards it as
 * server-sent events); the resolved value is the complete turn for JSON
 * clients. Both shapes carry the same `debug` block for the page's dev view.
 */

const { streamConfig, feedbackTokenFor } = require('./invoke');
const { classifyMessage } = require('./classifier');
const judges = require('./judges');
const { render, sanitizeParameters } = require('./handlers');
const { userOf, withComplexity, asComplexity, describeContext } = require('./context');
const { trackFor } = require('../launchdarkly');
const logger = require('../logger');

const AI_CONFIG_KEY = 'ai-planner';

function paramsOf(cfg) {
  const model = String(cfg?.model?.name || '').replace(/^.*\//, '');
  return sanitizeParameters(model, cfg?.model?.parameters || {});
}

function renderedSystemPrompt(cfg, variables, context) {
  const vars = { ...variables, ldContext: { ...context } };
  return (cfg?.messages || []).filter((m) => m.role === 'system').map((m) => render(m.content, vars)).join('\n\n') || null;
}

// One streamed generation against whatever variation LD serves for `context`.
async function generate({ context, variables, message, history, emit, phase }) {
  const startedAt = Date.now();
  let start = null;
  let done = null;
  for await (const ev of streamConfig(AI_CONFIG_KEY, { context, input: message, variables, history })) {
    if (ev.type === 'start') {
      start = ev;
      emit('generation', {
        phase,
        configKey: AI_CONFIG_KEY,
        variationKey: ev.trackData.variationKey || null,
        version: ev.trackData.version ?? null,
        model: ev.config?.model?.name || null,
        provider: ev.config?.provider?.name || null,
        parameters: paramsOf(ev.config),
        complexity: userOf(context).complexity || null,
      });
    } else if (ev.type === 'chunk') {
      emit('chunk', { phase, text: ev.text });
    } else if (ev.type === 'done') {
      done = ev;
    }
  }
  if (!done) throw new Error('generation produced no result');
  const cfg = start?.config || {};
  return {
    text: done.response || '',
    usage: done.usage,
    trackData: done.trackData,
    judgeTasks: done.judgeTasks || [],
    config: cfg,
    meta: start?.meta || {},
    durationMs: done.durationMs ?? (Date.now() - startedAt),
    ttfMs: done.ttfMs ?? null,
    summary: {
      configKey: AI_CONFIG_KEY,
      variationKey: done.trackData?.variationKey || null,
      version: done.trackData?.version ?? null,
      provider: cfg.provider?.name || null,
      model: cfg.model?.name || null,
      parameters: paramsOf(cfg),
      durationMs: done.durationMs ?? null,
      ttfMs: done.ttfMs ?? null,
      tokens: done.usage || null,
    },
  };
}

function judgeView(j) {
  if (!j) return null;
  return {
    configKey: j.configKey, kind: j.kind, metricKey: j.metricKey, model: j.model,
    variationKey: j.variationKey, version: j.version, score: j.score, threshold: j.threshold ?? null,
    verdict: j.verdict || null, reasoning: j.reasoning || null, durationMs: j.durationMs ?? null,
    recorded: j.recorded ?? null, inverted: !!j.inverted, error: j.error || null,
  };
}

/**
 * @param {object} args
 * @param {string} args.message
 * @param {Array<{role:string, content:string}>} args.history  prior turns (already capped by the route)
 * @param {object} args.context   LD multi-context (buildContext)
 * @param {object} args.variables prompt variables (buildPromptVariables)
 * @param {function} [args.emit]  progress callback (event, data)
 * @param {AbortSignal} [args.signal]
 */
async function runConversationTurn({ message, history = [], context, variables, emit = () => {}, signal }) {
  const startedAt = Date.now();

  // 1. Classify, stamp the verdict on the context (the LD rules read it).
  const { complexity, debug: classifierDebug } = await classifyMessage(message, context, variables);
  withComplexity(context, complexity);
  emit('routing', { context: describeContext(context), classifier: classifierDebug, promptVariables: variables });

  const vars = { ...variables, ...(signal ? { __signal: signal } : {}) };

  // 2. Draft.
  const first = await generate({ context, variables: vars, message, history, emit, phase: 'draft' });

  // 3. Judges LD attached to the served variation, on the draft.
  let draftResults = await judges.runTasks(first.judgeTasks, { context, variables, question: message, answer: first.text });
  draftResults = await judges.applyThresholds(draftResults, context);
  const draftAccuracy = judges.accuracyOf(draftResults);
  emit('judge', { phase: 'draft', judge: judgeView(draftAccuracy), judges: draftResults.map(judgeView), source: first.judgeTasks.length ? 'ld' : 'none' });

  let final = first;
  let finalResults = draftResults;
  let retry = null;

  if (draftAccuracy?.verdict === 'fail' && userOf(context).complexity === 'simple') {
    emit('retry', {
      draft: first.text,
      reason: draftAccuracy.reasoning || null,
      score: draftAccuracy.score,
      threshold: draftAccuracy.threshold,
      firstVariationKey: first.summary.variationKey,
    });
    try {
      // Same LD config, `complexity` forced to complex: the strong model comes
      // from LaunchDarkly's own targeting rule, never from this code.
      const retryContext = asComplexity(context, 'complex');
      const second = await generate({ context: retryContext, variables: vars, message, history, emit, phase: 'retry' });
      trackFor('ai-planner-judge-retry', context, {
        from_model: first.summary.model,
        to_model: second.summary.model,
        from_variation: first.summary.variationKey,
        to_variation: second.summary.variationKey,
        judge_score: draftAccuracy.score,
      });
      // Judge the retry on ITS run, so the strong variation's Monitoring shows
      // the scores its answers earned, and relevance/toxicity score what ships.
      let retryResults = await judges.runTasks(second.judgeTasks, { context: retryContext, variables, question: message, answer: second.text });
      retryResults = await judges.applyThresholds(retryResults, context);
      retry = {
        retried: true,
        draft: first.text,
        firstModel: first.summary.model,
        firstVariationKey: first.summary.variationKey,
        ...second.summary,
        judge: judgeView(judges.accuracyOf(retryResults)),
      };
      emit('judge', { phase: 'retry', judge: retry.judge, judges: retryResults.map(judgeView) });
      final = second;
      finalResults = retryResults;
    } catch (err) {
      logger.warn('ai_planner_retry_failed', { error: err.message });
      retry = { retried: false, error: err.message };
    }
  }

  const relevance = judges.relevanceOf(finalResults);
  if (relevance) emit('relevance', { relevance: judgeView(relevance) });

  logger.info('ai_planner_chat', {
    turns: history.length + 1,
    model: final.summary.model,
    variation: final.summary.variationKey,
    tier: userOf(context).tier || null,
    complexity: userOf(context).complexity,
    judge_verdict: draftAccuracy?.verdict || null,
    relevance_verdict: relevance?.verdict || null,
    retried: !!retry?.retried,
    ttf_ms: final.ttfMs,
    duration_ms: Date.now() - startedAt,
    output_tokens: final.usage?.output,
  });

  return {
    reply: final.text,
    // meta lets the page's model banner show exactly what was used.
    meta: {
      mode: 'conversation',
      configKey: AI_CONFIG_KEY,
      variationKey: final.summary.variationKey,
      version: final.summary.version,
      model: final.summary.model,
      parameters: final.summary.parameters,
      complexity: userOf(context).complexity,
    },
    feedbackToken: feedbackTokenFor(final.trackData),
    debug: {
      mode: 'conversation',
      context: describeContext(context),
      promptVariables: variables,
      // The system prompt exactly as sent — variables already substituted, so
      // the dev view shows the personalization rather than the template.
      systemPrompt: renderedSystemPrompt(final.config, variables, context),
      classifier: classifierDebug,
      generation: first.summary,
      judge: judgeView(draftAccuracy),
      judges: finalResults.map(judgeView),
      judgeSource: first.judgeTasks.length ? 'ld' : 'none',
      relevance: judgeView(relevance),
      retry,
      totalDurationMs: Date.now() - startedAt,
    },
  };
}

module.exports = { runConversationTurn, AI_CONFIG_KEY, paramsOf };
