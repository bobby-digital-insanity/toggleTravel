'use strict';

/**
 * Toggle Travel — 24/7 Traffic Conductor
 *
 * Long-running PM2 process that makes the app look like it has a real user base:
 *
 *   1. Browser tier — spawns the existing Playwright load gen (1 round at a time,
 *      never concurrent) on a diurnal cadence: busy during US daytime, quiet
 *      overnight. Full session replays, client flag evals, browser errors.
 *   2. API tier — cheap fetch() traffic against the public API with a rotating
 *      pool of synthetic identities (x-session-id header). Thousands of server
 *      traces/logs/flag evaluations per day for near-zero resource cost.
 *   3. Incident scheduler — every day at INCIDENT_HOUR_ET (default 7am ET),
 *      starts a GUARDED ROLLOUT on `new-checkout-flow` via the LD REST API
 *      ("the deploy"): the new checkout ships to 50% of live traffic and fails
 *      EVERY confirm in that arm (see src/routes/bookings.js). LaunchDarkly
 *      watches the booking-error metric and auto-rolls-back within minutes; the
 *      conductor drives a checkout surge so the guard reaches significance fast,
 *      and force-stops after INCIDENT_AUTO_REVERT_MIN only as a safety net.
 *
 * Requires LD_API_TOKEN (Writer, scoped to the project) for the incident
 * scheduler only — without it, traffic still runs and incidents are skipped.
 *
 * Env knobs (defaults):
 *   TRAFFIC_ENABLED=true            master switch — false = idle (process stays up)
 *   HOST=http://localhost:3000
 *   TRAFFIC_PEAK_INTERVAL_MIN=5     minutes between browser rounds at peak (2pm ET)
 *   TRAFFIC_TROUGH_INTERVAL_MIN=20  minutes between browser rounds at trough (2am ET)
 *   TRAFFIC_API_RPM=20              API-tier requests/minute at peak (diurnally scaled)
 *   TRAFFIC_UNIQUE_PCT=70           % of browser flows run as brand-new identities
 *   INCIDENT_ENABLED=true
 *   INCIDENT_HOUR_ET=7              hour (ET, 0-23) the guarded rollout starts
 *   INCIDENT_MONITOR_WINDOW_MIN=5   guarded-rollout monitoring window per stage
 *   INCIDENT_AUTO_REVERT_MIN=20     safety-net backstop if the guard never trips
 *   INCIDENT_TEST_DELAY_MIN         (testing) fire the incident N minutes after boot
 *   LD_API_TOKEN / LD_PROJECT_KEY=ToggleTravel / LD_ENV_KEY=launch-darkly / LD_API_BASE
 */

const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const ENABLED        = (process.env.TRAFFIC_ENABLED ?? 'true') !== 'false';
const HOST           = process.env.HOST || 'http://localhost:3000';
const PEAK_MIN       = num(process.env.TRAFFIC_PEAK_INTERVAL_MIN, 5);
const TROUGH_MIN     = num(process.env.TRAFFIC_TROUGH_INTERVAL_MIN, 20);
const API_RPM        = num(process.env.TRAFFIC_API_RPM, 20);
const UNIQUE_PCT     = num(process.env.TRAFFIC_UNIQUE_PCT, 70);

const INCIDENT_ENABLED   = (process.env.INCIDENT_ENABLED ?? 'true') !== 'false';
const INCIDENT_HOUR_ET   = num(process.env.INCIDENT_HOUR_ET, 7);
const AUTO_REVERT_MIN    = num(process.env.INCIDENT_AUTO_REVERT_MIN, 20);
const MONITOR_WINDOW_MIN = num(process.env.INCIDENT_MONITOR_WINDOW_MIN, 5);
const TEST_DELAY_MIN     = process.env.INCIDENT_TEST_DELAY_MIN ? num(process.env.INCIDENT_TEST_DELAY_MIN, 1) : null;

const LD_BASE     = process.env.LD_API_BASE || 'https://app.launchdarkly.com';
const LD_TOKEN    = process.env.LD_API_TOKEN || null;
const PROJECT_KEY = process.env.LD_PROJECT_KEY || 'ToggleTravel';
const ENV_KEY     = process.env.LD_ENV_KEY || 'launch-darkly';
const FLAG_KEY    = 'new-checkout-flow';
const METRIC_KEY  = 'booking-error';
const GUARDED_ALLOCATION = 50000; // 50% — the guarded-rollout max; the rest is control

// During an incident the API tier feeds the guard (bulk signal) at this reduced
// rate so the rollout stays open a few minutes — long enough for the browser
// checkout surge to land real (recorded) treatment-arm sessions before rollback.
const INCIDENT_API_RPM        = num(process.env.INCIDENT_API_RPM, 15);
const INCIDENT_CHECKOUT_COUNT = num(process.env.INCIDENT_CHECKOUT_COUNT, 6); // browser checkouts per surge round

let incidentActive = false; // when true: API checkout surge + browser checkout surge feed the guard

const LOAD_SCRIPT = path.join(__dirname, 'playwright-load.js');

function num(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(base, pct = 0.3) { return Math.round(base * (1 - pct + Math.random() * 2 * pct)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function log(msg) {
  process.stdout.write(`[conductor ${new Date().toISOString()}] ${msg}\n`);
}

// ── Eastern-time clock (DST-safe, no deps) ────────────────────────────────────

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric', minute: 'numeric', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function nowET() {
  const parts = Object.fromEntries(ET_FMT.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// Activity 0..1 — peaks at 2pm ET, bottoms out around 2am ET.
function activityNow() {
  const { hour, minute } = nowET();
  const h = hour + minute / 60;
  return (1 + Math.cos(((h - 14) / 24) * 2 * Math.PI)) / 2;
}

// ── Browser tier ──────────────────────────────────────────────────────────────

const BROWSER_WEIGHTS = [
  ['chrome', 0.7], ['firefox', 0.1], ['iphone', 0.1], ['pixel', 0.1],
];

function pickBrowser() {
  let r = Math.random();
  for (const [name, w] of BROWSER_WEIGHTS) {
    if ((r -= w) < 0) return name;
  }
  return 'chrome';
}

let activeChild = null;

async function demoRunActive() {
  try {
    const res = await fetch(`${HOST}/api/demo/status`);
    const data = await res.json();
    return !!data.running;
  } catch (_) {
    return false;
  }
}

// Wait up to `ms`, but return early the moment an incident starts so the
// browser tier can switch to the checkout surge without finishing a long
// diurnal sleep.
async function sleepUntilIncidentOr(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (incidentActive) return;
    await sleep(Math.min(5_000, end - Date.now()));
  }
}

function runLoadRound(browser, { checkoutSurge = 0 } = {}) {
  return new Promise((resolve) => {
    const args = [
      LOAD_SCRIPT,
      '--host', HOST,
      '--rounds', '1',
      '--pause', '1',
      '--browsers', browser,
    ];
    if (checkoutSurge > 0) {
      // Only completeBooking sessions, each a fresh identity, so ~half bucket
      // into the guarded-rollout treatment arm and record a failing new-checkout
      // replay (500 banner + "NEW CHECKOUT" badge).
      args.push('--checkout', String(checkoutSurge), '--checkout-only', '--unique-personas', '100');
    } else {
      args.push('--unique-personas', String(UNIQUE_PCT));
    }
    const child = spawn(process.execPath, args);
    activeChild = child;

    // Keep PM2 logs readable: only surface problems and round boundaries.
    const filter = (data) => {
      for (const line of data.toString().split('\n')) {
        if (/✗|⚠|Round \d|complete!/.test(line)) log(`  ${line.trim()}`);
      }
    };
    child.stdout.on('data', filter);
    child.stderr.on('data', filter);
    child.on('close', (code) => {
      activeChild = null;
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      log(`browser round failed to spawn: ${err.message}`);
      activeChild = null;
      resolve(1);
    });
  });
}

async function browserLoop() {
  log(`browser tier: rounds every ${PEAK_MIN}m (peak) … ${TROUGH_MIN}m (trough), unique personas ${UNIQUE_PCT}%`);
  for (;;) {
    try {
      // During an incident, run back-to-back checkout-only surge rounds so the
      // treatment arm gets real recorded browser sessions (failing new checkout)
      // before the guard rolls back. Only the browser tier spawns browsers, so
      // there's still just one headless Chromium alive at a time.
      if (incidentActive) {
        log(`browser round starting (checkout surge ×${INCIDENT_CHECKOUT_COUNT}, incident)`);
        const code = await runLoadRound('chrome', { checkoutSurge: INCIDENT_CHECKOUT_COUNT });
        if (code !== 0) log(`checkout surge round exited with code ${code}`);
        await sleep(jitter(3_000));
        continue;
      }
      if (await demoRunActive()) {
        log('manual demo run in progress — standing down for 60s');
        await sleep(60_000);
        continue;
      }
      const browser = pickBrowser();
      log(`browser round starting (${browser}, activity ${activityNow().toFixed(2)})`);
      const code = await runLoadRound(browser);
      if (code !== 0) log(`browser round exited with code ${code}`);
    } catch (err) {
      log(`browser loop error: ${err.message}`);
    }
    if (incidentActive) continue; // no long sleep mid-incident
    const intervalMin = PEAK_MIN + (TROUGH_MIN - PEAK_MIN) * (1 - activityNow());
    const waitMs = jitter(intervalMin * 60_000);
    log(`next browser round in ~${Math.round(waitMs / 60_000)}m`);
    await sleepUntilIncidentOr(waitMs);
  }
}

// ── API tier ──────────────────────────────────────────────────────────────────

const VISITOR_NAMES = [
  'maya', 'liam', 'zoe', 'noah', 'ava', 'ethan', 'mia', 'lucas', 'isla', 'owen',
  'ruby', 'felix', 'nora', 'jude', 'iris', 'theo', 'cleo', 'max', 'lena', 'kai',
];
const SEARCH_TERMS = ['beach', 'mountain', 'city', 'island', 'culture', 'food', 'adventure', 'relax', ''];
const REGIONS = ['all', 'asia', 'europe', 'americas', 'oceania', 'africa'];

let apiIdentities = [];
let identitySeq = 0;
let destinationIds = [];

function newIdentity() {
  identitySeq += 1;
  return `${pick(VISITOR_NAMES)}-api${identitySeq}@demo.toggletravel.io`;
}

async function apiFetch(pathname, { method = 'GET', body, identity } = {}) {
  const res = await fetch(`${HOST}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': identity || pick(apiIdentities),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Drain so sockets are reused; response content doesn't matter here.
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

async function warmDestinationIds() {
  for (;;) {
    try {
      const res = await fetch(`${HOST}/api/destinations`);
      const data = await res.json();
      destinationIds = (data.destinations || []).map((d) => d.id).filter((id) => id !== 'dest-013');
      if (destinationIds.length) return;
    } catch (_) { /* app not up yet */ }
    log('waiting for app to serve /api/destinations…');
    await sleep(10_000);
  }
}

function randomFutureDate(minDays, maxDays) {
  const d = new Date();
  d.setDate(d.getDate() + jitter((minDays + maxDays) / 2, 0.5));
  return d.toISOString().split('T')[0];
}

// A real checkout attempt — exercises the flag-gated v2 path server-side. Each
// identity is bucketed by the guarded rollout, so treatment identities fail
// (firing server-side booking-error) and control identities succeed.
function postBooking() {
  const identity = pick(apiIdentities);
  return apiFetch('/api/bookings', {
    method: 'POST',
    identity,
    body: {
      destinationId: pick(destinationIds),
      travelers: jitter(2, 0.5),
      departureDate: randomFutureDate(20, 60),
      returnDate: randomFutureDate(61, 75),
      contactEmail: identity,
    },
  });
}

async function apiAction() {
  const roll = Math.random();
  // Checkout surge: while a guarded rollout is live, hammer checkout so the
  // guard metric reaches significance (and rolls back) within minutes.
  if (incidentActive) return roll < 0.85 ? postBooking() : apiFetch(`/api/destinations/${pick(destinationIds)}`);

  if (roll < 0.4) return apiFetch('/api/destinations');
  if (roll < 0.65) return apiFetch(`/api/destinations/${pick(destinationIds)}`);
  if (roll < 0.9) {
    const q = new URLSearchParams({ query: pick(SEARCH_TERMS), region: pick(REGIONS) });
    return apiFetch(`/api/search?${q}`);
  }
  if (roll < 0.98) return apiFetch('/api/bookings');
  return postBooking();
}

async function apiLoop() {
  apiIdentities = Array.from({ length: 40 }, newIdentity);
  await warmDestinationIds();
  log(`api tier: up to ${API_RPM} req/min across ${apiIdentities.length} rotating identities`);

  let lastRotate = Date.now();
  for (;;) {
    try {
      await apiAction();
    } catch (err) {
      log(`api tier request failed: ${err.message}`);
    }
    // Rotate one identity every ~10 min → slowly growing user population.
    if (Date.now() - lastRotate > 600_000) {
      apiIdentities[Math.floor(Math.random() * apiIdentities.length)] = newIdentity();
      lastRotate = Date.now();
    }
    // During an incident, hold a moderate fixed rate (bulk guard signal) — low
    // enough that the rollout stays open a few minutes for the browser checkout
    // surge to record treatment sessions before rollback. Otherwise follow the curve.
    const rpm = incidentActive
      ? INCIDENT_API_RPM
      : Math.max(1, API_RPM * (0.3 + 0.7 * activityNow()));
    await sleep(jitter(60_000 / rpm));
  }
}

// ── Incident scheduler ────────────────────────────────────────────────────────

async function ldRequest(method, pathname, { body, semanticPatch = false, beta = false } = {}) {
  const headers = {
    Authorization: LD_TOKEN,
    'Content-Type': semanticPatch
      ? 'application/json; domain-model=launchdarkly.semanticpatch'
      : 'application/json',
  };
  // The automated-release (guarded rollout) API is versioned beta.
  if (beta) headers['LD-API-Version'] = 'beta';
  const res = await fetch(`${LD_BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.message || `LD API ${method} ${pathname} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function ensureCheckoutFlag() {
  try {
    await ldRequest('POST', `/api/v2/flags/${PROJECT_KEY}`, {
      body: {
        key: FLAG_KEY,
        name: 'New Checkout Flow',
        description:
          'Gates the v2 checkout code path. Treatment (true) = new checkout logic with a bad deploy: EVERY confirm fails with a 500. ' +
          'Control (false) = stable v1 checkout. Shipped daily at 7am ET as a guarded rollout by the traffic conductor; ' +
          'LaunchDarkly auto-rolls-back when the booking-error metric regresses.',
        clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: true },
        variations: [
          { value: true, name: 'New checkout (v2)', description: 'New checkout logic — buggy' },
          { value: false, name: 'Stable checkout (v1)', description: 'Known-good checkout path' },
        ],
        defaults: { onVariation: 0, offVariation: 1 },
        tags: ['toggletravel-demo', 'checkout-incident'],
        temporary: false,
      },
    });
    log(`created flag ${FLAG_KEY}`);
  } catch (err) {
    if (err.status === 409) log(`flag ${FLAG_KEY} already exists`);
    else throw err;
  }
}

// The guard metric: an occurrence metric on the booking-error event where
// fewer occurrences is better. Fired server-side (routes/bookings.js) and
// client-side (booking.html) with the same context key that evaluated the flag.
async function ensureMetric() {
  try {
    await ldRequest('POST', `/api/v2/metrics/${PROJECT_KEY}`, {
      body: {
        key: METRIC_KEY,
        name: 'Booking Errors',
        kind: 'custom',
        isNumeric: false,
        eventKey: METRIC_KEY,
        successCriteria: 'LowerThanBaseline',
        randomizationUnits: ['user'],
        description: 'Booking confirmation failures. Guard metric for the new-checkout-flow guarded rollout.',
        tags: ['toggletravel-demo'],
      },
    });
    log(`created metric ${METRIC_KEY}`);
  } catch (err) {
    if (err.status === 409) log(`metric ${METRIC_KEY} already exists`);
    else throw err;
  }
}

// Read everything we need from the flag itself — variation IDs, on/off, and
// whether a guarded release is currently running. A live guarded release shows
// up as a fallthrough ROLLOUT with an experimentAllocation; once it resolves
// (rolled back or completed) the fallthrough is a plain variation again. This
// relies only on the rock-solid flag GET — no fragile beta releases endpoint.
async function getReleaseState() {
  const flag = await ldRequest('GET', `/api/v2/flags/${PROJECT_KEY}/${FLAG_KEY}?env=${ENV_KEY}`);
  const variations = flag.variations || [];
  const trueIdx = variations.findIndex((v) => v.value === true);
  const falseIdx = variations.findIndex((v) => v.value === false);
  const env = flag.environments?.[ENV_KEY] || {};
  const ft = env.fallthrough || {};
  const releaseActive = !!(ft.rollout && ft.rollout.experimentAllocation);
  const ftVariation = (!releaseActive && typeof ft.variation === 'number') ? ft.variation : null;
  return {
    trueId: variations[trueIdx]?._id,
    falseId: variations[falseIdx]?._id,
    trueIdx,
    falseIdx,
    on: !!env.on,
    releaseActive,
    servingControl: ftVariation === falseIdx,
    servingTreatment: ftVariation === trueIdx,
  };
}

function patchFlag(instructions, comment, { beta = false } = {}) {
  return ldRequest('PATCH', `/api/v2/flags/${PROJECT_KEY}/${FLAG_KEY}`, {
    semanticPatch: true,
    beta,
    body: { environmentKey: ENV_KEY, comment, instructions },
  });
}

async function startGuardedRollout(state) {
  return patchFlag(
    [{
      kind: 'startAutomatedRelease',
      releaseKind: 'guarded',
      originalVariationId: state.falseId,
      targetVariationId: state.trueId,
      randomizationUnit: 'user',
      stages: [{ allocation: GUARDED_ALLOCATION, durationMillis: MONITOR_WINDOW_MIN * 60_000 }],
      metrics: [{ key: METRIC_KEY, isGroup: false }],
      metricMonitoringPreferences: { [METRIC_KEY]: { autoRollback: true } },
    }],
    'Deploy: new checkout v2 — guarded rollout at 50%, guarded by Booking Errors',
    { beta: true },
  );
}

function stopGuardedRollout(state, comment) {
  return patchFlag(
    [{ kind: 'stopAutomatedRelease', finalVariationId: state.falseId }],
    comment,
    { beta: true },
  );
}

// Reset the flag to a clean baseline: ON, fallthrough serving false (control).
// (Call only when no guarded release is active — stop it first if one is.)
async function resetToBaseline(state) {
  const instructions = [];
  if (!state.on) instructions.push({ kind: 'turnFlagOn' });
  if (!state.servingControl) {
    instructions.push({ kind: 'updateFallthroughVariationOrRollout', variationId: state.falseId });
  }
  if (instructions.length) await patchFlag(instructions, 'Guarded rollout demo: reset to safe baseline (serving stable checkout)');
}

async function incidentLoop() {
  if (!INCIDENT_ENABLED) return log('incident scheduler: disabled (INCIDENT_ENABLED=false)');
  if (!LD_TOKEN) {
    return log('incident scheduler: LD_API_TOKEN not set — daily checkout incident will NOT run (traffic tiers unaffected)');
  }

  try {
    await ensureCheckoutFlag();
    await ensureMetric();
  } catch (err) {
    log(`incident scheduler: could not ensure flag/metric (${err.message}) — continuing; will retry at fire time`);
  }

  const testFireAt = TEST_DELAY_MIN ? Date.now() + TEST_DELAY_MIN * 60_000 : null;
  let testFired = false;
  let firedForDate = null;
  let backstopDeadline = null;

  log(`incident scheduler: guarded rollout daily at ${String(INCIDENT_HOUR_ET).padStart(2, '0')}:00 ET, ${MONITOR_WINDOW_MIN}m monitoring window, ${AUTO_REVERT_MIN}m safety-net backstop${testFireAt ? ` (TEST fire in ${TEST_DELAY_MIN}m)` : ''}`);

  for (;;) {
    try {
      const et = nowET();
      const shouldFire = testFireAt
        ? (!testFired && Date.now() >= testFireAt)
        : (et.hour === INCIDENT_HOUR_ET && et.minute < 2 && firedForDate !== et.dateKey);

      if (shouldFire && !incidentActive) {
        firedForDate = et.dateKey;
        testFired = true;
        await ensureCheckoutFlag();
        await ensureMetric();
        let state = await getReleaseState();
        if (!state.trueId || !state.falseId) throw new Error('could not resolve flag variation IDs');

        // Clear any release left over from a prior run, then start clean.
        if (state.releaseActive) {
          await stopGuardedRollout(state, 'Clearing prior guarded rollout before re-arming');
          state = await getReleaseState();
        }
        await resetToBaseline(state);
        state = await getReleaseState();
        await startGuardedRollout(state);

        incidentActive = true;
        backstopDeadline = Date.now() + AUTO_REVERT_MIN * 60_000;
        log(`🔥 guarded rollout started — new checkout v2 at 50%, guarded by ${METRIC_KEY}; checkout surge ON`);
      }

      // While an incident is live, watch for LaunchDarkly's auto-rollback.
      if (incidentActive) {
        const state = await getReleaseState();
        if (!state.releaseActive) {
          // LD resolved the release. Serving control = rolled back on the guard;
          // serving treatment = rolled forward (completed).
          incidentActive = false;
          backstopDeadline = null;
          log(state.servingTreatment
            ? `⚠ guarded rollout completed (rolled forward to new checkout) — surge OFF`
            : `✅ guarded rollout auto-rolled-back by LaunchDarkly — checkout recovered, surge OFF`);
        } else if (backstopDeadline && Date.now() >= backstopDeadline) {
          // Safety net: guard never reached significance (slow morning). Force it.
          await stopGuardedRollout(state, 'Safety-net backstop: stopping rollout after timeout');
          incidentActive = false;
          backstopDeadline = null;
          log(`🛑 safety-net backstop fired — guarded rollout stopped, surge OFF`);
        }
      }
    } catch (err) {
      log(`incident scheduler error: ${err.message}`);
    }
    await sleep(incidentActive ? 20_000 : 30_000);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
function shutdown() {
  log('shutting down');
  if (activeChild) activeChild.kill();
  process.exit(0);
}

async function main() {
  if (!ENABLED) {
    log('TRAFFIC_ENABLED=false — conductor idle (set TRAFFIC_ENABLED=true to start)');
    for (;;) await sleep(3600_000);
  }
  log(`conductor starting — host ${HOST}, project ${PROJECT_KEY}, env ${ENV_KEY}`);
  await Promise.all([browserLoop(), apiLoop(), incidentLoop()]);
}

main().catch((err) => {
  log(`fatal: ${err.stack || err}`);
  process.exit(1);
});
