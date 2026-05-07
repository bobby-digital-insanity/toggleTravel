'use strict';

// Must be required before any other module for full auto-instrumentation
const tracer = require('dd-trace').init({
  service: 'toggle-travel',
  env: process.env.NODE_ENV || 'development',
  logInjection: true,
});

module.exports = tracer;
