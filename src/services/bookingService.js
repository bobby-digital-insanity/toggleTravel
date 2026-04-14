'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const { authorizePayment } = require('./externalMockService');
const destinationService = require('./destinationService');

// In-memory bookings store
const bookings = new Map();

async function create({ destinationId, travelers, departureDate, returnDate, contactEmail, sessionId }) {
  const bookingId = `bk-${uuidv4().slice(0, 8).toUpperCase()}`;
  const logCtx = { booking_id: bookingId, destination_id: destinationId, session_id: sessionId };

  // Stage 1: inventory check
  const invStart = Date.now();
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
  logger.info('booking_stage', { ...logCtx, stage: 'inventory_check', duration_ms: Date.now() - invStart });

  // Fetch destination to compute price
  const dest = await destinationService.getById(destinationId);
  const totalAmount = dest.basePrice * travelers;

  // Stage 2: payment authorization
  const payStart = Date.now();
  let payment;
  try {
    payment = await authorizePayment(totalAmount, contactEmail);
    logger.info('booking_stage', { ...logCtx, stage: 'payment_authorized', duration_ms: Date.now() - payStart, amount: totalAmount });
  } catch (err) {
    logger.warn('booking_stage', { ...logCtx, stage: 'payment_declined', duration_ms: Date.now() - payStart, amount: totalAmount, reason: err.message });
    throw err;
  }

  // Stage 3: confirm and persist
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

  logger.info('booking_created', {
    booking_id: bookingId,
    destination: dest.name,
    destination_id: destinationId,
    travelers,
    total_amount: totalAmount,
    transaction_id: payment.transactionId,
    session_id: sessionId,
  });

  return booking;
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
