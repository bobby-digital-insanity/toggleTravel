'use strict';

const express = require('express');
const router = express.Router();
const destinationService = require('../services/destinationService');
const { getWeather } = require('../services/externalMockService');

router.get('/', async (req, res, next) => {
  try {
    const data = await destinationService.list();
    res.json({ destinations: data });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const dest = await destinationService.getById(req.params.id);
    const weather = await getWeather(req.params.id);
    res.json({ destination: { ...dest, weather } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
