'use strict';

const express = require('express');
const router = express.Router();
const bookingService = require('../services/bookingService');
const { getFlag, track } = require('../launchdarkly');
const logger = require('../logger');

router.post('/', async (req, res, next) => {
  try {
    const { destinationId, travelers, departureDate, returnDate, contactEmail } = req.body;

    if (!destinationId || !travelers || !contactEmail) {
      const err = new Error('Missing required fields: destinationId, travelers, contactEmail');
      err.status = 400;
      throw err;
    }

    // Flag-gated checkout version. When new-checkout-flow is ON for this
    // request's context, the "v2" code path runs — a bad deploy that fails
    // EVERY confirm with a 500 (all destinations). The flag is served via a
    // guarded rollout (started daily at 7am ET by the traffic conductor), so
    // only the treatment arm hits this; the control arm checks out normally.
    // LaunchDarkly watches the booking-error metric and auto-rolls-back within
    // minutes. booking-error is tracked server-side here (same context key that
    // evaluated the flag) so the guard is fed by API traffic too, not just
    // browser sessions.
    //
    // getFlag() also tags this request's Sentry scope with
    // flag.new-checkout-flow, so the 500 below arrives in Sentry already
    // labelled with the flag that caused it.
    const useV2Checkout = await getFlag('new-checkout-flow', false, req.sessionId);
    if (useV2Checkout) {
      logger.error('checkout_v2_failed', {
        checkout_version: 'v2',
        destination_id: destinationId,
        session_id: req.sessionId,
        error: 'payment intent missing',
      });
      track('booking-error', req.sessionId, { destination_id: destinationId, http_status: 500 });
      const err = new Error('CheckoutV2Error: payment intent missing — unable to confirm booking');
      err.status = 500;
      throw err;
    }

    const booking = await bookingService.create({ destinationId, travelers, departureDate, returnDate, contactEmail, sessionId: req.sessionId });
    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res, next) => {
  try {
    res.json({ bookings: bookingService.list() });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    res.json({ booking: bookingService.getById(req.params.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
