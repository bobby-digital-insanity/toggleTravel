'use strict';

const { metrics } = require('@opentelemetry/api');

const meter = metrics.getMeter('toggle-travel', '1.0.0');

const destinationsListed = meter.createCounter('destinations.listed', {
  description: 'Number of times the destinations list was fetched',
});

const searchPerformed = meter.createCounter('search.performed', {
  description: 'Number of searches performed',
});

const searchResultsCount = meter.createHistogram('search.results_count', {
  description: 'Number of results returned per search',
  unit: 'results',
});

const bookingsCreated = meter.createCounter('bookings.created', {
  description: 'Number of bookings successfully created',
});

const bookingsFailed = meter.createCounter('bookings.failed', {
  description: 'Number of failed booking attempts',
});

const bookingValue = meter.createHistogram('booking.value', {
  description: 'Dollar value of each booking',
  unit: 'USD',
});

const vacationModeToggled = meter.createCounter('vacation_mode.toggled', {
  description: 'Number of times Vacation Mode was toggled',
});

const vacationModeAiDuration = meter.createHistogram('vacation_mode.ai_duration', {
  description: 'Claude API response time for Vacation Mode',
  unit: 'ms',
  advice: {
    explicitBucketBoundaries: [100, 250, 500, 1000, 2000, 4000, 8000],
  },
});

const aiTokensUsed = meter.createCounter('ai.tokens.used', {
  description: 'Number of tokens consumed by AI API calls',
  unit: 'tokens',
});

const httpRequestDuration = meter.createHistogram('http.server.request_duration', {
  description: 'HTTP server request duration',
  unit: 'ms',
  advice: {
    explicitBucketBoundaries: [0, 50, 100, 200, 400, 800, 1600, 3200],
  },
});

module.exports = {
  destinationsListed,
  searchPerformed,
  searchResultsCount,
  bookingsCreated,
  bookingsFailed,
  bookingValue,
  vacationModeToggled,
  vacationModeAiDuration,
  aiTokensUsed,
  httpRequestDuration,
};
