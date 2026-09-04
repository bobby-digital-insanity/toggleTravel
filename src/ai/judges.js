'use strict';

/**
 * LLM-as-judge for the AI Planner, driven by LaunchDarkly config.
 *
 * WHICH judges run, and how often, is the `judgeConfiguration` attached to the
 * answering variation in LD (`ai-planner-judge` + `relevance` at 100%,
 * `toxicity` sampled, on `ai-planner`; the same pair on the agent COMPOSE
 * node). The SDK's `buildJudgeTasks()` reads that attachment and applies the
 * sampling; this module then runs each task as a normal tracked call of the
 * judge's own config (so the judge's duration/tokens land on the judge config's
 * Monitoring tab) and records the score against the ANSWERING run
 * (`evaluationMetricKey` + the answer's trackData + judgeConfigKey — the event
 * LD's `$ld:ai:judge:*` charts read). Same shape the SDK's runJudges() emits.
 *
 * Two judges, two failure modes. The accuracy judge (`ai-planner-judge`)
 * catches fabricated data — a guessed fare, an invented flight status — and is
 * the only one that triggers a retry. `relevance` catches the assistant
 * answering the wrong thing entirely: off-topic drift, or complying with a
 * prompt injection in the customer's message. `toxicity` is inverted (lower is
 * better). Thresholds are LD number flags.
 *
 * The judge runs here rather than inside the SDK's `invoke()` for one reason:
 * the task path there hands the judge only the answer, not the question. This
 * supplies both LD reserved names ({{message_history}} / {{response_to_evaluate}})
 * and the older {{message}} / {{response}} pair, so either template convention
 * resolves, plus the user-context variables ({{product_tier}} …).
 */

const { loadSdk } = require('../aiGraph');
const { getHandlers } = require('./handlers');
const { invokeConfig, track } = require('./invoke');
const { getFlagFor } = require('../launchdarkly');
const logger = require('../logger');

// The SDK appends this to message_history so generic judge rubrics (which
// have no output-format line of their own) still return parseable JSON.
const FORMATTING_INSTRUCTIONS = [
  'Your response MUST be in valid JSON format with the following structure:',
  '{ "score": <number, 0-1>, "reasoning": <string> }',
  'The output must be valid, parseable JSON. Do not include additional tags, comments, formatting, or newlines.',
  'It should be returned in a format that is immediately parseable by a JSON parsing function. Do not include ```json tags.',
].join('\n');

const ACCURACY_KEYS = new Set(['ai-planner-judge', 'accuracy']);
const RELEVANCE_KEYS = new Set(['relevance']);
const TOXICITY_KEYS = new Set(['toxicity']);

// Agent mode's fallback when the COMPOSE node has no judges attached in LD yet
// (the setup script attaches them): the same pair conversation mode uses.
const DEFAULT_AGENT_JUDGES = [
  { key: 'ai-planner-judge', samplingRate: 1 },
  { key: 'relevance', samplingRate: 1 },
];

function kindOf(configKey) {
  if (ACCURACY_KEYS.has(configKey)) return 'accuracy';
  if (RELEVANCE_KEYS.has(configKey)) return 'relevance';
  if (TOXICITY_KEYS.has(configKey)) return 'toxicity';
  return 'other';
}

function tryParseJson(sdk, text) {
  if (!text) return null;
  try { return sdk.parseJSONWithPossibleFences(String(text)); } catch { /* fall through */ }
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch { /* no */ } }
  return null;
}

/**
 * Judge tasks for an answer, as LD configured them on the answering variation.
 * `fallbackJudges` (agent mode) is used only when the variation has no
 * judgeConfiguration at all.
 */
async function buildTasks({ config, context, answer, trackData, fallbackJudges = null }) {
  const sdk = await loadSdk();
  const handlers = await getHandlers();
  const attached = Array.isArray(config?.judgeConfiguration?.judges) && config.judgeConfiguration.judges.length > 0;
  const effective = attached
    ? config
    : (fallbackJudges ? { ...config, judgeConfiguration: { judges: fallbackJudges } } : config);
  const handler = handlers.find((h) => h.providesFor?.[0] === (config?.provider?.name || '*')) || handlers[0];
  const tasks = await sdk.buildJudgeTasks({
    config: effective, userContext: context, handler, handlers, llmResponse: answer, baseTrackData: trackData,
  });
  return { tasks, source: attached ? 'ld' : (fallbackJudges ? 'default' : 'none') };
}

/**
 * Run judge tasks (from buildTasks or the SDK's invoke()) in parallel.
 * `evidence` is extra context the judge should see — in agent mode, the
 * specialist findings the composer worked from, so real tool data is not
 * mistaken for a fabricated number.
 */
async function runTasks(tasks, { context, variables = {}, question, answer, evidence = null }) {
  if (!tasks?.length) return [];
  const sdk = await loadSdk();
  const history = [
    question,
    ...(evidence ? [`[Verified data the assistant was given before answering]\n${evidence}`] : []),
    answer,
    FORMATTING_INSTRUCTIONS,
  ].filter(Boolean).join('\n\n');

  return Promise.all(tasks.map(async (task) => {
    const configKey = task.configKey;
    const startedAt = Date.now();
    const base = {
      configKey,
      kind: kindOf(configKey),
      metricKey: task.evaluationMetricKey || task.judgeConfig?.evaluationMetricKey || null,
      model: task.judgeConfig?.model?.name || null,
      variationKey: task.judgeMeta?.variationKey || null,
      version: task.judgeMeta?.version ?? null,
      sampled: true,
    };
    try {
      const { response, usage, trackData: judgeRun } = await invokeConfig(configKey, {
        context,
        input: answer,
        variables: {
          ...variables,
          message: question,
          response: answer,
          message_history: history,
          response_to_evaluate: answer,
        },
      });
      const parsed = tryParseJson(sdk, response) || {};
      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : null;
      let recorded = false;
      if (score != null && base.metricKey && task.parentTrackData) {
        track(context, base.metricKey, { ...task.parentTrackData, judgeConfigKey: configKey }, score);
        recorded = true;
      }
      return {
        ...base,
        score,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
        durationMs: Date.now() - startedAt,
        tokens: usage || null,
        judgeRunId: judgeRun?.runId || null,
        recorded,
        ...(score == null ? { error: `judge returned no score: ${String(response).slice(0, 120)}` } : {}),
      };
    } catch (err) {
      logger.warn('ai_planner_judge_failed', { config_key: configKey, error: err.message });
      return { ...base, score: null, error: err.message, durationMs: Date.now() - startedAt, recorded: false };
    }
  }));
}

// Judge results the SDK produced itself (agent mode: runNode() runs the judges
// attached to the compose node, with graph attribution). Normalized to the
// same shape as runTasks() so the dev view renders both alike.
function fromSdkResults(judgeResults = {}) {
  return Object.entries(judgeResults || {}).map(([configKey, r]) => ({
    configKey,
    kind: kindOf(configKey),
    metricKey: null,
    model: null,
    score: typeof r?.score === 'number' ? Math.max(0, Math.min(1, r.score)) : null,
    reasoning: typeof r?.response === 'string' ? r.response : null,
    tokens: r?.usage || null,
    recorded: typeof r?.score === 'number', // the SDK tracked it
    sampled: true,
    ranBy: 'sdk',
  }));
}

/**
 * Pass/fail per judge against the LD threshold flags. Toxicity is inverted:
 * a HIGH score is the failure.
 */
async function applyThresholds(results, context) {
  const [accuracyT, relevanceT] = await Promise.all([
    getFlagFor('ai-planner-judge-threshold', 0.7, context),
    getFlagFor('ai-planner-relevance-threshold', 0.7, context),
  ]);
  return results.map((r) => {
    if (r.score == null) return r;
    if (r.kind === 'toxicity') return { ...r, threshold: 0.3, inverted: true, verdict: r.score <= 0.3 ? 'pass' : 'fail' };
    const threshold = r.kind === 'relevance' ? relevanceT : accuracyT;
    return { ...r, threshold, verdict: r.score >= threshold ? 'pass' : 'fail' };
  });
}

const accuracyOf = (results) => results.find((r) => r.kind === 'accuracy') || null;
const relevanceOf = (results) => results.find((r) => r.kind === 'relevance') || null;

module.exports = { buildTasks, runTasks, fromSdkResults, applyThresholds, accuracyOf, relevanceOf, DEFAULT_AGENT_JUDGES, kindOf };
