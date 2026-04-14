'use strict';

const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const logger = require('../logger');
const metrics = require('../metrics');
const { getPricing } = require('./externalMockService');

const destinations = require('../data/destinations.json');
const tracer = trace.getTracer('toggle-travel');

async function list() {
  const span = tracer.startSpan('destination.list', {
    attributes: { 'db.system': 'in-memory', 'db.operation': 'find' },
  }, context.active());

  try {
    await new Promise((r) => setTimeout(r, 5)); // simulate tiny I/O
    metrics.destinationsListed.add(1);
    span.setAttribute('destinations.count', destinations.length);
    span.setStatus({ code: SpanStatusCode.OK });
    logger.info('destinations_listed', { count: destinations.length });
    return destinations.map(({ description, ...summary }) => summary);
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw err;
  } finally {
    span.end();
  }
}

async function getById(id) {
  const span = tracer.startSpan('destination.get_by_id', {
    attributes: { 'db.system': 'in-memory', 'db.operation': 'findOne', 'destination.id': id },
  }, context.active());

  try {
    const dest = destinations.find((d) => d.id === id);
    if (!dest) {
      const err = new Error(`Destination not found: ${id}`);
      err.status = 404;
      throw err;
    }
    span.setAttribute('destination.name', dest.name);
    span.setStatus({ code: SpanStatusCode.OK });
    return dest;
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw err;
  } finally {
    span.end();
  }
}

async function search({ query = '', region, minPrice, maxPrice, departureDate }) {
  const span = tracer.startSpan('destination.search', {
    attributes: {
      'db.system': 'in-memory',
      'db.operation': 'search',
      'search.query': query,
      'search.region': region || 'all',
    },
  }, context.active());

  try {
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

    // Get pricing multipliers (calls external service, creating child spans)
    let pricingMultiplier = 1;
    try {
      const pricing = await getPricing(results[0]?.id || 'generic', departureDate);
      pricingMultiplier = pricing.multiplier;
    } catch (e) {
      logger.warn('pricing_engine_unavailable', { error: e.message });
      span.addEvent('pricing_engine_fallback', { reason: e.message });
    }

    const enriched = results.map((d) => ({
      ...d,
      description: undefined,
      currentPrice: Math.round(d.basePrice * pricingMultiplier),
      priceMultiplier: pricingMultiplier,
    }));

    metrics.searchPerformed.add(1, { region: region || 'all' });
    metrics.searchResultsCount.record(enriched.length, { region: region || 'all' });

    span.setAttribute('search.results_count', enriched.length);
    span.setAttribute('search.price_multiplier', pricingMultiplier);
    span.setStatus({ code: SpanStatusCode.OK });

    logger.info('search_performed', {
      query,
      region: region || 'all',
      results_count: enriched.length,
    });

    return enriched;
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw err;
  } finally {
    span.end();
  }
}

module.exports = { list, getById, search };
