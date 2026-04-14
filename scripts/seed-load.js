#!/usr/bin/env node
'use strict';

/**
 * Seed load script — fires synthetic traffic against the demo app.
 * Usage: node scripts/seed-load.js [--host http://localhost:3000] [--rounds 3]
 */

const BASE = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1]
  : 'http://localhost:3000';

const ROUNDS = process.argv.includes('--rounds')
  ? parseInt(process.argv[process.argv.indexOf('--rounds') + 1], 10)
  : 3;

const destinations = [
  'dest-001', 'dest-002', 'dest-003', 'dest-004',
  'dest-005', 'dest-006', 'dest-007', 'dest-008',
];

const searchQueries = [
  { query: 'temple' },
  { query: 'beach' },
  { query: 'adventure', region: 'americas' },
  { query: 'glacier' },
  { region: 'europe' },
  { region: 'asia', maxPrice: 2500 },
  {},
];

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runRound(round) {
  console.log(`\n── Round ${round} ──`);

  // List destinations
  await req('GET', '/api/destinations');
  console.log('  ✓ GET /api/destinations');
  await sleep(200);

  // Fetch some individual destinations with weather
  for (const id of destinations.slice(0, 4)) {
    await req('GET', `/api/destinations/${id}`);
    console.log(`  ✓ GET /api/destinations/${id}`);
    await sleep(150);
  }

  // Run searches
  for (const q of searchQueries.slice(0, 4)) {
    const result = await req('POST', '/api/search', { ...q, departureDate: '2026-06-15' });
    console.log(`  ✓ POST /api/search [${result.count || 0} results]`);
    await sleep(300);
  }

  // Create a booking (may fail due to 5% payment failure — that's intentional)
  try {
    const booking = await req('POST', '/api/bookings', {
      destinationId: destinations[round % destinations.length],
      travelers: 2,
      departureDate: '2026-07-01',
      returnDate: '2026-07-08',
      contactEmail: `demo-round-${round}@example.com`,
    });
    if (booking.booking) {
      console.log(`  ✓ POST /api/bookings → ${booking.booking.id}`);
    } else {
      console.log(`  ⚠ POST /api/bookings → ${booking.error}`);
    }
  } catch (e) {
    console.log(`  ✗ POST /api/bookings → ${e.message}`);
  }

  await sleep(500);
}

async function main() {
  console.log(`Toggle Travel Seed Load`);
  console.log(`Host: ${BASE}`);
  console.log(`Rounds: ${ROUNDS}`);

  // Health check first
  try {
    const health = await req('GET', '/health');
    console.log(`\nHealth: ${health.status} (uptime: ${Math.round(health.uptime)}s)`);
  } catch (e) {
    console.error(`\nCannot reach ${BASE} — is the server running?`);
    process.exit(1);
  }

  for (let i = 1; i <= ROUNDS; i++) {
    await runRound(i);
    if (i < ROUNDS) await sleep(1000);
  }

  console.log('\n✅ Seed load complete!');
}

main().catch((e) => { console.error(e); process.exit(1); });
