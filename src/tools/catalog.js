'use strict';

/**
 * `search_destinations` — the inventory half of agent mode.
 *
 * The schema and description live in LaunchDarkly (project tool
 * `search_destinations`); this is the implementation bound to that name.
 *
 * Deliberately built on destinationService.list() rather than .search():
 * search() multiplies every price by a random pricing-engine multiplier, so two
 * specialists calling the same tool in one conversation would report different
 * prices for the same trip. Agents need a stable number they can compare and
 * cite, so this returns the catalog basePrice and does its filtering in JS.
 */

const path = require('path');
const destinationService = require('../services/destinationService');
const logger = require('../logger');

// The seed file is the source of truth for the catalog and carries the fields
// list() does not select — coordinates and the long description.
const SEED = require(path.join('..', 'data', 'destinations.json'));
const SEED_BY_ID = new Map(
  (Array.isArray(SEED) ? SEED : SEED.destinations).map((d) => [d.id, d]),
);

const DESCRIPTION_CHARS = 240;

function toToolRecord(dest) {
  const seed = SEED_BY_ID.get(dest.id) || {};
  const nights = dest.duration || null;
  const record = {
    id: dest.id,
    name: dest.name,
    region: dest.region,
    tagline: dest.tagline,
    // Truncated: the full descriptions are ~500 chars each and 13 of them would
    // dominate a cheap model's context for little added signal.
    description: (seed.description || '').slice(0, DESCRIPTION_CHARS),
    basePriceUsd: dest.basePrice,
    nights,
    // Precomputed so the Budget agent compares rather than does arithmetic.
    perNightUsd: nights ? Math.round(dest.basePrice / nights) : null,
    bestSeason: dest.bestSeason,
    rating: dest.rating,
    activities: dest.activities,
    highlights: dest.highlights,
  };

  if (Number.isFinite(seed.lat) && Number.isFinite(seed.lon)) {
    record.lat = seed.lat;
    record.lon = seed.lon;
  } else {
    // Atlantis (dest-013) has no coordinates because it is not a real place.
    record.lat = null;
    record.lon = null;
    record.note = 'Not a real-world location — no coordinates and no weather forecast exist for it.';
  }

  return record;
}

function matchesQuery(record, query) {
  const q = String(query).toLowerCase();
  const haystack = [
    record.name, record.region, record.tagline, record.description,
    (record.activities || []).join(' '), (record.highlights || []).join(' '),
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

/**
 * Tool implementation. Returns data (never throws) so a failure the agent can
 * read does not end its turn.
 */
async function searchDestinations({ query, region, minPrice, maxPrice, limit } = {}) {
  const started = Date.now();
  try {
    const all = await destinationService.list();
    const catalogTotal = all.length;
    let records = all.map(toToolRecord);

    // A query that matches nothing is the main driver of tool-call thrash: the
    // model tries "cuisine", then "market", then "food tour". The catalog only
    // has 13 destinations, so returning all of them with a note is both cheaper
    // and more useful than an empty set the model will try to work around.
    let queryMissed = false;
    if (query) {
      const matched = records.filter((r) => matchesQuery(r, query));
      if (matched.length) records = matched;
      else queryMissed = true;
    }
    if (region && region !== 'all') records = records.filter((r) => r.region === region);
    if (Number.isFinite(Number(minPrice))) records = records.filter((r) => r.basePriceUsd >= Number(minPrice));
    if (Number.isFinite(Number(maxPrice))) records = records.filter((r) => r.basePriceUsd <= Number(maxPrice));

    records.sort((a, b) => (b.rating || 0) - (a.rating || 0));

    const capped = Number.isFinite(Number(limit)) ? records.slice(0, Math.max(1, Number(limit))) : records;

    logger.info('tool_search_destinations', {
      query: query || null, region: region || null, matched: records.length,
      returned: capped.length, duration_ms: Date.now() - started,
    });

    const result = { count: capped.length, currency: 'USD', priceNote: 'basePriceUsd is the catalog price for the full trip.', destinations: capped };
    if (queryMissed) {
      // Report the real catalog size, not the post-filter count: a Budget agent
      // that reads "sells 2 destinations in total" concludes the catalog is
      // two items deep and reasons from that.
      result.note = `Nothing in the catalog matched "${query}", so no text filter was applied. Toggle Travel sells ${catalogTotal} destinations in total; ${capped.length} are shown here after the other filters. Judge these rather than searching again.`;
    }
    return result;
  } catch (err) {
    logger.warn('tool_search_destinations_failed', { error: err.message });
    return { error: `Destination lookup failed: ${err.message}` };
  }
}

module.exports = { searchDestinations };
