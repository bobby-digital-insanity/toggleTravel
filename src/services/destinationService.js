'use strict';

const logger = require('../logger');
const db = require('../db');
const { getPricing } = require('./externalMockService');

function rowToDestination(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    tagline: row.tagline,
    description: row.description,
    basePrice: row.base_price,
    currency: row.currency,
    heroImage: row.hero_image,
    activities: JSON.parse(row.activities || '[]'),
    bestSeason: row.best_season,
    weatherSummary: row.weather_summary,
    rating: row.rating,
    duration: row.duration,
    highlights: JSON.parse(row.highlights || '[]'),
  };
}

async function list() {
  const rows = db.all('SELECT id, name, region, tagline, base_price, currency, hero_image, activities, best_season, weather_summary, rating, duration, highlights FROM destinations ORDER BY name');
  const results = rows.map(rowToDestination);

  logger.info('destinations_listed', { count: results.length });
  return results;
}

async function getById(id) {
  const row = db.get('SELECT * FROM destinations WHERE id = @id', { id });

  if (!row) {
    const err = new Error(`Destination not found: ${id}`);
    err.status = 404;
    throw err;
  }

  return rowToDestination(row);
}

// Sort orders for the search-ranking MAB. `recommended` preserves the original
// behavior (rating DESC). All are whitelisted — the ranking value comes from a
// flag but is never interpolated raw into SQL.
const RANKING_SQL = {
  recommended: 'rating DESC',
  'price-low': 'base_price ASC',
  'price-high': 'base_price DESC',
  trending: 'rating DESC, base_price ASC',
};

async function search({ query = '', region, minPrice, maxPrice, departureDate, ranking = 'recommended' }) {
  const where = [];
  const params = {};

  if (query) {
    where.push('(LOWER(name) LIKE @q OR LOWER(tagline) LIKE @q OR LOWER(description) LIKE @q OR LOWER(activities) LIKE @q)');
    params.q = `%${query.toLowerCase()}%`;
  }
  if (region && region !== 'all') {
    where.push('region = @region');
    params.region = region;
  }
  if (minPrice) {
    where.push('base_price >= @minPrice');
    params.minPrice = Number(minPrice);
  }
  if (maxPrice) {
    where.push('base_price <= @maxPrice');
    params.maxPrice = Number(maxPrice);
  }

  const orderBy = RANKING_SQL[ranking] || RANKING_SQL.recommended;
  const sql = `SELECT * FROM destinations${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
  const rows = db.all(sql, params);
  const results = rows.map(rowToDestination);

  let pricingMultiplier = 1;
  try {
    const pricing = await getPricing(results[0]?.id || 'generic', departureDate);
    pricingMultiplier = pricing.multiplier;
  } catch (e) {
    logger.warn('pricing_engine_unavailable', { error: e.message });
  }

  const enriched = results.map((d) => ({
    ...d,
    description: undefined,
    currentPrice: Math.round(d.basePrice * pricingMultiplier),
    priceMultiplier: pricingMultiplier,
  }));

  logger.info('search_performed', {
    query,
    region: region || 'all',
    ranking,
    results_count: enriched.length,
  });

  return enriched;
}

module.exports = { list, getById, search };
