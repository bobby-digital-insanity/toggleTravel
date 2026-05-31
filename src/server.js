'use strict';

require('dotenv').config();

// Must be required before express for LD Observability auto-instrumentation
const ld = require('./launchdarkly');

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
const demoRouter = require('./routes/demo');
const aiPlannerRouter = require('./routes/aiPlanner');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & perf middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  allowedHeaders: ["Content-Type", "Authorization", "traceparent", "tracestate", "x-highlight-request"],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Request logging
app.use(requestLogger);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health routes (no /api prefix)
app.use('/', healthRouter);

// Expose client-side LD ID to the frontend
app.get('/api/config', (req, res) => {
  res.json({ ldClientSideId: ld.getClientSideId() });
});

// API routes
app.use('/api/destinations', destinationsRouter);
app.use('/api/search', searchRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/vacation-mode', vacationModeRouter);
app.use('/api/demo', demoRouter);
app.use('/api/ai-planner', aiPlannerRouter);

// AI Planner page (extensionless route)
app.get('/ai-planner', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ai-planner.html'));
});

// SPA fallback for client-side routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Centralized error handler (must be last)
app.use(errorHandler);

ld.init().then(() => {
  app.listen(PORT, () => {
    logger.info('server_started', { port: PORT, env: process.env.NODE_ENV || 'development' });
  });
});

module.exports = app;
