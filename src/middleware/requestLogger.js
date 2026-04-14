'use strict';

const logger = require('../logger');

function requestLogger(req, res, next) {
  const start = Date.now();
  const sessionId = req.get('x-session-id') || null;

  // Attach session ID so routes/services can include it in their own logs
  if (sessionId) req.sessionId = sessionId;

  res.on('finish', () => {
    const fields = {
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
      user_agent: req.get('user-agent'),
      ip: req.ip,
    };
    if (sessionId) fields.session_id = sessionId;
    logger.info('http_request', fields);
  });

  next();
}

module.exports = requestLogger;
