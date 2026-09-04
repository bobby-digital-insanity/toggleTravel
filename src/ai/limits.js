'use strict';

/**
 * Per-context sliding-window limits for the AI Planner.
 *
 * The limits themselves are LaunchDarkly config — the JSON flag
 * `ai-planner-limits`, evaluated against the full context so a tier can get a
 * bigger allowance:
 *
 *   { "conversation": { "max": 20, "windowMin": 10 },
 *     "agent":        { "max": 3,  "windowMin": 10 } }
 *
 * Turn timestamps live in SQLite (the same file the bookings use), not in
 * process memory, so the two PM2 cluster workers share one count.
 */

const db = require('../db');
const { getFlagFor } = require('../launchdarkly');
const { userOf } = require('./context');
const logger = require('../logger');

const LIMITS_FLAG = 'ai-planner-limits';
const DEFAULT_LIMITS = {
  conversation: { max: 20, windowMin: 10 },
  agent: { max: 3, windowMin: 10 },
};

let ready = false;
function ensureTable() {
  if (ready) return;
  db.run(`CREATE TABLE IF NOT EXISTS ai_turns (
    context_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ai_turns_key_mode_at ON ai_turns(context_key, mode, at)');
  ready = true;
}

function limitFor(config, mode) {
  const l = config && typeof config === 'object' ? config[mode] : null;
  const d = DEFAULT_LIMITS[mode] || DEFAULT_LIMITS.conversation;
  const max = Number.isFinite(Number(l?.max)) ? Number(l.max) : d.max;
  const windowMin = Number.isFinite(Number(l?.windowMin)) ? Number(l.windowMin) : d.windowMin;
  return { max, windowMin };
}

/**
 * @returns {Promise<{allowed: boolean, max: number, windowMin: number, used: number, retryAfterSec: number}>}
 */
async function checkLimit(context, mode) {
  const key = userOf(context).key || 'anonymous';
  const flag = await getFlagFor(LIMITS_FLAG, DEFAULT_LIMITS, context);
  const { max, windowMin } = limitFor(flag, mode);
  if (max <= 0) return { allowed: true, max, windowMin, used: 0, retryAfterSec: 0, unlimited: true };
  try {
    ensureTable();
    const since = Date.now() - windowMin * 60_000;
    // Opportunistic cleanup keeps the table tiny.
    db.run('DELETE FROM ai_turns WHERE at < ?', [Date.now() - 24 * 3600_000]);
    const row = db.get('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM ai_turns WHERE context_key = ? AND mode = ? AND at >= ?', [key, mode, since]);
    const used = Number(row?.n || 0);
    if (used >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((Number(row.oldest) + windowMin * 60_000 - Date.now()) / 1000));
      return { allowed: false, max, windowMin, used, retryAfterSec };
    }
    return { allowed: true, max, windowMin, used, retryAfterSec: 0 };
  } catch (err) {
    // A limiter outage must not take down the planner.
    logger.warn('ai_planner_limit_check_failed', { error: err.message });
    return { allowed: true, max, windowMin, used: 0, retryAfterSec: 0, degraded: true };
  }
}

function recordTurn(context, mode) {
  try {
    ensureTable();
    db.run('INSERT INTO ai_turns (context_key, mode, at) VALUES (?, ?, ?)', [userOf(context).key || 'anonymous', mode, Date.now()]);
  } catch (err) {
    logger.warn('ai_planner_limit_record_failed', { error: err.message });
  }
}

module.exports = { checkLimit, recordTurn, LIMITS_FLAG, DEFAULT_LIMITS };
