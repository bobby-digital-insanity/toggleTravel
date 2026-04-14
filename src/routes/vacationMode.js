'use strict';

const express = require('express');
const router = express.Router();
const vacationModeService = require('../services/vacationModeService');

router.post('/', async (req, res, next) => {
  try {
    const { enabled, preferences, bookingHistory } = req.body;

    if (typeof enabled !== 'boolean') {
      const err = new Error('Field "enabled" must be a boolean');
      err.status = 400;
      throw err;
    }

    const result = await vacationModeService.toggle({ enabled, preferences, bookingHistory });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
