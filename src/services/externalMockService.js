'use strict';

const logger = require('../logger');
const tracer = require('../tracer');

function jitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getWeather(destinationId) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, jitter(50, 200)));
  tracer.dogstatsd.distribution('toggle_travel.external.weather_duration_ms', Date.now() - start, [`destination_id:${destinationId}`]);

  const data = {
    temperature: jitter(15, 30),
    condition: ['Sunny', 'Partly Cloudy', 'Clear', 'Mild'][Math.floor(Math.random() * 4)],
    humidity: jitter(40, 80),
    windSpeed: jitter(5, 25),
  };

  logger.debug('weather_api_response', { destination_id: destinationId, ...data });
  return data;
}

async function getPricing(destinationId, departureDate) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, jitter(100, 400)));

  // Simulate occasional timeout errors (3%)
  if (Math.random() < 0.03) {
    tracer.dogstatsd.distribution('toggle_travel.external.pricing_duration_ms', Date.now() - start, [`destination_id:${destinationId}`]);
    tracer.dogstatsd.increment('toggle_travel.external.pricing_timeout', 1, [`destination_id:${destinationId}`]);
    const err = new Error('Pricing engine timeout');
    err.code = 'PRICING_TIMEOUT';
    throw err;
  }

  tracer.dogstatsd.distribution('toggle_travel.external.pricing_duration_ms', Date.now() - start, [`destination_id:${destinationId}`]);

  const multiplier = 1 + (Math.random() * 0.4 - 0.2); // ±20%
  const data = { multiplier: parseFloat(multiplier.toFixed(2)), currency: 'USD' };

  logger.debug('pricing_engine_response', { destination_id: destinationId, ...data });
  return data;
}

async function authorizePayment(amount, email) {
  const failureRate = parseFloat(process.env.SIMULATE_PAYMENT_FAILURE_RATE || '0.05');

  const start = Date.now();
  await new Promise((r) => setTimeout(r, jitter(100, 300)));
  tracer.dogstatsd.distribution('toggle_travel.external.payment_duration_ms', Date.now() - start, []);

  if (Math.random() < failureRate) {
    const err = new Error('Payment authorization declined');
    err.code = 'PAYMENT_DECLINED';
    err.status = 402;
    throw err;
  }

  const transactionId = `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  logger.info('payment_authorized', { transaction_id: transactionId, amount });
  return { transactionId, authorized: true };
}

module.exports = { getWeather, getPricing, authorizePayment };
