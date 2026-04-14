'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const { authorizePayment } = require('./externalMockService');
const destinationService = require('./destinationService');

// In-memory bookings store
const bookings = new Map();

async function create({ destinationId, travelers, departureDate, returnDate, contactEmail }) {
  // Simulate inventory check
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));

  // Fetch destination to compute price
  const dest = await destinationService.getById(destinationId);
  const totalAmount = dest.basePrice * travelers;

  // Authorize payment (may throw with 5% probability)
  const payment = await authorizePayment(totalAmount, contactEmail);

  // Persist booking
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

  logger.info('booking_created', {
    booking_id: bookingId,
    destination: dest.name,
    travelers,
    total_amount: totalAmount,
    transaction_id: payment.transactionId,
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
