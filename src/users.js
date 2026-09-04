'use strict';

/**
 * Server-side user store for the demo's signed-in identities.
 *
 * The browser (public/js/nav.js) lets the visitor pick one of these personas
 * and then sends `x-user-key` / `x-user-tier` / `x-user-name` headers with
 * every AI Planner call. A client-controlled tier header must never be what
 * decides the model bill, so the server resolves the tier from this store by
 * key and treats the header as a hint only (see routes/aiPlanner.js
 * buildContext). This mirrors nav.js's TT_USER_TIERS — keep the two in sync.
 */

const USERS = [
  { key: 'beta@toggletravel.io',     tier: 'beta',     name: 'Beta User' },
  { key: 'admin@toggletravel.io',    tier: 'admin',    name: 'Admin User' },
  { key: 'silver@toggletravel.io',   tier: 'silver',   name: 'Silver User' },
  { key: 'gold@toggletravel.io',     tier: 'gold',     name: 'Gold User' },
  { key: 'platinum@toggletravel.io', tier: 'platinum', name: 'Platinum User' },
  { key: 'diamond@toggletravel.io',  tier: 'diamond',  name: 'Diamond User' },
];

const BY_KEY = new Map(USERS.map((u) => [u.key.toLowerCase(), u]));

// The only tier values the app ever produces (lowercase — these are what the
// LD targeting rules match on, so never invent a differently-cased variant).
const VALID_TIERS = new Set(USERS.map((u) => u.tier));

function findUser(key) {
  if (!key) return null;
  return BY_KEY.get(String(key).toLowerCase()) || null;
}

function isValidTier(tier) {
  return VALID_TIERS.has(String(tier || '').toLowerCase());
}

module.exports = { USERS, findUser, isValidTier, VALID_TIERS };
