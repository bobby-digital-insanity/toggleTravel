'use strict';

const express = require('express');
const router = express.Router();
const bookingService = require('../services/bookingService');
const { getFlag } = require('../launchdarkly');
const logger = require('../logger');

router.post('/', async (req, res, next) => {
  try {
    const { destinationId, travelers, departureDate, returnDate, contactEmail } = req.body;

    if (!destinationId || !travelers || !departureDate || !contactEmail) {
      const err = new Error('Missing required fields: destinationId, travelers, departureDate, contactEmail');
      err.status = 400;
      throw err;
    }

    // Flag-gated checkout version. When new-checkout-flow is ON, the "v2"
    // code path runs — it has a bug that fails ~half of confirms with a 500.
    // Toggling the flag OFF in LaunchDarkly reverts to the stable v1 path
    // instantly (evaluated per request). The traffic conductor turns it ON
    // daily at 8am ET to simulate a bad deploy.
    const useV2Checkout = await getFlag('new-checkout-flow', false, req.sessionId);
    if (useV2Checkout && Math.random() < 0.5) {
      logger.error('checkout_v2_failed', {
        checkout_version: 'v2',
        destination_id: destinationId,
        session_id: req.sessionId,
        error: 'payment intent missing',
      });
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

router.get('/', (req, res) => {
  const all = bookingService.list();
  res.json({ bookings: all });
});

router.get('/:id', (req, res, next) => {
  try {
    const booking = bookingService.getById(req.params.id);
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
