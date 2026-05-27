'use strict';

const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const router = express.Router();

const SEED_SCRIPT = path.join(__dirname, '../../scripts/playwright-load.js');

const VALID_BROWSERS = new Set(['chrome', 'firefox', 'safari', 'iphone', 'pixel']);

let activeJob = null; // { child, startedAt, rounds, browsers }

// POST /api/demo/seed — start load generation, stream output as ndjson
router.post('/seed', (req, res) => {
  if (activeJob) {
    return res.status(409).json({ error: 'Load generation already running', startedAt: activeJob.startedAt });
  }

  const rounds = Math.min(Math.max(parseInt(req.body.rounds || '3', 10), 1), 10);
  const pause  = Math.min(Math.max(parseInt(req.body.pause  || '3', 10), 1), 30);
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

module.exports = router;
