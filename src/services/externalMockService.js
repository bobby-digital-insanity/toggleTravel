'use strict';

const logger = require('../logger');
const { getFlag } = require('../launchdarkly');

function jitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getWeather(destinationId) {
  await new Promise((r) => setTimeout(r, jitter(50, 200)));

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
  await new Promise((r) => setTimeout(r, jitter(100, 400)));

  // Simulate occasional timeout errors (3%)
  if (Math.random() < 0.03) {
    const err = new Error('Pricing engine timeout');
    err.code = 'PRICING_TIMEOUT';
    throw err;
  }

  const dynamicPricingEnabled = await getFlag('dynamic-pricing-enabled', true);
  const multiplier = dynamicPricingEnabled
    ? 1 + (Math.random() * 0.4 - 0.2) // ±20%
    : 1.0;
  const data = { multiplier: parseFloat(multiplier.toFixed(2)), currency: 'USD' };

  logger.debug('pricing_engine_response', { destination_id: destinationId, dynamic_pricing: dynamicPricingEnabled, ...data });
  return data;
}

async function authorizePayment(amount, email) {
  const failureRate = await getFlag('payment-failure-rate', parseFloat(process.env.SIMULATE_PAYMENT_FAILURE_RATE || '0.05'));

  await new Promise((r) => setTimeout(r, jitter(100, 300)));

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
