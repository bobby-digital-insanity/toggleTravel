'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const logger = require('./logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');

const healthRouter = require('./routes/health');
const destinationsRouter = require('./routes/destinations');
const searchRouter = require('./routes/search');
const bookingsRouter = require('./routes/bookings');
const vacationModeRouter = require('./routes/vacationMode');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & perf middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Request logging
app.use(requestLogger);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health routes (no /api prefix)
app.use('/', healthRouter);

// API routes
app.use('/api/destinations', destinationsRouter);
app.use('/api/search', searchRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/vacation-mode', vacationModeRouter);

// SPA fallback for client-side routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Centralized error handler (must be last)
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info('server_started', { port: PORT, env: process.env.NODE_ENV || 'development' });
});

module.exports = app;
