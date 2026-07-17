'use strict';

/**
 * One-time (idempotent) LaunchDarkly Experimentation + Multi-Armed Bandit setup
 * for ToggleTravel. Creates:
 *
 *   Metrics (higher = better, unit = user):
 *     - booking-conversion   (event: confirm-booking)
 *     - promo-click          (event: promo-click)
 *     - destination-view     (event: destination-view)
 *
 *   Flag:
 *     - search-ranking       (multivariate: recommended / price-low / price-high / trending)
 *
 *   Experiment (type=experiment) on promo-banner-text:
 *     "Promo Banner Messaging" — which promo drives the most bookings.
 *     primary = booking-conversion, secondary = promo-click.
 *
 *   Multi-armed bandit (type=mab) on search-ranking:
 *     "Search Ranking Optimizer" — auto-shift to the sort that maximizes
 *     destination-view; reallocates hourly.
 *
 * Safe to run repeatedly: every create tolerates "already exists". Never
 * restarts a running experiment/MAB. Requires LD_API_TOKEN (Writer).
 *
 * Run standalone:  node scripts/ld-experiment-setup.js
 * Or import:       require('./ld-experiment-setup').run(log)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const LD_BASE     = process.env.LD_API_BASE || 'https://app.launchdarkly.com';
const LD_TOKEN    = process.env.LD_API_TOKEN || null;
const PROJECT_KEY = process.env.LD_PROJECT_KEY || 'ToggleTravel';
const ENV_KEY     = process.env.LD_ENV_KEY || 'launch-darkly';

const PROMO_FLAG  = 'promo-banner-text';
const RANK_FLAG   = 'search-ranking';
// Experiments require a maintainerId; the service token has no member, so
// attribute to the project owner. Override via LD_MAINTAINER_ID if needed.
const MAINTAINER_ID = process.env.LD_MAINTAINER_ID || '6972901ae8e06b09c457081d';

function stamp() { return new Date().toISOString(); }

async function ld(method, pathname, { body, semanticPatch = false } = {}) {
  const res = await fetch(`${LD_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: LD_TOKEN,
      'Content-Type': semanticPatch
        ? 'application/json; domain-model=launchdarkly.semanticpatch'
        : 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data ? JSON.stringify(data) : `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

async function ensureMetric(log, { key, name, eventKey, description }) {
  try {
    await ld('POST', `/api/v2/metrics/${PROJECT_KEY}`, {
      body: {
        key, name, description,
        kind: 'custom',
        isNumeric: false,
        eventKey,
        successCriteria: 'HigherThanBaseline',
        randomizationUnits: ['user'],
        tags: ['toggletravel-demo', 'experimentation'],
      },
    });
    log(`  created metric ${key}`);
  } catch (err) {
    if (err.status === 409) log(`  metric ${key} already exists`);
    else throw err;
  }
}

// ── search-ranking flag ───────────────────────────────────────────────────────

async function ensureRankingFlag(log) {
  try {
    await ld('POST', `/api/v2/flags/${PROJECT_KEY}`, {
      body: {
        key: RANK_FLAG,
        name: 'Search Result Ranking',
        description: 'Sort order for destination search results. Optimized by the "Search Ranking Optimizer" multi-armed bandit toward the variation that maximizes destination views.',
        clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: true },
        variations: [
          { value: 'recommended', name: 'Recommended' },
          { value: 'price-low', name: 'Price: low to high' },
          { value: 'price-high', name: 'Price: high to low' },
          { value: 'trending', name: 'Trending' },
        ],
        defaults: { onVariation: 0, offVariation: 0 },
        tags: ['toggletravel-demo', 'experimentation'],
        temporary: false,
      },
    });
    log(`  created flag ${RANK_FLAG}`);
  } catch (err) {
    if (err.status === 409) log(`  flag ${RANK_FLAG} already exists`);
    else throw err;
  }
}

// Ensure the flag is ON (so an experiment/MAB can allocate across variations),
// then return { variationsByValue, version } for building treatments.
async function prepFlag(log, flagKey) {
  let flag = await ld('GET', `/api/v2/flags/${PROJECT_KEY}/${flagKey}?env=${ENV_KEY}`);
  if (!flag.environments?.[ENV_KEY]?.on) {
    await ld('PATCH', `/api/v2/flags/${PROJECT_KEY}/${flagKey}`, {
      semanticPatch: true,
      body: { environmentKey: ENV_KEY, comment: 'Experimentation setup: turn on for allocation', instructions: [{ kind: 'turnFlagOn' }] },
    });
    log(`  turned ${flagKey} ON`);
    flag = await ld('GET', `/api/v2/flags/${PROJECT_KEY}/${flagKey}?env=${ENV_KEY}`);
  }
  const byName = {};
  for (const v of flag.variations) if (v.name) byName[v.name] = v._id;
  return { byName, version: flag.environments[ENV_KEY].version };
}

// ── Experiment / MAB ──────────────────────────────────────────────────────────

async function experimentExists(key) {
  try {
    await ld('GET', `/api/v2/projects/${PROJECT_KEY}/environments/${ENV_KEY}/experiments/${key}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

async function createAndStart(log, { key, name, type, hypothesis, flagKey, treatments, metrics, primaryKey, reallocationFrequencyMillis }) {
  if (await experimentExists(key)) { log(`  ${type} ${key} already exists — leaving as-is`); return; }

  const { byName, version } = await prepFlag(log, flagKey);
  const treatmentInputs = treatments.map((t) => {
    const variationId = byName[t.name];
    if (!variationId) throw new Error(`${flagKey}: no variation named "${t.name}" to map treatment to`);
    return {
      name: t.name,
      baseline: !!t.baseline,
      allocationPercent: t.allocationPercent,
      parameters: [{ flagKey, variationId }],
    };
  });

  const iteration = {
    hypothesis,
    canReshuffleTraffic: type === 'mab', // bandits reallocate traffic; fixed for A/B experiments
    randomizationUnit: 'user',
    metrics: metrics.map((m) => ({ key: m.key, primary: !!m.primary })),
    primarySingleMetricKey: primaryKey,
    treatments: treatmentInputs,
    flags: { [flagKey]: { ruleId: 'fallthrough', flagConfigVersion: version } },
  };
  if (reallocationFrequencyMillis) iteration.reallocationFrequencyMillis = reallocationFrequencyMillis;

  await ld('POST', `/api/v2/projects/${PROJECT_KEY}/environments/${ENV_KEY}/experiments`, {
    body: { name, key, type, maintainerId: MAINTAINER_ID, methodology: 'bayesian', iteration, tags: ['toggletravel-demo'] },
  });
  log(`  created ${type} ${key}`);

  // Start the iteration created above.
  await ld('PATCH', `/api/v2/projects/${PROJECT_KEY}/environments/${ENV_KEY}/experiments/${key}`, {
    semanticPatch: true,
    body: { instructions: [{ kind: 'startIteration' }] },
  });
  log(`  started ${type} ${key}`);
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function run(log = (m) => process.stdout.write(`[ld-setup ${stamp()}] ${m}\n`)) {
  if (!LD_TOKEN) { log('LD_API_TOKEN not set — skipping experimentation setup'); return; }

  log('metrics…');
  await ensureMetric(log, { key: 'booking-conversion', name: 'Booking Conversion', eventKey: 'confirm-booking', description: 'A user reached Confirm & Pay. Primary metric for the promo-banner experiment.' });
  await ensureMetric(log, { key: 'promo-click', name: 'Promo Banner Click', eventKey: 'promo-click', description: 'A user clicked the promo banner CTA.' });
  await ensureMetric(log, { key: 'destination-view', name: 'Destination View', eventKey: 'destination-view', description: 'A user viewed a destination detail page. Reward metric for the search-ranking bandit.' });

  log('search-ranking flag…');
  await ensureRankingFlag(log);

  log('experiment (promo-banner-messaging)…');
  await createAndStart(log, {
    key: 'promo-banner-messaging',
    name: 'Promo Banner Messaging',
    type: 'experiment',
    hypothesis: 'The Free Upgrade promo drives the most bookings vs. Flash Sale, Bundle Deal, or no promo.',
    flagKey: PROMO_FLAG,
    primaryKey: 'booking-conversion',
    metrics: [{ key: 'booking-conversion', primary: true }, { key: 'promo-click', primary: false }],
    treatments: [
      { name: 'No Promo', value: '', baseline: true, allocationPercent: '25' },
      { name: 'Flash Sale', value: '✈️  Flash Sale: 20% off all flights this week only → Book Now', allocationPercent: '25' },
      { name: 'Free Upgrade', value: '🌟 Book today and get a free seat upgrade on select routes → Claim Offer', allocationPercent: '25' },
      { name: 'Bundle Deal', value: '🏨 Bundle your flight + hotel and save up to $300 → See Deals', allocationPercent: '25' },
    ],
  });

  log('multi-armed bandit (search-ranking-optimizer)…');
  await createAndStart(log, {
    key: 'search-ranking-optimizer',
    name: 'Search Ranking Optimizer',
    type: 'mab',
    hypothesis: 'Auto-optimize the search sort order to maximize destination views.',
    flagKey: RANK_FLAG,
    primaryKey: 'destination-view',
    reallocationFrequencyMillis: 3_600_000, // reallocate hourly
    metrics: [{ key: 'destination-view', primary: true }],
    treatments: [
      { name: 'Recommended', value: 'recommended', baseline: true, allocationPercent: '25' },
      { name: 'Price: low to high', value: 'price-low', allocationPercent: '25' },
      { name: 'Price: high to low', value: 'price-high', allocationPercent: '25' },
      { name: 'Trending', value: 'trending', allocationPercent: '25' },
    ],
  });

  log('done.');
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => { process.stderr.write(`ld-setup FAILED: ${err.message}\n`); process.exit(1); });
}
