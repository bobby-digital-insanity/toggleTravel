'use strict';

const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const logger = require('../logger');

const tracer = trace.getTracer('toggle-travel');

function jitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function withSpan(name, attributes, fn) {
  return new Promise((resolve, reject) => {
    const span = tracer.startSpan(name, { attributes }, context.active());
    const ctx = trace.setSpan(context.active(), span);
    context.with(ctx, async () => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        resolve(result);
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        reject(err);
      } finally {
        span.end();
      }
    });
  });
}

async function getWeather(destinationId) {
  return withSpan(
    'external.weather_api',
    { 'external.service': 'weather-api', 'destination.id': destinationId },
    async (span) => {
      await new Promise((r) => setTimeout(r, jitter(50, 200)));
      const data = {
        temperature: jitter(15, 30),
        condition: ['Sunny', 'Partly Cloudy', 'Clear', 'Mild'][Math.floor(Math.random() * 4)],
        humidity: jitter(40, 80),
        windSpeed: jitter(5, 25),
      };
      span.setAttribute('weather.temperature', data.temperature);
      logger.debug('weather_api_response', { destination_id: destinationId, ...data });
      return data;
    }
  );
}

async function getPricing(destinationId, departureDate) {
  return withSpan(
    'external.pricing_engine',
    { 'external.service': 'pricing-engine', 'destination.id': destinationId },
    async (span) => {
      await new Promise((r) => setTimeout(r, jitter(100, 400)));

      // Simulate occasional timeout errors (3%)
      if (Math.random() < 0.03) {
        const err = new Error('Pricing engine timeout');
        err.code = 'PRICING_TIMEOUT';
        throw err;
      }

      const multiplier = 1 + (Math.random() * 0.4 - 0.2); // ±20%
      const data = { multiplier: parseFloat(multiplier.toFixed(2)), currency: 'USD' };
      span.setAttribute('pricing.multiplier', data.multiplier);
      logger.debug('pricing_engine_response', { destination_id: destinationId, ...data });
      return data;
    }
  );
}

async function authorizePayment(amount, email) {
  const failureRate = parseFloat(process.env.SIMULATE_PAYMENT_FAILURE_RATE || '0.05');
  return withSpan(
    'external.payment_gateway',
    { 'external.service': 'payment-gateway', 'payment.amount': amount },
    async (span) => {
      await new Promise((r) => setTimeout(r, jitter(100, 300)));

      if (Math.random() < failureRate) {
        const err = new Error('Payment authorization declined');
        err.code = 'PAYMENT_DECLINED';
        err.status = 402;
        throw err;
      }

      const transactionId = `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      span.setAttribute('payment.transaction_id', transactionId);
      span.setAttribute('payment.authorized', true);
      logger.info('payment_authorized', { transaction_id: transactionId, amount });
      return { transactionId, authorized: true };
    }
  );
}

module.exports = { getWeather, getPricing, authorizePayment };
