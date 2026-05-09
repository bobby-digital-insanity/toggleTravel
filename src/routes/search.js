'use strict';

const express = require('express');
const router = express.Router();
const destinationService = require('../services/destinationService');
const simulateLatency = require('../middleware/simulateLatency');
const tracer = require('../tracer');

router.post('/', simulateLatency, async (req, res, next) => {
  const start = Date.now();
  try {
    const { query, region, minPrice, maxPrice, departureDate } = req.body;
    const results = await destinationService.search({ query, region, minPrice, maxPrice, departureDate });

    const tags = [
      `region:${region || 'all'}`,
      `has_price_filter:${!!(minPrice || maxPrice)}`,
    ];
    tracer.dogstatsd.increment('toggle_travel.search.performed', 1, tags);
    tracer.dogstatsd.distribution('toggle_travel.search.results_count', results.length, tags);
    tracer.dogstatsd.distribution('toggle_travel.search.latency_ms', Date.now() - start, tags);
    if (results.length === 0) {
      tracer.dogstatsd.increment('toggle_travel.search.zero_results', 1, tags);
    }

    res.json({ results, count: results.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
