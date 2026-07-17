#!/usr/bin/env node
'use strict';

/**
 * Playwright load script — drives real browsers against Toggle Travel to generate
 * authentic observability signals: APM traces, RUM sessions, LD flag evaluations,
 * and click-through metrics.
 *
 * Each round runs a mix of five user flows across configurable browsers:
 *   windowShopper      — browse destinations, casual search, no booking
 *   abandonedCheckout  — search, view destinations, reach checkout, walk away
 *   completeBooking    — full happy path: search → view → book → confirm
 *   atlantisBooking    — books dest-013 (Atlantis), always hits 404 for LD Errors demo
 *   errorFlow          — intentional bad requests to generate 4xx/error signals
 *
 * Usage:
 *   node scripts/playwright-load.js [options]
 *
 * Options:
 *   --host     <url>     Base URL of the app  (default: http://localhost:3000)
 *   --rounds   <n>       Number of full rounds to run  (default: 3)
 *   --pause    <n>       Seconds to pause between rounds  (default: 3)
 *   --browsers <list>    Comma-separated browsers: chrome,firefox,safari,iphone,pixel
 *   --atlantis <n>       Atlantis booking sessions per round (default 1, max 20).
 *                        Values > 1 give each session a UNIQUE persona email so the
 *                        guarded-rollout demo gets distinct randomization units
 *                        split across both rollout arms.
 *   --atlantis-only      Skip all other persona flows — every round runs ONLY the
 *                        Atlantis booking sessions. Use with --atlantis to feed a
 *                        guarded rollout's regression detection as fast as possible.
 *   --checkout <n>       Run n completeBooking sessions per round (default 0, max 20),
 *                        each a UNIQUE identity so ~half bucket into the new-checkout-flow
 *                        treatment arm and record a FAILING new-checkout replay.
 *   --checkout-only      Skip all other persona flows — every round runs ONLY the
 *                        checkout surge sessions. Used by the conductor during the
 *                        guarded-rollout incident to populate treatment session replays.
 *   --unique-personas <pct>  Percent chance (0-100, default 0) that each flow runs
 *                        as a brand-new synthetic identity instead of one of the five
 *                        recurring personas. The 24/7 traffic conductor passes ~70 so
 *                        LD shows a growing population of new users plus regulars.
 *                        (Poseidon's Atlantis flow is never uniquified here — surge
 *                        mode has its own unique-email scheme.)
 *                        (default: chrome)
 */

const { chromium, firefox, webkit, devices } = require('playwright');

// ── CLI args ─────────────────────────────────────────────────────────────────

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

const BASE      = arg('--host')    || 'http://localhost:3000';
const ROUNDS    = parseInt(arg('--rounds') || '3', 10);
const PAUSE_SEC = parseInt(arg('--pause')  || '3', 10);
const BROWSERS  = (arg('--browsers') || 'chrome').split(',').map((b) => b.trim().toLowerCase());
const ATLANTIS       = Math.min(Math.max(parseInt(arg('--atlantis') || '1', 10), 1), 20);
const ATLANTIS_ONLY  = process.argv.includes('--atlantis-only');
const CHECKOUT       = Math.min(Math.max(parseInt(arg('--checkout') || '0', 10), 0), 20);
const CHECKOUT_ONLY  = process.argv.includes('--checkout-only');
const UNIQUE_PCT     = Math.min(Math.max(parseInt(arg('--unique-personas') || '0', 10), 0), 100);
const RUN_ID    = Date.now().toString(36).slice(-6);

// ── Logging (NDJSON-friendly stdout) ─────────────────────────────────────────

function log(line)       { process.stdout.write(`    ${line}\n`); }
function ok(msg)         { log(`✓ ${msg}`); }
function warn(msg)       { log(`⚠ ${msg}`); }
function fail(msg)       { log(`✗ ${msg}`); }
function section(msg)    { process.stdout.write(`\n  ${msg}\n`); }
function separator()     { process.stdout.write(`\n${'─'.repeat(50)}\n`); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** Push LD Session Replay data before the browser closes (headless skips real unload). */
async function flushLdSessionReplay(page, persona) {
  try {
    await page.waitForFunction(
      () => window.LDFlags?.flushSessionReplay && window.LDRecord?.getRecordingState,
      { timeout: 10000 },
    ).catch(() => {});

    const result = await page.evaluate(async ({ name, email, plan }) => {
      const state = window.LDRecord?.getRecordingState?.() ?? 'not-ready';
      if (window.LDRecord?.addSessionProperties) {
        try {
          window.LDRecord.addSessionProperties({ persona: name, personaEmail: email, ...(plan ? { plan } : {}) });
        } catch { /* ignore */ }
      }
      const flushed = window.LDFlags?.flushSessionReplay
        ? await window.LDFlags.flushSessionReplay()
        : false;
      return { flushed, state };
    }, { name: persona.name, email: persona.email, plan: persona.plan || null });

    // Upload window runs on the Node side (evaluate must not block 6s+ — hangs the stream).
    await sleep(8000);

    if (!result.flushed) {
      warn(`Replay may not upload (${persona.name}, state=${result.state})`);
    } else {
      ok(`Session replay flushed (${persona.name}, ${result.state})`);
    }
  } catch (err) {
    warn(`Session replay flush failed (${persona.name}): ${err.message}`);
  }
}

// ── Personas ──────────────────────────────────────────────────────────────────

const PERSONAS = [
  {
    name:       'Alex',
    email:      'alex@demo.toggletravel.io',
    plan:       'Gold',
    budget:     'mid',
    styles:     ['adventure', 'culture'],
    region:     'asia',
    locale:     'en-US',
    timezone:   'America/New_York',
    geolocation: { latitude: 40.71, longitude: -74.00 },
  },
  {
    name:       'Jordan',
    email:      'jordan@demo.toggletravel.io',
    plan:       'Diamond',
    budget:     'luxury',
    styles:     ['luxury', 'wellness'],
    region:     'europe',
    locale:     'en-GB',
    timezone:   'Europe/London',
    geolocation: { latitude: 51.50, longitude: -0.12 },
  },
  {
    name:       'Sam',
    email:      'sam@demo.toggletravel.io',
    plan:       'Beta',
    budget:     'budget',
    styles:     ['backpacking', 'beach'],
    region:     'americas',
    locale:     'fr-FR',
    timezone:   'Europe/Paris',
    geolocation: { latitude: 48.85, longitude: 2.35 },
  },
  {
    name:       'Taylor',
    email:      'taylor@demo.toggletravel.io',
    plan:       'Silver',
    budget:     'mid',
    styles:     ['food', 'culture'],
    region:     'europe',
    locale:     'ja-JP',
    timezone:   'Asia/Tokyo',
    geolocation: { latitude: 35.68, longitude: 139.69 },
  },
  {
    name:       'Poseidon',
    email:      'poseidon@demo.toggletravel.io',
    plan:       'Platinum',
    budget:     'luxury',
    styles:     ['ocean', 'mythology'],
    region:     'oceania',
    locale:     'el-GR',
    timezone:   'Europe/Athens',
    geolocation: { latitude: 37.98, longitude: 23.73 },
  },
];

const PLAN_TIERS = ['Beta', 'Silver', 'Gold', 'Platinum', 'Diamond'];

// ── Synthetic visitors (--unique-personas) ────────────────────────────────────

const VISITOR_NAMES = [
  'maya', 'liam', 'zoe', 'noah', 'ava', 'ethan', 'mia', 'lucas', 'isla', 'owen',
  'ruby', 'felix', 'nora', 'jude', 'iris', 'theo', 'cleo', 'max', 'lena', 'kai',
];

const VISITOR_LOCALES = [
  { locale: 'en-US', timezone: 'America/New_York',    geolocation: { latitude: 40.71, longitude: -74.00 } },
  { locale: 'en-US', timezone: 'America/Chicago',     geolocation: { latitude: 41.88, longitude: -87.63 } },
  { locale: 'en-US', timezone: 'America/Los_Angeles', geolocation: { latitude: 34.05, longitude: -118.24 } },
  { locale: 'en-GB', timezone: 'Europe/London',       geolocation: { latitude: 51.50, longitude: -0.12 } },
  { locale: 'de-DE', timezone: 'Europe/Berlin',       geolocation: { latitude: 52.52, longitude: 13.40 } },
  { locale: 'pt-BR', timezone: 'America/Sao_Paulo',   geolocation: { latitude: -23.55, longitude: -46.63 } },
  { locale: 'en-AU', timezone: 'Australia/Sydney',    geolocation: { latitude: -33.87, longitude: 151.21 } },
  { locale: 'es-MX', timezone: 'America/Mexico_City', geolocation: { latitude: 19.43, longitude: -99.13 } },
];

let visitorSeq = 0;

// With --unique-personas <pct>, swap a recurring persona for a fresh synthetic
// visitor pct% of the time. Fresh visitors get a new email (= new LD context)
// and a random locale/geo so sessions look geographically organic.
function maybeUniquePersona(persona) {
  if (UNIQUE_PCT <= 0 || Math.random() * 100 >= UNIQUE_PCT) return persona;
  const first = pick(VISITOR_NAMES);
  const geo = pick(VISITOR_LOCALES);
  visitorSeq += 1;
  return {
    ...persona,
    ...geo,
    name: first.charAt(0).toUpperCase() + first.slice(1),
    email: `${first}-${RUN_ID}-${visitorSeq}@demo.toggletravel.io`,
    plan: pick(PLAN_TIERS),
  };
}

// ── Browser configurations ────────────────────────────────────────────────────

const BROWSER_CONFIGS = {
  chrome:  { engine: chromium, label: 'Chrome',         devicePreset: null },
  firefox: { engine: firefox,  label: 'Firefox',        devicePreset: null },
  safari:  { engine: webkit,   label: 'Safari',         devicePreset: null },
  iphone:  { engine: webkit,   label: 'iPhone 15 Pro',  devicePreset: devices['iPhone 15 Pro'] },
  pixel:   { engine: chromium, label: 'Pixel 7',        devicePreset: devices['Pixel 7'] },
};

// ── Browser context factory ───────────────────────────────────────────────────

async function withBrowser(browserKey, persona, fn) {
  const config = BROWSER_CONFIGS[browserKey];
  if (!config) {
    warn(`Unknown browser "${browserKey}", skipping`);
    return;
  }

  const browser = await config.engine.launch({ headless: true });

  const contextOpts = {
    locale:       persona.locale,
    timezoneId:   persona.timezone,
    geolocation:  persona.geolocation,
    permissions:  ['geolocation'],
    baseURL:      BASE,
    ...(config.devicePreset || {}),
  };

  const context = await browser.newContext(contextOpts);
  await context.addInitScript(({ runId, personaEmail, personaPlan }) => {
    localStorage.setItem('tt-run-id', runId);
    localStorage.setItem('tt-persona-email', personaEmail);
    if (personaPlan) localStorage.setItem('tt-user-plan', personaPlan);
  }, { runId: RUN_ID, personaEmail: persona.email, personaPlan: persona.plan || null });
  const page    = await context.newPage();

  // Surface LD init/replay logs and errors in the load-gen terminal
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || text.includes('[LD]')) {
      process.stderr.write(`  [browser:${config.label}] ${text}\n`);
    }
  });

  try {
    await fn(page, config.label);
    await flushLdSessionReplay(page, persona);
  } finally {
    // Do not use runBeforeUnload — LD registers beforeunload handlers that can hang headless close.
    try {
      await page.close();
    } catch { /* already closed */ }
    await context.close();
    await browser.close();
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Wait for /api/search to render destination cards (not skeleton placeholders). */
async function waitForSearchResults(page, timeout = 20000) {
  await page.waitForFunction(
    () => {
      const title = document.querySelector(
        '#results-grid a.card[href*="destination.html"] .card-title',
      );
      return title && title.textContent.trim().length > 0;
    },
    { timeout },
  );
}

/**
 * Clicks the promo banner link if present — supports LD click-through experiments.
 */
async function maybeClickBanner(page) {
  try {
    const banner = page.locator('#promo-banner a');
    if (await banner.isVisible({ timeout: 1500 })) {
      await banner.click();
      ok('Clicked promo banner (LD experiment metric)');
      await page.goto('/search.html');
      await page.waitForLoadState('domcontentloaded');
      await waitForSearchResults(page);
      await sleep(jitter(300, 600));
    }
  } catch {
    // Banner not present or not visible — that's fine
  }
}

// ── Flows ─────────────────────────────────────────────────────────────────────

// Persona is identified to LD via `tt-persona-email` (set in addInitScript).
// flags.js uses it as the initial context key; booking.html skips identify()
// when `tt-run-id` is set. Each session ends with LDRecord.stop() via flushLdSessionReplay().

/**
 * Window shopper: browses destinations, does a casual search, never books.
 */
async function windowShopper(page, browserLabel, persona) {
  section(`[${persona.name} / ${browserLabel}] Window Shopping`);

  let t = Date.now();
  await page.goto('/search.html');
  await waitForSearchResults(page);
  ok(`Loaded /search.html (${Date.now() - t}ms)`);

  await maybeClickBanner(page);
  await sleep(jitter(800, 1400));

  // Click 3–4 destination cards
  const cards = page.locator('#results-grid a.card');
  const count = await cards.count();
  const toView = Math.min(jitter(3, 4), count);

  for (let i = 0; i < toView; i++) {
    t = Date.now();
    const card = cards.nth(i);
    const name = await card.locator('h3, .card-title').textContent().catch(() => `card-${i}`);
    await card.click();
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    ok(`Viewed destination: ${name.trim()} (${Date.now() - t}ms)`);
    await sleep(jitter(600, 1200));
    await page.goBack();
    await sleep(jitter(400, 700));
  }

  // Casual search
  t = Date.now();
  const searchInput = page.locator('#search-q, #search-input, input[type="search"]').first();
  if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchInput.fill(pick(['beach', 'temple', 'adventure', 'food']));
    await searchInput.press('Enter');
    await sleep(jitter(800, 1400));
    ok(`Searched (${Date.now() - t}ms)`);
  }

  log('→ closed the tab');
}

/**
 * Abandoned checkout: searches, views destinations, navigates to booking form, walks away.
 */
async function abandonedCheckout(page, browserLabel, persona) {
  section(`[${persona.name} / ${browserLabel}] Abandoned at Checkout`);

  let t = Date.now();
  await page.goto('/search.html');
  await waitForSearchResults(page);
  ok(`Loaded /search.html (${Date.now() - t}ms)`);

  await maybeClickBanner(page);
  await sleep(jitter(600, 1000));

  const destCount = Math.min(2, await page.locator('#results-grid a.card').count());

  for (let i = 0; i < destCount; i++) {
    // Fresh search each iteration — goBack() after booking is unreliable in headless
    await page.goto('/search.html');
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await waitForSearchResults(page).catch(() => {});

    t = Date.now();
    const card = page.locator('#results-grid a.card').nth(i);
    const name = await card.locator('h3, .card-title').textContent().catch(() => `card-${i}`);
    await card.click();
    await page.waitForURL('**/destination.html**', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    ok(`Viewed destination: ${name.trim()} (${Date.now() - t}ms)`);
    await sleep(jitter(900, 1800));

    if (i === 0) {
      const bookBtn = page.locator('#book-btn');
      if (await bookBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
        t = Date.now();
        await Promise.all([
          page.waitForURL('**/booking.html**', { timeout: 8000 }),
          bookBtn.click(),
        ]).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        ok(`Reached booking form (${Date.now() - t}ms)`);
        await sleep(jitter(1200, 2000));
        ok('Walked away from checkout (no booking)');
      }
    }
  }

  await page.goto('/search.html');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(1500);

  log('→ walked away (no booking)');
}

// Known-good (non-Atlantis) destinations for the checkout surge. dest-013 is
// Atlantis, which always 404s on its own — excluded so the ONLY failure cause
// is the new-checkout-flow treatment path.
const CHECKOUT_DESTS = ['dest-001', 'dest-002', 'dest-003', 'dest-004', 'dest-005', 'dest-006', 'dest-007'];

/**
 * Checkout surge: go straight to the booking form for a known-good destination,
 * fill it, and confirm. When the persona is in the new-checkout-flow treatment
 * arm the server returns 500 and booking.html shows the "Checkout Unavailable"
 * banner — a clean failing-new-checkout session replay. Control-arm personas
 * book successfully. Used to populate treatment-arm replays during the incident.
 */
async function checkoutSurgeBooking(page, browserLabel, persona) {
  section(`[${persona.name} / ${browserLabel}] Checkout Surge`);
  const dest = pick(CHECKOUT_DESTS);
  const dep = new Date(); dep.setDate(dep.getDate() + jitter(20, 45));
  const ret = new Date(); ret.setDate(ret.getDate() + jitter(50, 70));
  const depStr = dep.toISOString().split('T')[0];

  let t = Date.now();
  await page.goto(`/booking.html?destinationId=${dest}&travelers=2&departure=${depStr}`);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  ok(`Opened checkout for ${dest} (${Date.now() - t}ms)`);
  await sleep(jitter(600, 1000));

  // Step 1 → Continue
  const travelersSelect = page.locator('#f-travelers');
  if (await travelersSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
    await travelersSelect.selectOption(String(jitter(1, 3)));
    await sleep(jitter(200, 400));
  }
  const continueBtn = page.getByRole('button', { name: /Continue/i });
  if (!(await continueBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    warn('Checkout: Continue button not found — skipping');
    return;
  }
  await continueBtn.click();
  await sleep(jitter(400, 800));

  // Step 2: email → Review
  const emailInput = page.locator('#f-email');
  await emailInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await emailInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await emailInput.fill(persona.email);
    await sleep(jitter(300, 600));
  }
  const reviewBtn = page.getByRole('button', { name: /Review Booking/i });
  if (!(await reviewBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    warn('Checkout: Review button not found — skipping');
    return;
  }
  await reviewBtn.click();
  await sleep(jitter(400, 800));

  // Step 3: confirm & pay — this is where treatment fails with the 500 banner
  const confirmBtn = page.locator('#confirm-btn');
  await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (!(await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
    warn('Checkout: Confirm button not found');
    return;
  }
  t = Date.now();
  await confirmBtn.click();
  const success = await page.locator('#success-state').waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  const error   = await page.locator('#booking-error').isVisible({ timeout: 500 }).catch(() => false);
  if (success) {
    ok(`Checkout succeeded — control arm (${Date.now() - t}ms)`);
  } else if (error) {
    const errText = await page.locator('#booking-error').textContent().catch(() => '');
    fail(`Checkout FAILED — treatment arm: ${errText.trim().slice(0, 60)} (${Date.now() - t}ms)`);
  } else {
    warn(`Checkout outcome unclear (${Date.now() - t}ms)`);
  }
  // Let session replay flush before the browser closes.
  await sleep(jitter(1500, 2500));
}

/**
 * Complete booking: search → view destination → fill booking form → confirm.
 */
async function completeBooking(page, browserLabel, persona) {
  section(`[${persona.name} / ${browserLabel}] Complete Booking`);

  let t = Date.now();
  await page.goto('/search.html');
  await waitForSearchResults(page);
  ok(`Loaded /search.html (${Date.now() - t}ms)`);

  await maybeClickBanner(page);
  await waitForSearchResults(page).catch(() => {});

  // Click first destination
  const card = page.locator('#results-grid a.card').first();
  if (!(await card.isVisible({ timeout: 5000 }).catch(() => false))) {
    warn('No destination cards found, skipping booking flow');
    return;
  }

  t = Date.now();
  const destName = await card.locator('h3, .card-title').textContent().catch(() => 'destination');
  await card.click();
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  ok(`Viewed destination: ${destName.trim()} (${Date.now() - t}ms)`);
  await sleep(jitter(800, 1400));

  // Navigate to booking — use only #book-btn; avoid generic selectors that match nav links
  const bookBtn = page.locator('#book-btn');
  if (!(await bookBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false))) {
    warn('No book button found, skipping booking');
    return;
  }

  t = Date.now();
  await Promise.all([
    page.waitForURL('**/booking.html**', { timeout: 8000 }),
    bookBtn.click(),
  ]).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  ok(`Opened booking form (${Date.now() - t}ms)`);
  await sleep(jitter(600, 1000));

  // Step 1: select travelers, then click Continue
  const travelersSelect = page.locator('#f-travelers');
  if (await travelersSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
    await travelersSelect.selectOption(String(jitter(1, 3)));
    await sleep(jitter(200, 400));
  }

  // "Continue →" button is in step-1
  const continueBtn = page.getByRole('button', { name: /Continue/i });
  if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    t = Date.now();
    await continueBtn.click();
    ok(`Advanced to step 2 (${Date.now() - t}ms)`);
    await sleep(jitter(400, 800));
  } else {
    warn('Step 1 Continue button not found — skipping booking');
    return;
  }

  // Step 2: fill email (now visible), then click Review Booking
  const emailInput = page.locator('#f-email');
  await emailInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await emailInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await emailInput.fill(persona.email);
    await sleep(jitter(300, 600));
  }

  const reviewBtn = page.getByRole('button', { name: /Review Booking/i });
  if (await reviewBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    t = Date.now();
    await reviewBtn.click();
    ok(`Advanced to step 3 (${Date.now() - t}ms)`);
    await sleep(jitter(400, 800));
  } else {
    warn('Step 2 Review button not found — skipping booking');
    return;
  }

  // Step 3: confirm
  const confirmBtn = page.locator('#confirm-btn');
  await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    t = Date.now();
    await confirmBtn.click();

    const success = await page.locator('#success-state').waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    const error   = await page.locator('#booking-error').isVisible({ timeout: 500 }).catch(() => false);

    if (success) {
      ok(`Booking confirmed (${Date.now() - t}ms)`);
    } else if (error) {
      const errText = await page.locator('#booking-error').textContent().catch(() => 'payment declined');
      warn(`Booking failed: ${errText.trim()} (${Date.now() - t}ms)`);
    } else {
      warn(`Booking outcome unclear (${Date.now() - t}ms)`);
    }
  } else {
    warn('Confirm button not found');
  }
}

/**
 * Atlantis booking: navigates directly to dest-013, fills the booking form, and
 * confirms — expecting a 404 error banner to exercise the LD Observability Errors view.
 */
async function atlantisBooking(page, browserLabel, persona) {
  section(`[${persona.name} / ${browserLabel}] Atlantis Booking (404 demo)`);

  let t = Date.now();
  await page.goto('/destination.html?id=dest-013');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  ok(`Loaded Atlantis destination page (${Date.now() - t}ms)`);
  await sleep(jitter(800, 1400));

  const bookBtn = page.locator('#book-btn');
  if (!(await bookBtn.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false))) {
    warn('Atlantis #book-btn not visible — skipping');
    return;
  }

  t = Date.now();
  await Promise.all([
    page.waitForURL('**/booking.html**', { timeout: 8000 }),
    bookBtn.click(),
  ]).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  ok(`Opened booking form (${Date.now() - t}ms)`);
  await sleep(jitter(500, 900));

  // Step 1: travelers → Continue
  const travelersSelect = page.locator('#f-travelers');
  if (await travelersSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
    await travelersSelect.selectOption(String(jitter(1, 2)));
    await sleep(jitter(200, 400));
  }

  const continueBtn = page.getByRole('button', { name: /Continue/i });
  if (!(await continueBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    warn('Step 1 Continue button not found — skipping');
    return;
  }
  await continueBtn.click();
  await sleep(jitter(400, 700));

  // Step 2: email → Review Booking
  const emailInput = page.locator('#f-email');
  await emailInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await emailInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    const currentVal = await emailInput.inputValue().catch(() => '');
    if (!currentVal) await emailInput.fill(persona.email);
    await sleep(jitter(300, 500));
  }

  const reviewBtn = page.getByRole('button', { name: /Review Booking/i });
  if (!(await reviewBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    warn('Step 2 Review button not found — skipping');
    return;
  }
  await reviewBtn.click();
  await sleep(jitter(400, 700));

  // Step 3: confirm — expect 404 error banner
  const confirmBtn = page.locator('#confirm-btn');
  await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (!(await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
    warn('Confirm button not found');
    return;
  }

  t = Date.now();
  await confirmBtn.click();

  const errorBanner = await page.locator('#booking-error-banner, .booking-error-banner, [class*="error-banner"]').waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  const genericError = await page.locator('#booking-error').isVisible({ timeout: 500 }).catch(() => false);

  if (errorBanner || genericError) {
    ok(`Atlantis 404 error surfaced correctly (${Date.now() - t}ms)`);
  } else {
    warn(`Expected 404 banner but got unexpected outcome (${Date.now() - t}ms)`);
  }
}

/**
 * Error flow: direct API calls with bad inputs to generate 4xx error signals.
 */
async function errorFlow(page, browserLabel, persona) {
  section(`[${persona.name} / ${browserLabel}] Error Signals`);

  async function badReq(method, path, body) {
    const t = Date.now();
    const res = await page.evaluate(
      async ({ method, path, body, base }) => {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status };
      },
      { method, path, body, base: BASE }
    );
    fail(`${method} ${path} → ${res.status} (${Date.now() - t}ms)`);
    await sleep(jitter(200, 400));
  }

  // Load any page first so fetch() is available
  await page.goto('/search.html');
  await page.waitForLoadState('domcontentloaded');

  await badReq('POST', '/api/bookings', { travelers: 2 });                    // missing required fields → 400
  await badReq('GET',  '/api/destinations/dest-999', null);                   // unknown destination → 404
  await badReq('GET',  '/api/bookings/bk-INVALID', null);                     // unknown booking → 404
}

// ── Round orchestration ───────────────────────────────────────────────────────

async function runRound(round, browserKey) {
  const config = BROWSER_CONFIGS[browserKey];
  const [p0, p1, p2, p3, p4] = PERSONAS;

  separator();
  process.stdout.write(`Round ${round} of ${ROUNDS}  [${config.label}]\n`);
  separator();

  if (!ATLANTIS_ONLY && !CHECKOUT_ONLY) {
    const shopper1 = maybeUniquePersona(p2);
    await withBrowser(browserKey, shopper1,  (page, label) => windowShopper(page, label, shopper1));
    await sleep(jitter(1500, 2500));

    const shopper2 = maybeUniquePersona(p3);
    await withBrowser(browserKey, shopper2,  (page, label) => windowShopper(page, label, shopper2));
    await sleep(jitter(1500, 2500));

    const abandoner = maybeUniquePersona(p1);
    await withBrowser(browserKey, abandoner, (page, label) => abandonedCheckout(page, label, abandoner));
    await sleep(jitter(1500, 2500));

    const booker = maybeUniquePersona(p0);
    await withBrowser(browserKey, booker,    (page, label) => completeBooking(page, label, booker));
    await sleep(jitter(1500, 2500));
  }

  // Atlantis sessions — in surge mode (--atlantis > 1) each gets a unique
  // email so the guarded rollout buckets them as distinct users across arms.
  // Skipped entirely in checkout-only mode.
  if (!CHECKOUT_ONLY) {
    for (let a = 0; a < ATLANTIS; a++) {
      const poseidon = ATLANTIS > 1
        ? { ...p4, email: `poseidon+${RUN_ID}-r${round}-${a}@demo.toggletravel.io` }
        : p4;
      await withBrowser(browserKey, poseidon,  (page, label) => atlantisBooking(page, label, poseidon));
      await sleep(jitter(500, 1200));
    }
  }

  // Checkout surge — each session is a fresh identity so ~half bucket into the
  // new-checkout-flow guarded rollout's treatment arm and record a FAILING
  // new-checkout replay (500 banner + "NEW CHECKOUT" badge) on a known-good
  // destination. Drives the treatment-arm session replays during the incident.
  for (let c = 0; c < CHECKOUT; c++) {
    const first = pick(VISITOR_NAMES);
    const geo = pick(VISITOR_LOCALES);
    visitorSeq += 1;
    const booker = {
      ...p0,
      ...geo,
      name: first.charAt(0).toUpperCase() + first.slice(1),
      email: `${first}-${RUN_ID}-c${round}-${c}@demo.toggletravel.io`,
    };
    await withBrowser(browserKey, booker,    (page, label) => checkoutSurgeBooking(page, label, booker));
    await sleep(jitter(500, 1200));
  }

  if (!ATLANTIS_ONLY && !CHECKOUT_ONLY) {
    await sleep(jitter(1000, 1500));
    await withBrowser(browserKey, p2,        (page, label) => errorFlow(page, label, p2));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('Toggle Travel — Playwright Load\n');
  process.stdout.write(`Host:     ${BASE}\n`);
  process.stdout.write(`Rounds:   ${ROUNDS}  |  Pause: ${PAUSE_SEC}s  |  Browsers: ${BROWSERS.join(', ')}${ATLANTIS > 1 ? `  |  Atlantis surge: ×${ATLANTIS}` : ''}${ATLANTIS_ONLY ? '  |  ATLANTIS ONLY' : ''}${CHECKOUT > 0 ? `  |  Checkout surge: ×${CHECKOUT}` : ''}${CHECKOUT_ONLY ? '  |  CHECKOUT ONLY' : ''}\n`);
  process.stdout.write(`Run ID:   ${RUN_ID}\n`);

  // Validate browser list
  const invalid = BROWSERS.filter((b) => !BROWSER_CONFIGS[b]);
  if (invalid.length) {
    process.stderr.write(`Unknown browsers: ${invalid.join(', ')}. Valid: ${Object.keys(BROWSER_CONFIGS).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  // Health check
  try {
    const res = await fetch(`${BASE}/health`);
    const data = await res.json();
    process.stdout.write(`\nHealth: ${data.status} (uptime: ${Math.round(data.uptime)}s)\n`);
  } catch {
    process.stderr.write(`\nCannot reach ${BASE} — is the server running?\n`);
    process.exitCode = 1;
    return;
  }

  const flowsPerRound = CHECKOUT_ONLY ? CHECKOUT : ATLANTIS_ONLY ? ATLANTIS : (5 + ATLANTIS + CHECKOUT);
  const totalSessions = ROUNDS * BROWSERS.length * flowsPerRound;

  for (let i = 1; i <= ROUNDS; i++) {
    for (const browserKey of BROWSERS) {
      await runRound(i, browserKey);
    }

    if (i < ROUNDS) {
      process.stdout.write(`\nPausing ${PAUSE_SEC}s before round ${i + 1}…\n`);
      await sleep(PAUSE_SEC * 1000);
    }
  }

  process.stdout.write(`\n${'─'.repeat(50)}\n`);
  process.stdout.write(`✅ Playwright load complete!\n`);
  process.stdout.write(`   ${ROUNDS} rounds × ${BROWSERS.length} browser(s) × 5 flows = ${totalSessions} sessions\n`);
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; });
