'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const router = express.Router();
const logger = require('../logger');

// Not present on every branch — each observability vendor's branch swaps in its
// own instrumentation package. Mirrors the guard in logger.js's LDTransport.
let LDObserve;
let errorTracer;
try {
  LDObserve = require('@launchdarkly/observability-node').LDObserve;
  errorTracer = require('@opentelemetry/api').trace.getTracer('toggletravel-demo');
} catch (_) {
  // Package not available on this branch — /trigger-errors reports 501
}

const SEED_SCRIPT = path.join(__dirname, '../../scripts/playwright-load.js');

const VALID_BROWSERS = new Set(['chrome', 'firefox', 'safari', 'iphone', 'pixel']);

let activeJob = null; // { child, startedAt, rounds, browsers }
let errorBurstActive = false; // guards /trigger-errors against overlapping runs

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POST /api/demo/seed — start load generation, stream output as ndjson
router.post('/seed', (req, res) => {
  if (activeJob) {
    return res.status(409).json({ error: 'Load generation already running', startedAt: activeJob.startedAt });
  }

  const rounds   = Math.min(Math.max(parseInt(req.body.rounds || '3', 10), 1), 10);
  const pause    = Math.min(Math.max(parseInt(req.body.pause  || '3', 10), 1), 30);
  const atlantis     = Math.min(Math.max(parseInt(req.body.atlantis || '1', 10), 1), 20);
  const atlantisOnly = req.body.atlantisOnly === true;
  const rawBrowsers = Array.isArray(req.body.browsers) ? req.body.browsers : (req.body.browsers || 'chrome').split(',');
  const browsers = [...new Set(rawBrowsers.map((b) => b.trim().toLowerCase()).filter((b) => VALID_BROWSERS.has(b)))];
  const browsersArg = browsers.length ? browsers.join(',') : 'chrome';

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  function send(type, payload = {}) {
    res.write(JSON.stringify({ type, ...payload }) + '\n');
    if (typeof res.flush === 'function') res.flush(); // drain compression buffer
  }

  send('log', { line: `Starting seed script: ${SEED_SCRIPT}` });

  const child = spawn(process.execPath, [
    SEED_SCRIPT,
    '--host', 'http://localhost:3000',
    '--rounds', String(rounds),
    '--pause', String(pause),
    '--browsers', browsersArg,
    '--atlantis', String(atlantis),
    ...(atlantisOnly ? ['--atlantis-only'] : []),
  ]);

  activeJob = { child, startedAt: new Date().toISOString(), rounds, browsers: browsersArg };

  // Keep the NDJSON stream alive through long Playwright flush waits (avoids nginx/proxy timeouts).
  const keepalive = setInterval(() => {
    if (!res.writableEnded) send('log', { line: '… still running' });
  }, 20000);

  child.on('error', (err) => {
    clearInterval(keepalive);
    send('log', { line: `✗ Failed to start process: ${err.message}`, error: true });
    send('done', { code: 1, rounds });
    activeJob = null;
    res.end();
  });

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) send('log', { line });
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) send('log', { line, error: true });
    }
  });

  child.on('close', (code) => {
    clearInterval(keepalive);
    send('done', { code: code ?? 1, rounds });
    activeJob = null;
    res.end();
  });

  // If client disconnects mid-run, kill the child.
  // Use res.on('close') rather than req.on('close') — in Node 18+, req emits
  // 'close' as soon as the request body is consumed (i.e. immediately after
  // express.json() parses the body), which would kill the child right after spawn.
  // res.on('close') only fires when the connection is actually torn down.
  res.on('close', () => {
    clearInterval(keepalive);
    if (activeJob && !res.writableEnded) {
      activeJob.child.kill();
      activeJob = null;
    }
  });
});

// GET /api/demo/status — check if a run is in progress
router.get('/status', (req, res) => {
  res.json({
    running: !!activeJob,
    ...(activeJob && { startedAt: activeJob.startedAt, rounds: activeJob.rounds }),
  });
});

// DELETE /api/demo/seed — cancel a running job
router.delete('/seed', (req, res) => {
  if (!activeJob) return res.status(404).json({ error: 'No job running' });
  activeJob.child.kill();
  activeJob = null;
  res.json({ cancelled: true });
});

// POST /api/demo/trigger-errors — fire a controllable number of synthetic
// errors through LDObserve.recordError(), for exercising LD Observability
// "Errors" alerts (e.g. Constant threshold behavior) on demand.
// Body: { count?: number (1-500, default 1), intervalMs?: number (0-60000,
//         default 2000, spacing between calls), dryRun?: boolean }
router.post('/trigger-errors', async (req, res) => {
  if (!LDObserve) {
    return res.status(501).json({ error: 'LD Observability SDK not available on this branch' });
  }
  if (errorBurstActive) {
    return res.status(409).json({ error: 'Error burst already running' });
  }

  const count = Math.min(Math.max(parseInt(req.body.count ?? '1', 10) || 1, 1), 500);
  const intervalMs = Math.min(Math.max(parseInt(req.body.intervalMs ?? '2000', 10) || 0, 0), 60000);
  const dryRun = req.body.dryRun === true;
  const batchId = crypto.randomUUID();

  errorBurstActive = true;
  res.json({
    batchId,
    count,
    intervalMs,
    dryRun,
    estimatedDurationMs: (count - 1) * intervalMs,
  });

  (async () => {
    try {
      for (let i = 0; i < count; i++) {
        if (!dryRun) {
          const err = new Error('alert_test_synthetic_error');
          // recordError() defaults to the ambient active span (and ends it) when
          // no span is given — inside one request handler's context, every call
          // after the first would land on an already-ended span and be dropped.
          // Passing a fresh span per call keeps each occurrence independent.
          const span = errorTracer.startSpan('alert-test-error');
          LDObserve.recordError(err, undefined, undefined, {
            synthetic: true,
            test: 'alert-threshold',
            batchId,
            index: i,
            total: count,
          }, { span });
        }
        logger.info('alert_test_error_triggered', { batchId, index: i + 1, total: count, dryRun });
        if (i < count - 1 && intervalMs > 0) await sleep(intervalMs);
      }
      logger.info('alert_test_batch_complete', { batchId, total: count, dryRun });
    } finally {
      errorBurstActive = false;
    }
  })();
});

module.exports = router;
