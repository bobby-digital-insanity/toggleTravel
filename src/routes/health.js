'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../logger');

router.get('/health', (req, res) => {
  logger.debug('health_check');
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

router.get('/ready', async (req, res) => {
  const checks = { destinations: false, gemini: false };

  try {
    require('../data/destinations.json');
    checks.destinations = true;
  } catch {}

  try {
    if (process.env.GEMINI_API_KEY) checks.gemini = true;
  } catch {}

  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ ready, checks });
});

module.exports = router;
