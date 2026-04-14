'use strict';

const logger = require('../logger');

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    logger.info('http_request', {
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
      user_agent: req.get('user-agent'),
      ip: req.ip,
    });
  });

  next();
}

module.exports = requestLogger;
