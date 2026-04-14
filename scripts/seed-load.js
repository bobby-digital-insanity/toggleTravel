#!/usr/bin/env node
'use strict';

/**
 * Seed load script — simulates realistic user traffic against the Toggle Travel demo app.
 *
 * Each round runs a mix of five user flows:
 *   completeBooking  — browse → search → view destination → book → confirm
 *   abandonedFlow    — browse and search but stop before booking (cart abandonment)
 *   windowShopper    — browse multiple destinations, never books
 *   vacationMode     — enables AI vacation mode, reads results, then disables
 *   errorSpike       — fires intentionally bad requests to generate 4xx error signals
 *
 * Usage:
 *   node scripts/seed-load.js [options]
 *
 * Options:
 *   --host <url>     Base URL of the app  (default: http://localhost:3000)
 *   --rounds <n>     Number of full rounds to run  (default: 3)
 *   --pause <n>      Seconds to pause between rounds  (default: 5)
 */

const BASE = arg('--host') || 'http://localhost:3000';
const ROUNDS = parseInt(arg('--rounds') || '3', 10);
const PAUSE_SEC = parseInt(arg('--pause') || '5', 10);

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

// ── Personas ────────────────────────────────────────────────────────────────
const PERSONAS = [
  { name: 'Alex',   email: 'alex@demo.toggletravel.io',   budget: 'mid',    styles: ['adventure', 'culture'],  region: 'asia' },
  { name: 'Jordan', email: 'jordan@demo.toggletravel.io', budget: 'luxury', styles: ['luxury', 'wellness'],    region: 'europe' },
  { name: 'Sam',    email: 'sam@demo.toggletravel.io',    budget: 'budget', styles: ['backpacking', 'beach'],  region: 'americas' },
  { name: 'Taylor', email: 'taylor@demo.toggletravel.io', budget: 'mid',    styles: ['food', 'culture'],       region: 'europe' },
];

const ALL_DEST = [
  'dest-001','dest-002','dest-003','dest-004',
  'dest-005','dest-006','dest-007','dest-008',
  'dest-009','dest-010','dest-011','dest-012',
];

const SEARCH_QUERIES = [
  { query: 'temple' },
  { query: 'beach' },
  { query: 'glacier' },
  { query: 'adventure', region: 'americas' },
  { region: 'europe' },
  { region: 'asia', maxPrice: 2500 },
  { query: 'food', region: 'europe' },
  {},
];

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function req(method, path, body, sessionId) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['x-session-id'] = sessionId;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sessionId(persona, round, flow) { return `${persona.name.toLowerCase()}-r${round}-${flow}`; }

function elapsed(start) { return `${Date.now() - start}ms`; }

function ok(msg)   { console.log(`    ✓ ${msg}`); }
function warn(msg) { console.log(`    ⚠ ${msg}`); }
function fail(msg) { console.log(`    ✗ ${msg}`); }

// ── Flows ────────────────────────────────────────────────────────────────────

/**
 * Full happy path: browse → search → view two destinations → book → confirm.
 * Represents a user who knows what they want and completes the purchase.
 */
async function completeBooking(persona, round) {
  const sid = sessionId(persona, round, 'book');
  console.log(`\n  [${persona.name}] Complete Booking`);

  // Browse the destination list
  let t = Date.now();
  await req('GET', '/api/destinations', null, sid);
  ok(`GET /api/destinations (${elapsed(t)})`);
  await sleep(jitter(400, 700));

  // Search with persona's region preference
  t = Date.now();
  const searchQ = { region: persona.region, departureDate: '2026-08-15' };
  const search = await req('POST', '/api/search', searchQ, sid);
  ok(`POST /api/search → ${search.data.count || 0} results (${elapsed(t)})`);
  await sleep(jitter(300, 600));

  // View two destinations before deciding
  const candidates = search.data.results?.length
    ? search.data.results.slice(0, 2).map((d) => d.id)
    : [pick(ALL_DEST), pick(ALL_DEST)];

  for (const id of candidates) {
    t = Date.now();
    const d = await req('GET', `/api/destinations/${id}`, null, sid);
    ok(`GET /api/destinations/${id} → ${d.data.destination?.name || id} (${elapsed(t)})`);
    await sleep(jitter(500, 1000));
  }

  // Book the first candidate
  const destId = candidates[0];
  t = Date.now();
  const booking = await req('POST', '/api/bookings', {
    destinationId: destId,
    travelers: jitter(1, 3),
    departureDate: '2026-08-15',
    returnDate: '2026-08-22',
    contactEmail: persona.email,
  }, sid);

  if (booking.data.booking) {
    const b = booking.data.booking;
    ok(`POST /api/bookings → ${b.id} ($${b.totalAmount}, ${b.travelers} traveler${b.travelers > 1 ? 's' : ''}, ${elapsed(t)})`);
    await sleep(jitter(200, 400));

    // Confirm the booking
    t = Date.now();
    await req('GET', `/api/bookings/${b.id}`, null, sid);
    ok(`GET /api/bookings/${b.id} → confirmed (${elapsed(t)})`);
  } else {
    warn(`POST /api/bookings → ${booking.data.error || 'payment declined'} (${elapsed(t)})`);
  }
}

/**
 * Abandonment at checkout: searches, views destinations, then walks away.
 * Very common pattern — generates browse/search telemetry with no conversion.
 */
async function abandonedFlow(persona, round) {
  const sid = sessionId(persona, round, 'abandon');
  console.log(`\n  [${persona.name}] Abandoned at Checkout`);

  let t = Date.now();
  await req('GET', '/api/destinations', null, sid);
  ok(`GET /api/destinations (${elapsed(t)})`);
  await sleep(jitter(400, 600));

  // First search
  t = Date.now();
  const q1 = pick(SEARCH_QUERIES);
  const r1 = await req('POST', '/api/search', { ...q1, departureDate: '2026-09-01' }, sid);
  ok(`POST /api/search → ${r1.data.count || 0} results (${elapsed(t)})`);
  await sleep(jitter(600, 1000));

  // Browse a couple of results
  const ids = r1.data.results?.slice(0, 2).map((d) => d.id) || [pick(ALL_DEST), pick(ALL_DEST)];
  for (const id of ids) {
    t = Date.now();
    const d = await req('GET', `/api/destinations/${id}`, null, sid);
    ok(`GET /api/destinations/${id} → ${d.data.destination?.name || id} (${elapsed(t)})`);
    await sleep(jitter(700, 1400));
  }

  // Refine search (classic indecision pattern)
  t = Date.now();
  const q2 = pick(SEARCH_QUERIES);
  const r2 = await req('POST', '/api/search', { ...q2, departureDate: '2026-09-01' }, sid);
  ok(`POST /api/search (refined) → ${r2.data.count || 0} results (${elapsed(t)})`);
  await sleep(jitter(800, 1200));

  // View one more destination, then drop off
  const lastId = r2.data.results?.[0]?.id || pick(ALL_DEST);
  t = Date.now();
  const d = await req('GET', `/api/destinations/${lastId}`, null, sid);
  ok(`GET /api/destinations/${lastId} → ${d.data.destination?.name || lastId} (${elapsed(t)})`);

  console.log(`    → walked away (no booking)`);
}

/**
 * Window shopper: browses many destinations but never searches with intent or books.
 * Generates destination view events and list loads with no conversion.
 */
async function windowShopper(persona, round) {
  const sid = sessionId(persona, round, 'browse');
  console.log(`\n  [${persona.name}] Window Shopping`);

  let t = Date.now();
  await req('GET', '/api/destinations', null, sid);
  ok(`GET /api/destinations (${elapsed(t)})`);
  await sleep(jitter(300, 500));

  // View 3-4 random destinations
  const toView = ALL_DEST.sort(() => 0.5 - Math.random()).slice(0, jitter(3, 4));
  for (const id of toView) {
    t = Date.now();
    const d = await req('GET', `/api/destinations/${id}`, null, sid);
    ok(`GET /api/destinations/${id} → ${d.data.destination?.name || id} (${elapsed(t)})`);
    await sleep(jitter(400, 800));
  }

  // One casual search, no follow-through
  t = Date.now();
  const r = await req('POST', '/api/search', { ...pick(SEARCH_QUERIES), departureDate: '2026-10-01' }, sid);
  ok(`POST /api/search → ${r.data.count || 0} results (${elapsed(t)})`);
  console.log(`    → closed the tab`);
}

/**
 * Vacation mode: calls the AI feature with persona-specific preferences.
 * Generates AI inference spans, token count metrics, and latency signals.
 */
async function vacationModeSession(persona, round) {
  const sid = sessionId(persona, round, 'vm');
  console.log(`\n  [${persona.name}] Vacation Mode`);

  // Enable vacation mode with persona preferences
  let t = Date.now();
  const on = await req('POST', '/api/vacation-mode', {
    enabled: true,
    preferences: { budget: persona.budget, styles: persona.styles },
  }, sid);

  if (on.status === 200 && on.data.persona) {
    ok(`POST /api/vacation-mode ON → "${on.data.persona}" (${elapsed(t)})`);
    if (on.data.recommendations?.length) {
      const recs = on.data.recommendations.map((r) => r.name || r.id).join(', ');
      console.log(`    → AI recommended: ${recs}`);
    }
  } else if (on.status === 500 || on.status === 503) {
    warn(`POST /api/vacation-mode → AI unavailable (${elapsed(t)}), skipping`);
    return;
  } else {
    warn(`POST /api/vacation-mode → unexpected response ${on.status} (${elapsed(t)})`);
  }

  // Simulate user reading the AI results
  await sleep(jitter(2000, 3500));

  // Click through to one of the recommended destinations
  const recId = on.data.recommendations?.[0]?.id;
  if (recId) {
    t = Date.now();
    const d = await req('GET', `/api/destinations/${recId}`, null, sid);
    ok(`GET /api/destinations/${recId} → ${d.data.destination?.name || recId} (${elapsed(t)})`);
    await sleep(jitter(600, 1000));
  }

  // Disable vacation mode
  t = Date.now();
  await req('POST', '/api/vacation-mode', { enabled: false }, sid);
  ok(`POST /api/vacation-mode OFF (${elapsed(t)})`);
}

/**
 * Error spike: fires intentionally bad requests to generate 4xx error signals.
 * Useful for demonstrating error rate dashboards and alerting.
 */
async function errorSpike(persona, round) {
  const sid = sessionId(persona, round, 'err');
  console.log(`\n  [${persona.name}] Error Signals`);

  // Missing required booking fields → 400
  let t = Date.now();
  const r1 = await req('POST', '/api/bookings', { travelers: 2 }, sid);
  fail(`POST /api/bookings (missing fields) → ${r1.status} (${elapsed(t)})`);
  await sleep(jitter(200, 400));

  // Unknown destination → 404
  t = Date.now();
  const r2 = await req('GET', '/api/destinations/dest-999', null, sid);
  fail(`GET /api/destinations/dest-999 → ${r2.status} (${elapsed(t)})`);
  await sleep(jitter(200, 400));

  // Unknown booking → 404
  t = Date.now();
  const r3 = await req('GET', '/api/bookings/bk-INVALID', null, sid);
  fail(`GET /api/bookings/bk-INVALID → ${r3.status} (${elapsed(t)})`);
  await sleep(jitter(200, 400));

  // vacation-mode missing enabled field → 400
  t = Date.now();
  const r4 = await req('POST', '/api/vacation-mode', { preferences: {} }, sid);
  fail(`POST /api/vacation-mode (missing enabled) → ${r4.status} (${elapsed(t)})`);
}

// ── Round ────────────────────────────────────────────────────────────────────

async function runRound(round) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Round ${round} of ${ROUNDS}`);
  console.log('─'.repeat(50));

  const [p0, p1, p2, p3] = PERSONAS;

  // Mix: realistic conversion funnel
  // Most visitors browse, fewer search with intent, fewer convert
  await windowShopper(p2, round);
  await sleep(jitter(2000, 3000));

  await windowShopper(p3, round);
  await sleep(jitter(2000, 3000));

  await abandonedFlow(p1, round);
  await sleep(jitter(2000, 3000));

  await completeBooking(p0, round);
  await sleep(jitter(2000, 3000));

  await vacationModeSession(pick(PERSONAS), round);
  await sleep(jitter(2000, 3000));

  await errorSpike(p2, round);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Toggle Travel — Seed Load');
  console.log(`Host:   ${BASE}`);
  console.log(`Rounds: ${ROUNDS}  |  Pause between rounds: ${PAUSE_SEC}s`);

  // Health check
  try {
    const { data } = await req('GET', '/health');
    console.log(`\nHealth: ${data.status} (uptime: ${Math.round(data.uptime)}s)`);
  } catch {
    console.error(`\nCannot reach ${BASE} — is the server running?`);
    process.exitCode = 1;
    return;
  }

  for (let i = 1; i <= ROUNDS; i++) {
    await runRound(i);
    if (i < ROUNDS) {
      console.log(`\nPausing ${PAUSE_SEC}s before round ${i + 1}…`);
      await sleep(PAUSE_SEC * 1000);
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log('✅ Seed load complete!');
  console.log(`   ${ROUNDS} rounds × 5 flows = ${ROUNDS * 5} user sessions`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
