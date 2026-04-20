'use strict';

const { getFlag } = require('../launchdarkly');

async function simulateLatency(req, res, next) {
  const sessionId = req.headers['x-session-id'] || 'anonymous';
  const maxMs = await getFlag('simulated-latency-ms', parseInt(process.env.SIMULATE_LATENCY_MAX_MS || '1200', 10), sessionId);
  if (maxMs <= 0) return next();
  const delay = Math.floor(Math.random() * maxMs);
  setTimeout(next, delay);
}

module.exports = simulateLatency;
