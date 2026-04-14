'use strict';

const logger = require('../logger');

function errorHandler(err, req, res, next) {
  logger.error('unhandled_error', {
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
  });

  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}

module.exports = errorHandler;
