'use strict';

/**
 * One-time (idempotent) LaunchDarkly setup for the AI Planner — everything the
 * AI Planner architecture review (AI_PLANNER_REVIEW.md) asks for on the LD
 * side, as code, so the project's AI Configs, metrics, tools and graph can be
 * re-created or repaired from this file the same way ld-experiment-setup.js
 * owns the experiments.
 *
 * Sections (each checks current state first and skips what is already done):
 *
 *   §1.1  ai-planner targeting: route on `complexity`, not `tier`
 *         (complex → Sonnet 5; diamond + complex → Opus 5; fallthrough Haiku 4.5)
 *   §1.2  rename the ai-planner variation `gemini-latest` → `claude-haiku-4-5`
 *   §2.2  judge attachments: ai-planner-judge + relevance at 100%, toxicity
 *         sampled at 10%, on every ai-planner variation; ai-planner-judge +
 *         relevance on the agent COMPOSE node so agent-mode judging is LD
 *         config too; delete the leftover `relevance/sonnet-4-5` variation
 *   §2.3  judges on Haiku 4.5 (a 0–1 score does not need a frontier model);
 *         ai-planner-judge's template moved to LD's reserved judge variable
 *         names {{message_history}} / {{response_to_evaluate}} so the SDK's
 *         own judge runner can fill it
 *   §3.1  metrics for the custom events the code already fires
 *         (ai-planner-agent-turn, -specialists, -tool-calls, -judge-retry)
 *         plus numeric metrics on $ld:ai:judge:accuracy / :relevance for the
 *         AI experiment in §6.1
 *   §5.2  get_weather_forecast tool v2: batch `locations` array
 *   §5.4  ai-planner-agent PLAN output schema (structured output)
 *   §5.5  explicit max_tokens on every agent-mode variation
 *   §6.1  experiment "AI Planner Model Quality" on ai-planner (Haiku vs Sonnet)
 *   §6.2  ai-planner variation `bad-prompt` for the daily guarded-rollout
 *         AI incident (see traffic-conductor.js)
 *   §6.3  remove the hardcoded specialist roster from the supervisor's
 *         instructions (the graph is the roster)
 *   §6.4  compose node: drop the complexity rule (Sonnet 5 always)
 *   §6.5  ai-planner-graph: second variation (weather + budget only) for
 *         `tier in [silver, beta]`
 *
 * Safe to run repeatedly. Requires LD_API_TOKEN (Writer on ToggleTravel).
 *
 *   node scripts/ld-ai-planner-setup.js              # apply
 *   node scripts/ld-ai-planner-setup.js --dry-run    # print what would change
 *   node scripts/ld-ai-planner-setup.js --only 1.1,2.2
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const LD_BASE     = process.env.LD_API_BASE || 'https://app.launchdarkly.com';
const LD_TOKEN    = process.env.LD_API_TOKEN || null;
const PROJECT_KEY = process.env.LD_PROJECT_KEY || 'ToggleTravel';
const ENV_KEY     = process.env.LD_ENV_KEY || 'launch-darkly';
const MAINTAINER_ID = process.env.LD_MAINTAINER_ID || '6972901ae8e06b09c457081d';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i !== -1 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(',')) : null;
})();

const PLANNER_KEY   = 'ai-planner';
const HAIKU_MODEL   = 'Anthropic.claude-haiku-4-5-20251001';
const SONNET_MODEL  = 'Anthropic.claude-sonnet-5';
const OPUS_MODEL    = 'Anthropic.claude-opus-5';

function stamp() { return new Date().toISOString(); }
const defaultLog = (m) => process.stdout.write(`[ld-ai-setup ${stamp()}] ${m}\n`);

const failures = [];

async function ld(method, pathname, { body, semanticPatch = false, beta = false } = {}) {
  const mutating = method !== 'GET';
  if (DRY_RUN && mutating) {
    defaultLog(`DRY-RUN ${method} ${pathname}${body ? ' ' + JSON.stringify(body).slice(0, 400) : ''}`);
    return {};
  }
  const res = await fetch(`${LD_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: LD_TOKEN,
      'Content-Type': semanticPatch
        ? 'application/json; domain-model=launchdarkly.semanticpatch'
        : 'application/json',
      ...(beta ? { 'LD-API-Version': 'beta' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(`${method} ${pathname} → HTTP ${res.status}${data ? ' ' + JSON.stringify(data).slice(0, 300) : ''}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Every section is independent: a failure is recorded and the run continues.
async function section(id, title, log, fn) {
  if (ONLY && !ONLY.has(id)) return;
  log(`§${id} ${title}…`);
  try {
    await fn(log);
  } catch (err) {
    failures.push(`§${id} ${title}: ${err.message}`);
    log(`  ✗ ${err.message}`);
  }
}

const flagUrl = (key) => `/api/v2/flags/${PROJECT_KEY}/${key}?env=${ENV_KEY}`;
const aiConfigUrl = (key) => `/api/v2/projects/${PROJECT_KEY}/ai-configs/${key}`;
const variationUrl = (cfg, v) => `${aiConfigUrl(cfg)}/variations/${encodeURIComponent(v)}`;

// The backing flag of an AI Config — the stable flags API returns the rules
// (variation indices are offset by one: index 0 is LD's implicit "disabled")
// and each variation's `_ldMeta.variationKey`, which the AI Config API's
// targeting GET does not.
async function getBackingFlag(key) {
  const flag = await ld('GET', flagUrl(key));
  const env = flag.environments?.[ENV_KEY] || {};
  const byVariationKey = {};
  flag.variations.forEach((v, idx) => {
    const vk = v.value?._ldMeta?.variationKey;
    if (vk) byVariationKey[vk] = { id: v._id, index: idx, name: v.name, value: v.value };
  });
  return { flag, env, rules: env.rules || [], fallthrough: env.fallthrough, byVariationKey };
}

function aiTargetingPatch(cfgKey, instructions, comment) {
  return ld('PATCH', `${aiConfigUrl(cfgKey)}/targeting`, {
    semanticPatch: true,
    beta: true,
    body: { environmentKey: ENV_KEY, comment, instructions },
  });
}

async function getAiConfig(key) {
  return ld('GET', aiConfigUrl(key), { beta: true });
}

function patchVariation(cfgKey, variationKey, body) {
  return ld('PATCH', variationUrl(cfgKey, variationKey), { beta: true, body });
}

// ── §3.1 metrics ─────────────────────────────────────────────────────────────

async function ensureMetric(log, { key, name, eventKey, description, numeric = false, success = 'HigherThanBaseline', unit }) {
  try {
    await ld('POST', `/api/v2/metrics/${PROJECT_KEY}`, {
      body: {
        key, name, description, eventKey,
        kind: 'custom',
        isNumeric: numeric,
        ...(numeric ? { unit: unit || 'count' } : {}),
        successCriteria: success,
        randomizationUnits: ['user'],
        tags: ['toggletravel-demo', 'ai-planner'],
      },
    });
    log(`  created metric ${key}`);
  } catch (err) {
    if (err.status === 409) log(`  metric ${key} already exists`);
    else throw err;
  }
}

const METRICS = [
  { key: 'ai-planner-agent-turn', name: 'AI Planner — agent turns', eventKey: 'ai-planner-agent-turn',
    description: 'One agent-mode turn completed (supervisor PLAN → specialists → COMPOSE).' },
  { key: 'ai-planner-agent-specialists', name: 'AI Planner — specialists per agent turn', eventKey: 'ai-planner-agent-specialists',
    numeric: true, unit: 'specialists', success: 'LowerThanBaseline',
    description: 'How many specialist agents the supervisor consulted on a turn. Lower = cheaper turn.' },
  { key: 'ai-planner-agent-tool-calls', name: 'AI Planner — tool calls per agent turn', eventKey: 'ai-planner-agent-tool-calls',
    numeric: true, unit: 'calls', success: 'LowerThanBaseline',
    description: 'Total tool calls across all specialists on one agent-mode turn. Lower = cheaper, faster turn.' },
  { key: 'ai-planner-judge-retry', name: 'AI Planner — judge-triggered retries', eventKey: 'ai-planner-judge-retry',
    success: 'LowerThanBaseline',
    description: 'The accuracy judge failed a cheap-model draft and the turn was re-asked on the strong model.' },
  // Numeric metrics on the AI SDK judge events, for the AI experiment (§6.1) and
  // the AI guarded rollout (§6.2). The SDK emits the score (0–1) as the value.
  { key: 'ai-judge-accuracy', name: 'AI judge — accuracy score', eventKey: '$ld:ai:judge:accuracy',
    numeric: true, unit: 'score',
    description: 'Accuracy judge score (0–1) recorded against the answering AI Config run. Higher is better.' },
  { key: 'ai-judge-relevance', name: 'AI judge — relevance score', eventKey: '$ld:ai:judge:relevance',
    numeric: true, unit: 'score',
    description: 'Relevance judge score (0–1) — on-topic, in-role, not hijacked by a prompt injection. Higher is better.' },
];

// ── §1.1 routing on complexity ────────────────────────────────────────────────

async function routeOnComplexity(log) {
  const { rules, byVariationKey } = await getBackingFlag(PLANNER_KEY);
  const hasComplexityRule = rules.some((r) => r.clauses.some((c) => c.attribute === 'complexity'));
  if (hasComplexityRule) return log('  ai-planner already routes on complexity — leaving as-is');

  const haiku  = byVariationKey['claude-haiku-4-5'] || byVariationKey['gemini-latest'];
  const sonnet = byVariationKey['claude-sonnet-latest'];
  const opus   = byVariationKey['claude-opus-5'];
  if (!haiku || !sonnet || !opus) throw new Error(`ai-planner variations not found: ${Object.keys(byVariationKey).join(', ')}`);

  const instructions = [
    // Drop every tier rule: tier drives tone via {{product_tier}}, not the model.
    ...rules.filter((r) => r.clauses.some((c) => c.attribute === 'tier')).map((r) => ({ kind: 'removeRule', ruleId: r._id || r.id })),
    {
      kind: 'addRule',
      description: 'Diamond + complex → Opus 5 (compound targeting)',
      variationId: opus.id,
      clauses: [
        { contextKind: 'user', attribute: 'tier', op: 'in', values: ['diamond'], negate: false },
        { contextKind: 'user', attribute: 'complexity', op: 'in', values: ['complex'], negate: false },
      ],
    },
    {
      kind: 'addRule',
      description: 'complex → Sonnet 5 (classifier verdict)',
      variationId: sonnet.id,
      clauses: [{ contextKind: 'user', attribute: 'complexity', op: 'in', values: ['complex'], negate: false }],
    },
    { kind: 'updateFallthroughVariationOrRollout', variationId: haiku.id },
  ];
  await aiTargetingPatch(PLANNER_KEY, instructions,
    'AI Planner review §1.1 (Option A): route on complexity, personalize on tier. complex → Sonnet 5; diamond+complex → Opus 5; fallthrough Haiku 4.5.');
  log('  ai-planner now routes on complexity (fallthrough Haiku 4.5)');
}

// ── §1.2 rename gemini-latest ────────────────────────────────────────────────

async function renameHaikuVariation(log) {
  const cfg = await getAiConfig(PLANNER_KEY);
  const stale = cfg.variations.find((v) => v.key === 'gemini-latest');
  if (!stale) return log('  no `gemini-latest` variation — already renamed');
  await patchVariation(PLANNER_KEY, 'gemini-latest', {
    key: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    comment: 'AI Planner review §1.2: the variation key said gemini-latest but serves Claude Haiku 4.5',
  });
  log('  renamed ai-planner variation gemini-latest → claude-haiku-4-5');
}

// ── §2.2 / §2.3 judges ───────────────────────────────────────────────────────

const PLANNER_JUDGES = [
  { judgeConfigKey: 'ai-planner-judge', samplingRate: 1 },   // travel-specific accuracy rubric (retry gate)
  { judgeConfigKey: 'relevance', samplingRate: 1 },          // scope / prompt-injection gate
  { judgeConfigKey: 'toxicity', samplingRate: 0.1 },         // safety sampling — the LD cost lever
];
const COMPOSE_JUDGES = [
  { judgeConfigKey: 'ai-planner-judge', samplingRate: 1 },
  { judgeConfigKey: 'relevance', samplingRate: 1 },
];

function sameJudges(a = [], b = []) {
  const norm = (list) => list.map((j) => `${j.judgeConfigKey || j.key}:${j.samplingRate}`).sort().join('|');
  return norm(a) === norm(b);
}

async function attachJudges(log, cfgKey, judges, comment) {
  const cfg = await getAiConfig(cfgKey);
  for (const v of cfg.variations) {
    if (sameJudges(v.judgeConfiguration?.judges, judges)) { log(`  ${cfgKey}/${v.key}: judges already attached`); continue; }
    await patchVariation(cfgKey, v.key, { judgeConfiguration: { judges }, comment });
    log(`  ${cfgKey}/${v.key}: attached ${judges.map((j) => `${j.judgeConfigKey}@${j.samplingRate}`).join(', ')}`);
  }
}

const ACCURACY_JUDGE_MESSAGES = [
  {
    role: 'system',
    content: [
      "You are a strict quality judge for Toggle Travel's AI travel assistant. Score the ASSISTANT RESPONSE to the USER QUESTION between 0.0 and 1.0.",
      '',
      'Score LOW (below 0.5) if the response states, estimates, or implies specific live data it cannot verify — airfares, seat availability, flight status, refund amounts, or baggage fees. Guessed numbers presented as fact are failures.',
      '',
      'Score HIGH (0.8 or above) if the response either cites verified data present in the conversation, or clearly declines to assert unverifiable specifics. A response that says it cannot check fares or flight status, and explains why, is CORRECT and scores high — refusing to invent data is the desired behavior, not a failure.',
      '',
      'Respond ONLY with raw JSON: {"score": <0.0-1.0>, "reasoning": "<one sentence>"}',
    ].join('\n'),
  },
  {
    role: 'user',
    // LD's reserved judge variable names, so the AI SDK's own judge runner
    // (which supplies exactly these two) can fill the template.
    content: 'USER QUESTION / CONTEXT:\n{{message_history}}\n\nASSISTANT RESPONSE:\n{{response_to_evaluate}}\n\nReturn the verdict JSON now.',
  },
];

async function retuneJudges(log) {
  // ai-planner-judge → Haiku 4.5, reserved template names.
  const judge = await getAiConfig('ai-planner-judge');
  for (const v of judge.variations) {
    const usesReserved = (v.messages || []).some((m) => m.content.includes('{{response_to_evaluate}}'));
    if (v.modelConfigKey === HAIKU_MODEL && usesReserved) { log(`  ai-planner-judge/${v.key}: already Haiku + reserved template`); continue; }
    await patchVariation('ai-planner-judge', v.key, {
      modelConfigKey: HAIKU_MODEL,
      messages: ACCURACY_JUDGE_MESSAGES,
      comment: 'AI Planner review §2.3: judge on Haiku 4.5 (cheaper than the answer it grades); §4.1: LD reserved judge variable names',
    });
    log(`  ai-planner-judge/${v.key}: → Haiku 4.5, template on {{message_history}}/{{response_to_evaluate}}`);
  }
  // relevance/default → Haiku 4.5; drop the leftover placeholder variation.
  const relevance = await getAiConfig('relevance');
  for (const v of relevance.variations) {
    if (v.key === 'sonnet-4-5' && /REPLACE WITH CRITERIA/.test(v.messages?.[0]?.content || '')) {
      await ld('DELETE', variationUrl('relevance', v.key), { beta: true });
      log('  relevance/sonnet-4-5: deleted (placeholder rubric "[REPLACE WITH CRITERIA]")');
      continue;
    }
    if (v.modelConfigKey === HAIKU_MODEL) { log(`  relevance/${v.key}: already Haiku 4.5`); continue; }
    await patchVariation('relevance', v.key, { modelConfigKey: HAIKU_MODEL, comment: 'AI Planner review §2.3: judge on Haiku 4.5' });
    log(`  relevance/${v.key}: → Haiku 4.5`);
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function run(log = defaultLog) {
  if (!LD_TOKEN) { log('LD_API_TOKEN not set — skipping AI Planner LD setup'); return { failures: ['LD_API_TOKEN not set'] }; }
  if (DRY_RUN) log('DRY RUN — no writes');

  await section('3.1', 'metrics for AI Planner custom events + judge scores', log, async () => {
    for (const m of METRICS) await ensureMetric(log, m);
  });
  await section('1.1', 'ai-planner routes on complexity', log, routeOnComplexity);
  await section('1.2', 'rename ai-planner variation gemini-latest → claude-haiku-4-5', log, renameHaikuVariation);
  await section('2.3', 'judges on Haiku 4.5, reserved template names, delete placeholder variation', log, retuneJudges);
  await section('2.2', 'attach judges in LD (ai-planner + agent compose)', log, async () => {
    await attachJudges(log, PLANNER_KEY, PLANNER_JUDGES,
      'AI Planner review §2.2: travel-specific accuracy judge + relevance at 100%, toxicity sampled at 10%');
    await attachJudges(log, 'ai-planner-agent-compose', COMPOSE_JUDGES,
      'AI Planner review §5.7: judge the composed answer through LD config so the sample rate is an LD knob');
  });

  // Later sections are appended below as the review's steps 4–6 land.
  for (const extra of EXTRA_SECTIONS) await extra(log);

  if (failures.length) {
    log(`done with ${failures.length} failure(s):`);
    failures.forEach((f) => log(`  - ${f}`));
  } else {
    log('done — all sections applied or already in place.');
  }
  return { failures };
}

// Registered by the step-4/6 sections further down this file.
const EXTRA_SECTIONS = [];

module.exports = { run, section, ld, getAiConfig, getBackingFlag, patchVariation, aiTargetingPatch, EXTRA_SECTIONS, PROJECT_KEY, ENV_KEY, MAINTAINER_ID, HAIKU_MODEL, SONNET_MODEL, OPUS_MODEL, PLANNER_KEY };

if (require.main === module) {
  run().then(({ failures: f }) => process.exit(f.length ? 1 : 0))
    .catch((err) => { process.stderr.write(`ld-ai-setup FAILED: ${err.message}\n`); process.exit(1); });
}
