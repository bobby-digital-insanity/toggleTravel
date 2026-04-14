'use strict';

const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const router = express.Router();

const SEED_SCRIPT = path.join(__dirname, '../../scripts/seed-load.js');

let activeJob = null; // { child, startedAt, rounds }

// POST /api/demo/seed — start load generation, stream output as ndjson
router.post('/seed', (req, res) => {
  if (activeJob) {
    return res.status(409).json({ error: 'Load generation already running', startedAt: activeJob.startedAt });
  }

  const rounds = Math.min(Math.max(parseInt(req.body.rounds || '3', 10), 1), 10);
  const pause  = Math.min(Math.max(parseInt(req.body.pause  || '3', 10), 1), 30);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  function send(type, payload = {}) {
    res.write(JSON.stringify({ type, ...payload }) + '\n');
  }

  const child = spawn(process.execPath, [
    SEED_SCRIPT,
    '--host', 'http://localhost:3000',
    '--rounds', String(rounds),
    '--pause', String(pause),
  ]);

  activeJob = { child, startedAt: new Date().toISOString(), rounds };

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
    send('done', { code, rounds });
    activeJob = null;
    res.end();
  });

  // If client disconnects mid-run, kill the child
  req.on('close', () => {
    if (activeJob) {
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
