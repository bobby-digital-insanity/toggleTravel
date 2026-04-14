'use strict';

const express = require('express');
const router = express.Router();
const bookingService = require('../services/bookingService');

router.post('/', async (req, res, next) => {
  try {
    const { destinationId, travelers, departureDate, returnDate, contactEmail } = req.body;

    if (!destinationId || !travelers || !departureDate || !contactEmail) {
      const err = new Error('Missing required fields: destinationId, travelers, departureDate, contactEmail');
      err.status = 400;
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
