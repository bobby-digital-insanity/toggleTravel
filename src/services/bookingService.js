'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const db = require('../db');
const { authorizePayment } = require('./externalMockService');
const destinationService = require('./destinationService');
const ld = require('../launchdarkly');

function rowToBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    destinationId: row.destination_id,
    destinationName: row.destination_name,
    travelers: row.travelers,
    departureDate: row.departure_date,
    returnDate: row.return_date,
    contactEmail: row.contact_email,
    totalAmount: row.total_amount,
    transactionId: row.transaction_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

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

  // Atlantis is unreachable unless the flag is on — demos LD Observability Errors + kill switch
  if (destinationId === 'dest-013') {
    const atlantisEnabled = await ld.getFlag('atlantis-booking-enabled', false, sessionId);
    if (!atlantisEnabled) {
      logger.error('booking_failed_destination_unreachable', {
        ...logCtx,
        destination_name: dest.name,
        contact_email: contactEmail,
        quoted_amount: totalAmount,
      });
      const err = new Error(`Destination unreachable: ${dest.name} is not currently bookable`);
      err.status = 404;
      throw err;
    }
  }

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

  db.run(
    `INSERT INTO bookings (id, destination_id, destination_name, travelers, departure_date, return_date,
      contact_email, total_amount, transaction_id, status, created_at)
     VALUES (@id, @destination_id, @destination_name, @travelers, @departure_date, @return_date,
       @contact_email, @total_amount, @transaction_id, @status, @created_at)`,
    {
      id: booking.id,
      destination_id: booking.destinationId,
      destination_name: booking.destinationName,
      travelers: booking.travelers,
      departure_date: booking.departureDate,
      return_date: booking.returnDate,
      contact_email: booking.contactEmail,
      total_amount: booking.totalAmount,
      transaction_id: booking.transactionId,
      status: booking.status,
      created_at: booking.createdAt,
    }
  );

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
  const row = db.get('SELECT * FROM bookings WHERE id = @id', { id });
  if (!row) {
    const err = new Error(`Booking not found: ${id}`);
    err.status = 404;
    throw err;
  }
  return rowToBooking(row);
}

function list() {
  const rows = db.all('SELECT * FROM bookings ORDER BY created_at DESC');
  return rows.map(rowToBooking);
}

module.exports = { create, getById, list };
