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
 *   3. Incident scheduler — every day at INCIDENT_HOUR_ET (default 8am ET),
 *      turns ON the `new-checkout-flow` flag via the LD REST API ("the deploy"),
 *      which makes ~50% of checkouts fail (see src/routes/bookings.js). Toggle
 *      the flag OFF in LaunchDarkly to recover — or the conductor auto-reverts
 *      after INCIDENT_AUTO_REVERT_MIN as a safety net.
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
 *   INCIDENT_HOUR_ET=8              hour (ET, 0-23) the checkout incident starts
 *   INCIDENT_AUTO_REVERT_MIN=60     safety-net auto-revert if nobody toggles the flag
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
const INCIDENT_HOUR_ET   = num(process.env.INCIDENT_HOUR_ET, 8);
const AUTO_REVERT_MIN    = num(process.env.INCIDENT_AUTO_REVERT_MIN, 60);
const TEST_DELAY_MIN     = process.env.INCIDENT_TEST_DELAY_MIN ? num(process.env.INCIDENT_TEST_DELAY_MIN, 1) : null;

const LD_BASE     = process.env.LD_API_BASE || 'https://app.launchdarkly.com';
const LD_TOKEN    = process.env.LD_API_TOKEN || null;
const PROJECT_KEY = process.env.LD_PROJECT_KEY || 'ToggleTravel';
const ENV_KEY     = process.env.LD_ENV_KEY || 'launch-darkly';
const FLAG_KEY    = 'new-checkout-flow';

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

function runLoadRound(browser) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      LOAD_SCRIPT,
      '--host', HOST,
      '--rounds', '1',
      '--pause', '1',
      '--browsers', browser,
      '--unique-personas', String(UNIQUE_PCT),
    ]);
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
    const intervalMin = PEAK_MIN + (TROUGH_MIN - PEAK_MIN) * (1 - activityNow());
    const waitMs = jitter(intervalMin * 60_000);
    log(`next browser round in ~${Math.round(waitMs / 60_000)}m`);
    await sleep(waitMs);
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

async function apiAction() {
  const roll = Math.random();
  if (roll < 0.4) return apiFetch('/api/destinations');
  if (roll < 0.65) return apiFetch(`/api/destinations/${pick(destinationIds)}`);
  if (roll < 0.9) {
    const q = new URLSearchParams({ query: pick(SEARCH_TERMS), region: pick(REGIONS) });
    return apiFetch(`/api/search?${q}`);
  }
  if (roll < 0.98) return apiFetch('/api/bookings');
  // Occasional real checkout — exercises the flag-gated v2 path server-side
  // (and the 5% simulated payment decline). Failures here are the point.
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
    const rpm = Math.max(1, API_RPM * (0.3 + 0.7 * activityNow()));
    await sleep(jitter(60_000 / rpm));
  }
}

// ── Incident scheduler ────────────────────────────────────────────────────────

async function ldRequest(method, pathname, { body, semanticPatch = false } = {}) {
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
          'Gates the v2 checkout code path. ON = new checkout logic (demo bug: ~50% of confirms fail). ' +
          'OFF = stable v1 checkout. Turned ON daily at 8am ET by the traffic conductor to simulate a bad deploy; toggle OFF to recover.',
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

function patchFlag(instruction, comment) {
  return ldRequest('PATCH', `/api/v2/flags/${PROJECT_KEY}/${FLAG_KEY}`, {
    semanticPatch: true,
    body: { environmentKey: ENV_KEY, comment, instructions: [{ kind: instruction }] },
  });
}

async function flagIsOn() {
  const flag = await ldRequest('GET', `/api/v2/flags/${PROJECT_KEY}/${FLAG_KEY}?env=${ENV_KEY}`);
  return !!flag.environments?.[ENV_KEY]?.on;
}

async function incidentLoop() {
  if (!INCIDENT_ENABLED) return log('incident scheduler: disabled (INCIDENT_ENABLED=false)');
  if (!LD_TOKEN) {
    return log('incident scheduler: LD_API_TOKEN not set — daily checkout incident will NOT run (traffic tiers unaffected)');
  }

  try {
    await ensureCheckoutFlag();
  } catch (err) {
    log(`incident scheduler: could not ensure flag (${err.message}) — continuing; will retry flips anyway`);
  }

  const testFireAt = TEST_DELAY_MIN ? Date.now() + TEST_DELAY_MIN * 60_000 : null;
  let testFired = false;
  let firedForDate = null;
  let revertDeadline = null;

  log(`incident scheduler: daily at ${String(INCIDENT_HOUR_ET).padStart(2, '0')}:00 ET, auto-revert after ${AUTO_REVERT_MIN}m${testFireAt ? ` (TEST fire in ${TEST_DELAY_MIN}m)` : ''}`);

  for (;;) {
    try {
      const et = nowET();
      const shouldFire = testFireAt
        ? (!testFired && Date.now() >= testFireAt)
        : (et.hour === INCIDENT_HOUR_ET && et.minute < 2 && firedForDate !== et.dateKey);

      if (shouldFire) {
        await patchFlag('turnFlagOn', 'Deploy: checkout v2 rollout (scripted daily incident — toggle OFF to recover)');
        firedForDate = et.dateKey;
        testFired = true;
        revertDeadline = Date.now() + AUTO_REVERT_MIN * 60_000;
        log(`🔥 incident started — ${FLAG_KEY} ON (checkout v2 live, ~50% of confirms will fail)`);
      }

      if (revertDeadline && Date.now() >= revertDeadline) {
        if (await flagIsOn()) {
          await patchFlag('turnFlagOff', 'Auto-revert: error budget exceeded (demo safety net)');
          log(`✅ incident auto-reverted — ${FLAG_KEY} OFF`);
        } else {
          log('incident already resolved manually — nice save');
        }
        revertDeadline = null;
      }
    } catch (err) {
      log(`incident scheduler error: ${err.message}`);
    }
    await sleep(30_000);
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
