'use strict';

// Must be required before any other module for full auto-instrumentation
// Project routing tag for LaunchDarkly Observability dual-shipping.
// Value is the LD environment's client-side ID (24-char hex) or full
// SDK key (sdk-...) — the bare UUID portion of an SDK key is silently
// dropped by the LD receiver.
const ldProjectId = process.env.LD_CLIENT_SIDE_ID;

const tracer = require('dd-trace').init({
  service: 'toggle-travel',
  env: process.env.NODE_ENV || 'development',
  logInjection: true,
  tags: ldProjectId ? { 'X-LaunchDarkly-Project': ldProjectId } : {},
});

module.exports = tracer;
