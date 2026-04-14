'use strict';

const maxMs = parseInt(process.env.SIMULATE_LATENCY_MAX_MS || '1200', 10);

function simulateLatency(req, res, next) {
  if (maxMs <= 0) return next();
  const delay = Math.floor(Math.random() * maxMs);
  setTimeout(next, delay);
}

module.exports = simulateLatency;
