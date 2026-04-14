'use strict';

const logger = require('../logger');
const { getPricing } = require('./externalMockService');

const destinations = require('../data/destinations.json');

async function list() {
  await new Promise((r) => setTimeout(r, 5));

  logger.info('destinations_listed', { count: destinations.length });
  return destinations.map(({ description, ...summary }) => summary);
}

async function getById(id) {
  const dest = destinations.find((d) => d.id === id);

  if (!dest) {
    const err = new Error(`Destination not found: ${id}`);
    err.status = 404;
    throw err;
  }

  return dest;
}

async function search({ query = '', region, minPrice, maxPrice, departureDate }) {
  let results = [...destinations];

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.tagline.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q) ||
        d.activities.some((a) => a.toLowerCase().includes(q))
    );
  }

  if (region && region !== 'all') {
    results = results.filter((d) => d.region === region);
  }

  if (minPrice) {
    results = results.filter((d) => d.basePrice >= Number(minPrice));
  }

  if (maxPrice) {
    results = results.filter((d) => d.basePrice <= Number(maxPrice));
  }

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
    results_count: enriched.length,
  });

  return enriched;
}

module.exports = { list, getById, search };
