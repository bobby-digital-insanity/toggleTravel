'use strict';

const express = require('express');
const router = express.Router();
const destinationService = require('../services/destinationService');
const simulateLatency = require('../middleware/simulateLatency');

router.post('/', simulateLatency, async (req, res, next) => {
  try {
    const { query, region, minPrice, maxPrice, departureDate, ranking } = req.body;
    const results = await destinationService.search({ query, region, minPrice, maxPrice, departureDate, ranking });
    res.json({ results, count: results.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
