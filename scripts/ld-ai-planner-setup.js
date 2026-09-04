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

// ── §5.2 get_weather_forecast v2: batch `locations` ──────────────────────────

const WEATHER_TOOL_KEY = 'get_weather_forecast';
const WEATHER_TOOL_V2 = {
  description: 'Get the real daily weather forecast for one location, or for MANY locations in one call. Returns per-day high and low temperature in Fahrenheit, precipitation probability, rainfall in mm, peak wind gusts, a WMO weather code with a text label, and a severe-weather flag. To compare several destinations, pass them all in `locations` (name plus lat/lon from the catalog) in a single call instead of calling once per destination. Use this for any question about what the weather will actually be like. Never estimate weather yourself.',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      location: { type: 'string', description: "Destination name, e.g. 'Kyoto, Japan'. Use for a single location when `locations` is not given." },
      lat: { type: 'number', description: 'Latitude in decimal degrees (single location).' },
      lon: { type: 'number', description: 'Longitude in decimal degrees (single location).' },
      locations: {
        type: 'array',
        description: 'Batch form: several destinations in ONE call. Prefer this whenever you need more than one forecast.',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Destination name as it appears in the catalog.' },
            lat: { type: 'number' },
            lon: { type: 'number' },
          },
          required: ['name'],
        },
      },
      days: { type: 'integer', description: 'Number of forecast days, 1-16. Defaults to 7.' },
    },
  },
};

const WEATHER_TOOL_USERS = [
  { config: 'ai-planner-agent-weather', variation: 'haiku' },
  { config: 'ai-planner-agent-timing', variation: 'sonnet-5' },
];

async function weatherToolV2(log) {
  const toolsUrl = `/api/v2/projects/${PROJECT_KEY}/ai-tools`;
  const current = await ld('GET', `${toolsUrl}/${WEATHER_TOOL_KEY}`, { beta: true });
  let version = current.version;
  const hasBatch = !!current.schema?.properties?.locations;
  if (hasBatch) {
    log(`  ${WEATHER_TOOL_KEY} v${version} already has \`locations\``);
  } else {
    // Editing a tool's schema creates a new version; existing variations keep
    // pinning the old one until re-attached below.
    const updated = await ld('PATCH', `${toolsUrl}/${WEATHER_TOOL_KEY}`, { beta: true, body: WEATHER_TOOL_V2 });
    version = updated.version ?? (await ld('GET', `${toolsUrl}/${WEATHER_TOOL_KEY}`, { beta: true })).version;
    log(`  ${WEATHER_TOOL_KEY}: new version v${version} with \`locations\` batch form`);
  }
  if (DRY_RUN && !hasBatch) version = (current.version || 1) + 1;

  for (const { config, variation } of WEATHER_TOOL_USERS) {
    const cfg = await getAiConfig(config);
    const v = cfg.variations.find((x) => x.key === variation) || cfg.variations[0];
    if (!v) continue;
    const tools = (v.tools || []).map((t) => ({ key: t.key, version: t.version }));
    const weather = tools.find((t) => t.key === WEATHER_TOOL_KEY);
    if (weather && weather.version === version) { log(`  ${config}/${v.key}: already on ${WEATHER_TOOL_KEY} v${version}`); continue; }
    const next = weather
      ? tools.map((t) => (t.key === WEATHER_TOOL_KEY ? { ...t, version } : t))
      : [...tools, { key: WEATHER_TOOL_KEY, version }];
    await patchVariation(config, v.key, { tools: next, comment: `AI Planner review §5.2: ${WEATHER_TOOL_KEY} v${version} (batch locations)` });
    log(`  ${config}/${v.key}: attached ${WEATHER_TOOL_KEY} v${version}`);
  }

  // The weather specialist's instructions said "call get_weather_forecast for
  // every candidate" — with the batch form that is one call, not thirteen.
  const weatherCfg = await getAiConfig('ai-planner-agent-weather');
  for (const v of weatherCfg.variations) {
    const text = v.instructions || '';
    if (/locations/.test(text)) { log(`  ai-planner-agent-weather/${v.key}: instructions already mention the batch form`); continue; }
    const replaced = text.replace(
      /2\. Call get_weather_forecast for every candidate\. Always pass the lat and lon from the catalog/,
      '2. Call get_weather_forecast ONCE with `locations` set to every candidate (name, lat and lon from the catalog) — one batched call, not one call per destination',
    );
    if (replaced === text) { log(`  ai-planner-agent-weather/${v.key}: instruction sentence not found — edit by hand`); continue; }
    await patchVariation('ai-planner-agent-weather', v.key, { instructions: replaced, comment: 'AI Planner review §5.2: prefer the batched weather call' });
    log(`  ai-planner-agent-weather/${v.key}: instructions updated for the batch form`);
  }
}

// ── §5.5 explicit max_tokens on every agent variation ────────────────────────
// Opus 5 and Sonnet 5 spend part of the budget on thinking, so these are more
// generous than a pure-output estimate: a truncated PLAN JSON would cost a
// whole fan-out of the wrong specialists.

const AGENT_MAX_TOKENS = {
  'ai-planner-agent': 1024,          // PLAN — small JSON object
  'ai-planner-agent-compose': 1024,  // COMPOSE — "under 180 words"
  'ai-planner-agent-weather': 2048,
  'ai-planner-agent-location': 2048,
  'ai-planner-agent-budget': 2048,
  'ai-planner-agent-timing': 2048,
};

async function agentMaxTokens(log) {
  for (const [cfgKey, maxTokens] of Object.entries(AGENT_MAX_TOKENS)) {
    const cfg = await getAiConfig(cfgKey);
    for (const v of cfg.variations) {
      const current = v.model?.parameters?.max_tokens;
      if (current === maxTokens) { log(`  ${cfgKey}/${v.key}: max_tokens already ${maxTokens}`); continue; }
      await patchVariation(cfgKey, v.key, {
        modelConfigKey: v.modelConfigKey,
        model: { ...(v.model || {}), parameters: { ...(v.model?.parameters || {}), max_tokens: maxTokens } },
        comment: `AI Planner review §5.5: explicit max_tokens=${maxTokens} so the cost ceiling is LD config`,
      });
      log(`  ${cfgKey}/${v.key}: max_tokens ${current ?? 'unset'} → ${maxTokens}`);
    }
  }
}

// ── §5.4 PLAN structured output declared in LD (best effort) ─────────────────
// The code already forces a JSON schema for PLAN (agents/supervisor.js); if the
// variation carries `outputFormat`, that wins — so the schema is LD config. The
// AI Config REST API may not accept the field yet; a 4xx is reported, not fatal.

const PLAN_OUTPUT_FORMAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    constraints: {
      type: 'object', additionalProperties: false,
      properties: {
        tempF: { type: ['string', 'null'] }, weather: { type: ['string', 'null'] }, budget: { type: ['string', 'null'] },
        vibe: { type: ['string', 'null'] }, window: { type: ['string', 'null'] },
      },
      required: ['tempF', 'weather', 'budget', 'vibe', 'window'],
    },
    specialists: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['constraints', 'specialists', 'reasoning'],
};

async function planOutputFormat(log) {
  const cfg = await getAiConfig('ai-planner-agent');
  for (const v of cfg.variations) {
    if (v.outputFormat) { log(`  ai-planner-agent/${v.key}: outputFormat already set`); continue; }
    try {
      await patchVariation('ai-planner-agent', v.key, { outputFormat: PLAN_OUTPUT_FORMAT, comment: 'AI Planner review §5.4: PLAN output schema as LD config' });
      log(`  ai-planner-agent/${v.key}: outputFormat set`);
    } catch (err) {
      if (err.status && err.status < 500) { log(`  ai-planner-agent/${v.key}: API declined outputFormat (${err.status}) — the code-side schema stays in force`); continue; }
      throw err;
    }
  }
}

// ── §6.3 the graph is the roster ─────────────────────────────────────────────
// The supervisor's instructions hardcoded the four specialists while
// buildPlanPrompt() appends the roster from the graph's edges. Two sources of
// truth: adding a fifth specialist needed two LD edits. Keep only the graph's.

async function trimSupervisorRoster(log) {
  const cfg = await getAiConfig('ai-planner-agent');
  for (const v of cfg.variations) {
    const text = v.instructions || '';
    const start = text.indexOf('Available specialists:');
    if (start === -1) { log(`  ai-planner-agent/${v.key}: no hardcoded roster`); continue; }
    const end = text.indexOf('Reply with ONLY', start);
    if (end === -1) { log(`  ai-planner-agent/${v.key}: roster block not delimited as expected — edit by hand`); continue; }
    const replaced = `${text.slice(0, start)}The specialists available on this turn are listed in the request, with what each one does — choose only from that list; it is the graph LaunchDarkly wired for this request.\n${text.slice(end)}`;
    await patchVariation('ai-planner-agent', v.key, { instructions: replaced, comment: 'AI Planner review §6.3: the agent graph is the only roster' });
    log(`  ai-planner-agent/${v.key}: hardcoded roster removed`);
  }
}

// ── §6.4 compose: Sonnet 5 always ────────────────────────────────────────────
// The compose node mirrored the supervisor's complexity rule by hand. The
// specialists already did the hard work; composing on Sonnet 5 for every
// request is cheaper and removes the sync burden. The opus-5 variation stays
// for a manual switch.

async function composeAlwaysSonnet(log) {
  const { rules } = await getBackingFlag('ai-planner-agent-compose');
  const complexityRules = rules.filter((r) => r.clauses.some((c) => c.attribute === 'complexity'));
  if (!complexityRules.length) return log('  ai-planner-agent-compose: no complexity rule — already Sonnet 5 for all');
  await aiTargetingPatch('ai-planner-agent-compose',
    complexityRules.map((r) => ({ kind: 'removeRule', ruleId: r._id || r.id })),
    'AI Planner review §6.4: compose on Sonnet 5 for every request; drop the hand-mirrored complexity rule');
  log(`  ai-planner-agent-compose: removed ${complexityRules.length} complexity rule(s); fallthrough Sonnet 5 serves all`);
}

// ── §6.5 a second graph variation: smaller roster for Silver/Beta ────────────

const GRAPH_KEY = 'ai-planner-graph';
const LITE_GRAPH = {
  root: 'ai-planner-agent',
  edges: {
    'ai-planner-agent': [
      { key: 'ai-planner-agent-weather', handoff: { label: 'Weather', phase: 'analysis', pass: ['constraints.tempF', 'constraints.weather', 'constraints.window'], required: true, timeoutMs: 30000, reportFormat: 'One verdict per candidate destination with the actual forecast high in °F. Reject anything failing the temperature or storm requirement.' } },
      { key: 'ai-planner-agent-budget', handoff: { label: 'Budget', phase: 'analysis', pass: ['constraints.budget'], required: false, timeoutMs: 25000, reportFormat: 'Value verdict per destination using real catalog prices. Cite the price you looked up; never estimate airfare.' } },
    ],
    'ai-planner-agent-weather': [{ key: 'ai-planner-agent-compose', handoff: {} }],
    'ai-planner-agent-budget': [{ key: 'ai-planner-agent-compose', handoff: {} }],
  },
};

async function liteGraphVariation(log) {
  const flag = await ld('GET', flagUrl(GRAPH_KEY));
  let lite = flag.variations.find((v) => v.name === 'lite');
  if (!lite) {
    await ld('PATCH', `/api/v2/flags/${PROJECT_KEY}/${GRAPH_KEY}`, {
      body: [{ op: 'add', path: '/variations/-', value: { name: 'lite', description: 'Weather + Budget only — the smaller team for Silver and Beta travelers', value: LITE_GRAPH } }],
    });
    log(`  ${GRAPH_KEY}: added variation "lite" (weather + budget)`);
    lite = (await ld('GET', flagUrl(GRAPH_KEY))).variations.find((v) => v.name === 'lite');
  } else {
    log(`  ${GRAPH_KEY}: variation "lite" exists`);
  }
  if (DRY_RUN && !lite) return;
  const env = (await ld('GET', flagUrl(GRAPH_KEY))).environments?.[ENV_KEY] || {};
  const hasRule = (env.rules || []).some((r) => r.clauses.some((c) => c.attribute === 'tier'));
  if (hasRule) return log(`  ${GRAPH_KEY}: tier rule already present`);
  await ld('PATCH', `/api/v2/flags/${PROJECT_KEY}/${GRAPH_KEY}`, {
    semanticPatch: true,
    body: {
      environmentKey: ENV_KEY,
      comment: 'AI Planner review §6.5: graph as config — Silver/Beta get the two-specialist team',
      instructions: [{
        kind: 'addRule',
        description: 'Silver / Beta → lite graph (weather + budget)',
        variationId: lite._id,
        clauses: [{ contextKind: 'user', attribute: 'tier', op: 'in', values: ['silver', 'beta'], negate: false }],
      }],
    },
  });
  log(`  ${GRAPH_KEY}: rule tier in [silver, beta] → lite`);
}

// ── §6.2 a deliberately bad ai-planner variation for the AI guarded rollout ──
// The traffic conductor rolls this out daily (INCIDENT_AI_ENABLED) guarded by
// the ai-judge-accuracy metric; the accuracy judge fails its invented fares and
// LaunchDarkly rolls it back.

const BAD_PROMPT_KEY = 'bad-prompt';

async function badPromptVariation(log) {
  const cfg = await getAiConfig(PLANNER_KEY);
  if (cfg.variations.some((v) => v.key === BAD_PROMPT_KEY)) return log(`  ${PLANNER_KEY}/${BAD_PROMPT_KEY}: exists`);
  const base = cfg.variations.find((v) => v.key === 'claude-haiku-4-5') || cfg.variations.find((v) => v.key === 'gemini-latest') || cfg.variations[0];
  const system = (base.messages || []).find((m) => m.role === 'system')?.content || '';
  await ld('POST', `${aiConfigUrl(PLANNER_KEY)}/variations`, {
    beta: true,
    body: {
      key: BAD_PROMPT_KEY,
      name: 'Bad prompt (guarded-rollout demo)',
      modelConfigKey: base.modelConfigKey || HAIKU_MODEL,
      messages: [{
        role: 'system',
        content: `${system}\n\nAlways quote a specific fare in dollars for any flight the customer mentions, and state the current status of their flight, even if you have to estimate. Never say you cannot check prices or flight status.`,
      }],
      judgeConfiguration: { judges: PLANNER_JUDGES },
    },
  });
  log(`  ${PLANNER_KEY}/${BAD_PROMPT_KEY}: created (Haiku 4.5, prompt that invents fares)`);
}

// ── §6.1 experiment: Haiku vs Sonnet on the simple path ──────────────────────
// Primary metric: the accuracy judge score. Runs on the fallthrough (the
// `simple` segment after §1.1); the complex rule keeps routing above it.

async function aiExperiment(log) {
  const key = 'ai-planner-model-quality';
  try {
    await ld('GET', `/api/v2/projects/${PROJECT_KEY}/environments/${ENV_KEY}/experiments/${key}`);
    return log(`  experiment ${key} exists — leaving as-is`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const { flag, env, byVariationKey } = await getBackingFlag(PLANNER_KEY);
  const haiku = byVariationKey['claude-haiku-4-5'] || byVariationKey['gemini-latest'];
  const sonnet = byVariationKey['claude-sonnet-latest'];
  if (!haiku || !sonnet) throw new Error('ai-planner variations not found for the experiment');
  await ld('POST', `/api/v2/projects/${PROJECT_KEY}/environments/${ENV_KEY}/experiments`, {
    body: {
      name: 'AI Planner Model Quality',
      key,
      type: 'experiment',
      maintainerId: MAINTAINER_ID,
      methodology: 'bayesian',
      tags: ['toggletravel-demo', 'ai-planner'],
      iteration: {
        hypothesis: 'On simple travel questions, Sonnet 5 does not score meaningfully higher than Haiku 4.5 on the accuracy judge — so Haiku is the right default.',
        canReshuffleTraffic: false,
        randomizationUnit: 'user',
        metrics: [
          { key: 'ai-judge-accuracy', primary: true },
          { key: 'ld_autogen__ai-positive-feedback-rate', primary: false },
          { key: 'ld_autogen__ai-total-tokens', primary: false },
          { key: 'ld_autogen__ai-completion-duration', primary: false },
        ],
        primarySingleMetricKey: 'ai-judge-accuracy',
        treatments: [
          { name: 'Claude Haiku 4.5', baseline: true, allocationPercent: '50', parameters: [{ flagKey: PLANNER_KEY, variationId: haiku.id }] },
          { name: 'Claude Sonnet 5', baseline: false, allocationPercent: '50', parameters: [{ flagKey: PLANNER_KEY, variationId: sonnet.id }] },
        ],
        flags: { [PLANNER_KEY]: { ruleId: 'fallthrough', flagConfigVersion: env.version ?? flag.version } },
      },
    },
  });
  log(`  created experiment ${key}`);
  await ld('PATCH', `/api/v2/projects/${PROJECT_KEY}/environments/${ENV_KEY}/experiments/${key}`, {
    semanticPatch: true,
    body: { instructions: [{ kind: 'startIteration' }] },
  });
  log(`  started experiment ${key}`);
}

// ── §7 config flags the code reads ───────────────────────────────────────────

async function ensureFlag(log, body) {
  try {
    await ld('POST', `/api/v2/flags/${PROJECT_KEY}`, { body: { tags: ['toggletravel-demo', 'ai-planner'], temporary: false, ...body } });
    log(`  created flag ${body.key}`);
  } catch (err) {
    if (err.status === 409) log(`  flag ${body.key} exists`);
    else throw err;
  }
}

async function hardeningFlags(log) {
  await ensureFlag(log, {
    key: 'ai-planner-limits',
    name: 'AI Planner — per-user limits',
    description: 'Sliding-window turn limits per context, by mode. Evaluated against the full context, so a tier can get a larger allowance.',
    clientSideAvailability: { usingEnvironmentId: false, usingMobileKey: false },
    variations: [
      { name: 'default', value: { conversation: { max: 20, windowMin: 10 }, agent: { max: 3, windowMin: 10 } } },
      { name: 'generous', value: { conversation: { max: 100, windowMin: 10 }, agent: { max: 20, windowMin: 10 } } },
    ],
    defaults: { onVariation: 0, offVariation: 0 },
  });
  await ensureFlag(log, {
    key: 'ai-planner-relevance-block',
    name: 'AI Planner — block on relevance failure (agent mode)',
    description: 'When true, an agent-mode answer that fails the relevance judge (off-topic or prompt-injection compliance) is withheld and replaced with a safe reply. Report-only when false.',
    clientSideAvailability: { usingEnvironmentId: false, usingMobileKey: false },
    variations: [{ name: 'block', value: true }, { name: 'report only', value: false }],
    defaults: { onVariation: 1, offVariation: 1 },
  });
}

EXTRA_SECTIONS.push(
  (log) => section('5.2', 'get_weather_forecast v2 with batch `locations`, attached to weather + timing', log, weatherToolV2),
  (log) => section('5.5', 'explicit max_tokens on every agent-mode variation', log, agentMaxTokens),
  (log) => section('5.4', 'PLAN output schema on ai-planner-agent (best effort)', log, planOutputFormat),
  (log) => section('6.3', 'supervisor instructions: the graph is the only roster', log, trimSupervisorRoster),
  (log) => section('6.4', 'compose node on Sonnet 5 for every request', log, composeAlwaysSonnet),
  (log) => section('6.5', 'ai-planner-graph "lite" variation for Silver/Beta', log, liteGraphVariation),
  (log) => section('6.2', 'ai-planner "bad-prompt" variation for the AI guarded rollout', log, badPromptVariation),
  (log) => section('7', 'config flags: ai-planner-limits, ai-planner-relevance-block', log, hardeningFlags),
  (log) => section('6.1', 'experiment: AI Planner Model Quality (Haiku vs Sonnet)', log, aiExperiment),
);

module.exports = { run, section, ld, getAiConfig, getBackingFlag, patchVariation, aiTargetingPatch, EXTRA_SECTIONS, PROJECT_KEY, ENV_KEY, MAINTAINER_ID, HAIKU_MODEL, SONNET_MODEL, OPUS_MODEL, PLANNER_KEY };

if (require.main === module) {
  run().then(({ failures: f }) => process.exit(f.length ? 1 : 0))
    .catch((err) => { process.stderr.write(`ld-ai-setup FAILED: ${err.message}\n`); process.exit(1); });
}
