'use strict';

// Must be required before any other module for full auto-instrumentation
// Project routing tag for LaunchDarkly Observability dual-shipping.
// Value must be a full LD SDK key (sdk-...) or environment ID — not the
// bare UUID portion of the SDK key.
const ldProjectId = process.env.LD_OBSERVABILITY_PROJECT_ID;

const tracer = require('dd-trace').init({
  service: 'toggle-travel',
  env: process.env.NODE_ENV || 'development',
  logInjection: true,
  tags: ldProjectId ? { 'X-LaunchDarkly-Project': ldProjectId } : {},
});

module.exports = tracer;
