'use strict';

const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const metrics = require('../metrics');
const { authorizePayment } = require('./externalMockService');
const destinationService = require('./destinationService');

const tracer = trace.getTracer('toggle-travel');

// In-memory bookings store
const bookings = new Map();

async function create({ destinationId, travelers, departureDate, returnDate, contactEmail }) {
  const span = tracer.startSpan('booking.create', {
    attributes: {
      'booking.destination_id': destinationId,
      'booking.traveler_count': travelers,
      'booking.departure_date': departureDate,
      'app.component': 'booking-service',
    },
  }, context.active());
  const ctx = trace.setSpan(context.active(), span);

  return context.with(ctx, async () => {
    try {
      // Step 1: Inventory check
      const inventorySpan = tracer.startSpan('inventory.check', {
        attributes: { 'destination.id': destinationId, 'booking.travelers': travelers },
      }, context.active());
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
      inventorySpan.setAttribute('inventory.available', true);
      inventorySpan.setStatus({ code: SpanStatusCode.OK });
      inventorySpan.end();

      // Step 2: Fetch destination to compute price
      const dest = await destinationService.getById(destinationId);
      const totalAmount = dest.basePrice * travelers;

      span.setAttribute('booking.destination_name', dest.name);
      span.setAttribute('booking.total_amount', totalAmount);

      // Step 3: Authorize payment
      const payment = await authorizePayment(totalAmount, contactEmail);

      // Step 4: Persist booking
      const persistSpan = tracer.startSpan('booking.persist', {
        attributes: { 'db.system': 'in-memory', 'db.operation': 'insert' },
      }, context.active());

      const bookingId = `bk-${uuidv4().slice(0, 8).toUpperCase()}`;
      const booking = {
        id: bookingId,
        destinationId,
        destinationName: dest.name,
        travelers: Number(travelers),
        departureDate,
        returnDate,
        contactEmail,
        totalAmount,
        transactionId: payment.transactionId,
        status: 'confirmed',
        createdAt: new Date().toISOString(),
      };

      bookings.set(bookingId, booking);
      persistSpan.setAttribute('booking.id', bookingId);
      persistSpan.setStatus({ code: SpanStatusCode.OK });
      persistSpan.end();

      // Record metrics
      metrics.bookingsCreated.add(1, { region: dest.region });
      metrics.bookingValue.record(totalAmount, { region: dest.region });

      span.setAttribute('booking.id', bookingId);
      span.setAttribute('booking.status', 'confirmed');
      span.setStatus({ code: SpanStatusCode.OK });

      logger.info('booking_created', {
        booking_id: bookingId,
        destination: dest.name,
        travelers,
        total_amount: totalAmount,
        transaction_id: payment.transactionId,
      });

      return booking;
    } catch (err) {
      metrics.bookingsFailed.add(1, { reason: err.code || 'unknown' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error('booking_failed', {
        destination_id: destinationId,
        error: err.message,
        error_code: err.code,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

function getById(id) {
  const booking = bookings.get(id);
  if (!booking) {
    const err = new Error(`Booking not found: ${id}`);
    err.status = 404;
    throw err;
  }
  return booking;
}

function list() {
  return Array.from(bookings.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}

module.exports = { create, getById, list };
