'use strict';

/**
 * Sentry → LaunchDarkly metric bridge
 * ===================================
 *
 * Turns ANY Sentry dataset into a LaunchDarkly metric that can guard a guarded
 * rollout — not just error events (which is all LD's official Sentry integration
 * ingests).
 *
 * WHY A BRIDGE IS NECESSARY
 * -------------------------
 * A guarded rollout compares treatment against control, so every metric event
 * needs a randomization unit. LD's metric import API enforces this: `contextKeys`
 * is required on every event. Sentry's alert webhooks are aggregate-only — they
 * carry thresholds and a description, with no per-user or tag-level detail — so
 * "Sentry alert → webhook → LD" can never feed a guard metric. It can only act as
 * an external kill switch.
 *
 * This bridge instead reads INDIVIDUAL records out of Sentry, each carrying the
 * LD context key, and imports them as attributed custom events.
 *
 * THE JOIN KEY
 * ------------
 * Every Sentry record this app emits carries `session_id`, and that value IS the
 * LD context key (see the identity precedence in public/js/api.js sessionKey(),
 * public/js/flags.js, and src/middleware/requestLogger.js). src/metrics.js and
 * public/js/sentry.js attach it to every metric and log automatically. That
 * shared key is the whole reason this is possible.
 *
 * FLOW
 * ----
 *   Sentry Explore API                        LD metric import API
 *   dataset=tracemetrics|spans|logs|errors    events.launchdarkly.com
 *          │                                          ▲
 *          │ poll window                              │ contextKeys per event
 *          └──────────────► this bridge ──────────────┘
 *
 * USAGE
 *   node scripts/sentry-bridge.js --discover        # dump the raw Sentry schema
 *   node scripts/sentry-bridge.js --once            # one poll cycle, verbose
 *   require('./sentry-bridge').pollOnce()           # from traffic-conductor.js
 *
 * ENV
 *   SENTRY_AUTH_TOKEN        API token with org:read + project:read
 *   SENTRY_ORG / SENTRY_PROJECT
 *   SENTRY_BRIDGE_DATASET    default 'tracemetrics' (errors|logs|spans|tracemetrics)
 *   SENTRY_BRIDGE_QUERY      Sentry search filter, e.g. 'metric.name:checkout.failed'
 *   SENTRY_BRIDGE_FIELDS     comma-separated field list override (see --discover)
 *   SENTRY_BRIDGE_SESSION_FIELD  field holding the LD context key
 *   SENTRY_BRIDGE_EVENT_KEY  LD event key to import as (default 'sentry-checkout-latency')
 *   SENTRY_BRIDGE_WINDOW_MIN default 5 — how far back each poll looks
 *   SENTRY_BRIDGE_ENVIRONMENT  Sentry env to read from; unset = all
 *   LD_API_TOKEN             MUST have the `importEventData` action (see below)
 *   LD_PROJECT_KEY / LD_ENV_KEY
 */

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── Config ───────────────────────────────────────────────────────────────────

const SENTRY_BASE  = process.env.SENTRY_API_BASE || 'https://sentry.io';
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN || null;
const SENTRY_ORG   = process.env.SENTRY_ORG || null;
const SENTRY_PROJ  = process.env.SENTRY_PROJECT || null;

const DATASET       = process.env.SENTRY_BRIDGE_DATASET || 'tracemetrics';
const QUERY         = process.env.SENTRY_BRIDGE_QUERY || 'metric.name:checkout.duration';
const WINDOW_MIN    = num(process.env.SENTRY_BRIDGE_WINDOW_MIN, 5);
const EVENT_KEY     = process.env.SENTRY_BRIDGE_EVENT_KEY || 'sentry-checkout-latency';
// Which Sentry environment to READ from — deliberately NOT SENTRY_ENVIRONMENT.
// That variable says which environment this process WRITES as ('development'
// locally), and filtering reads by it returns "Unknown environments selected"
// whenever no data was ever written under that name. Unset means all
// environments, which is the useful default for discovery; set it to
// 'production' on the box to avoid importing local test data into the guard.
const SENTRY_ENV    = process.env.SENTRY_BRIDGE_ENVIRONMENT || undefined;

// The field holding the LD context key. Sentry exposes custom attributes as
// `tag[name,type]` in the Explore API, but naming differs per dataset, which is
// exactly what `--discover` is for — do not trust this default blindly.
const SESSION_FIELD = process.env.SENTRY_BRIDGE_SESSION_FIELD || 'tag[session_id,string]';

// Per-dataset default field lists. Overridable via SENTRY_BRIDGE_FIELDS because
// these are the least certain part of the whole bridge.
// Confirmed against the live API via --discover. `id` is present on every row
// and is the dedup key; without it, two distinct events with the same
// name/value/timestamp would collapse into one.
const DEFAULT_FIELDS = {
  tracemetrics: ['id', 'metric.name', 'value', 'timestamp'],
  spans:        ['id', 'span.description', 'span.duration', 'timestamp'],
  logs:         ['id', 'message', 'severity', 'timestamp'],
  errors:       ['id', 'title', 'timestamp'],
};

const LD_EVENTS_BASE = process.env.LD_EVENTS_BASE || 'https://events.launchdarkly.com';
const LD_TOKEN       = process.env.LD_API_TOKEN || null;
const LD_PROJECT     = process.env.LD_PROJECT_KEY || 'ToggleTravel';
const LD_ENV         = process.env.LD_ENV_KEY || null;

function num(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

function log(msg) {
  process.stdout.write(`[sentry-bridge ${new Date().toISOString()}] ${msg}\n`);
}

// ── Dedup ────────────────────────────────────────────────────────────────────
// Poll windows overlap on purpose (a record can land in Sentry slightly after
// its timestamp), so the same row will be seen more than once. Dedup on a
// content hash, bounded so this cannot grow without limit.
//
// This is in-memory: a process restart can re-import a window's worth of events.
// LD's X-LaunchDarkly-Payload-ID only dedups retries of an identical payload, not
// logically-duplicate events, so a restart mid-incident could double-count. For
// a demo that is acceptable; a production bridge would persist the watermark.
const seen = new Set();
const SEEN_MAX = 20000;

function rememberOnce(fingerprint) {
  if (seen.has(fingerprint)) return false;
  if (seen.size >= SEEN_MAX) seen.clear(); // cheap bound; loses history, not correctness
  seen.add(fingerprint);
  return true;
}

// ── Sentry query ─────────────────────────────────────────────────────────────

function fieldsFor(dataset) {
  if (process.env.SENTRY_BRIDGE_FIELDS) {
    return process.env.SENTRY_BRIDGE_FIELDS.split(',').map((f) => f.trim()).filter(Boolean);
  }
  return [...(DEFAULT_FIELDS[dataset] || DEFAULT_FIELDS.tracemetrics), SESSION_FIELD];
}

async function querySentry({ dataset = DATASET, query = QUERY, windowMin = WINDOW_MIN, perPage = 100, cursor } = {}) {
  if (!SENTRY_TOKEN || !SENTRY_ORG) {
    throw new Error('SENTRY_AUTH_TOKEN and SENTRY_ORG are required');
  }

  const params = new URLSearchParams();
  params.set('dataset', dataset);
  for (const f of fieldsFor(dataset)) params.append('field', f);
  if (query) params.set('query', query);
  params.set('statsPeriod', `${windowMin}m`);
  params.set('per_page', String(Math.min(perPage, 100))); // API max is 100
  params.set('sort', '-timestamp');
  if (SENTRY_PROJ) params.set('project', SENTRY_PROJ);
  if (SENTRY_ENV) params.set('environment', SENTRY_ENV);
  if (cursor) params.set('cursor', cursor);
  params.set('referrer', 'api.toggletravel.ld-bridge');

  const url = `${SENTRY_BASE}/api/0/organizations/${SENTRY_ORG}/events/?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SENTRY_TOKEN}` } });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Sentry API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  // Link header carries pagination; the table endpoint caps at 100 rows and is
  // explicitly not a bulk export, so deep pagination is a smell — prefer a
  // narrower query or a shorter window.
  return { rows: json.data || [], meta: json.meta || {}, link: res.headers.get('link') };
}

// ── Mapping ──────────────────────────────────────────────────────────────────

// Sentry returns tag fields under their full `tag[name,type]` key. Accept either
// that or a bare name, so a SENTRY_BRIDGE_SESSION_FIELD override works untouched.
function extractSessionId(row) {
  const bare = SESSION_FIELD.replace(/^tag\[/, '').replace(/,.*$/, '');
  return row[SESSION_FIELD] ?? row[bare] ?? row.session_id ?? null;
}

function rowToLdEvent(row, dataset) {
  const sessionId = extractSessionId(row);
  if (!sessionId) return null; // un-attributable — cannot guard a rollout

  const ts = row.timestamp ? Date.parse(row.timestamp) : Date.now();

  // metricValue: for tracemetrics/spans use the numeric value so LD can compute
  // means/percentiles; for logs/errors each row is one occurrence.
  const numeric = Number(row.value ?? row['span.duration']);
  const metricValue = Number.isFinite(numeric) ? numeric : 1;

  return {
    kind: 'custom',
    key: EVENT_KEY,
    creationDate: Number.isFinite(ts) ? ts : Date.now(),
    metricValue,
    contextKeys: { user: String(sessionId) },
    data: {
      source: 'sentry',
      dataset,
      ...(row['metric.name'] ? { metric_name: row['metric.name'] } : {}),
      ...(row.title ? { title: row.title } : {}),
      ...(row.message ? { message: String(row.message).slice(0, 200) } : {}),
    },
  };
}

// Prefer Sentry's own row id; fall back to a content hash only if a dataset
// somehow omits it.
function fingerprint(ev, row) {
  if (row?.id) return `id:${row.id}`;
  return 'h:' + crypto.createHash('sha1')
    .update(`${ev.key}|${ev.contextKeys.user}|${ev.creationDate}|${ev.metricValue}`)
    .digest('hex');
}

// ── LaunchDarkly import ──────────────────────────────────────────────────────

async function importToLd(events) {
  if (!events.length) return { imported: 0 };
  if (!LD_TOKEN) throw new Error('LD_API_TOKEN is required');
  if (!LD_ENV) throw new Error('LD_ENV_KEY is required (no safe default — see traffic-conductor.js)');

  const body = JSON.stringify(events);
  if (Buffer.byteLength(body) > 9_000_000) {
    throw new Error('payload exceeds the 10MB import limit — reduce the window or batch size');
  }

  const url = `${LD_EVENTS_BASE}/v2/event-data-import/${LD_PROJECT}/${LD_ENV}`;
  // Payload ID must be stable across retries of the SAME payload, so it is
  // generated once here and reused by the retry loop below.
  const payloadId = crypto.randomUUID();

  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: LD_TOKEN,
        'Content-Type': 'application/json',
        'X-LaunchDarkly-Event-Schema': '4',
        'X-LaunchDarkly-Payload-ID': payloadId,
        'User-Agent': 'MetricImport-ToggleTravel-int/1.0',
      },
      body,
    });

    if (res.ok) return { imported: events.length, status: res.status };

    const text = await res.text().catch(() => '');
    // Do not retry 4xx except 429 — a 401/403 means the token lacks the
    // `importEventData` action and retrying will never help.
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`LD import ${res.status}: ${text.slice(0, 300)}`
        + (res.status === 401 || res.status === 403
          ? ' — does LD_API_TOKEN have the importEventData action?' : ''));
    }
    if (attempt === 4) throw new Error(`LD import failed after ${attempt} attempts: ${res.status}`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return { imported: 0 };
}

// ── Public API ───────────────────────────────────────────────────────────────

async function pollOnce({ verbose = false } = {}) {
  const { rows, meta } = await querySentry({});
  const paired = rows.map((r) => ({ row: r, ev: rowToLdEvent(r, DATASET) })).filter((p) => p.ev);
  const attributable = paired.map((p) => p.ev);
  const fresh = paired
    .filter((p) => rememberOnce(fingerprint(p.ev, p.row)))
    .map((p) => p.ev);

  const dropped = rows.length - attributable.length;
  if (dropped > 0) {
    // The single most likely misconfiguration: the session field name is wrong
    // for this dataset, so nothing is attributable and the guard silently never
    // gets data. Say so loudly rather than reporting "0 imported".
    log(`WARNING: ${dropped}/${rows.length} rows had no "${SESSION_FIELD}" — those cannot guard a rollout. `
      + `Run --discover to confirm the field name for dataset=${DATASET}.`);
  }

  let imported = 0;
  if (fresh.length) {
    const result = await importToLd(fresh);
    imported = result.imported;
  }

  if (verbose || imported > 0 || dropped > 0) {
    log(`dataset=${DATASET} rows=${rows.length} attributable=${attributable.length} fresh=${fresh.length} imported=${imported} -> LD event "${EVENT_KEY}"`);
  }
  return { rows: rows.length, attributable: attributable.length, imported, meta };
}

// Dump the raw Sentry response so the real field names can be read off it,
// rather than guessed. The tracemetrics/spans schemas are the least documented
// part of this and differ per dataset.
async function discover() {
  log(`discovering schema for dataset=${DATASET} (org=${SENTRY_ORG}, project=${SENTRY_PROJ})`);
  log(`requested fields: ${JSON.stringify(fieldsFor(DATASET))}`);
  log(`query: ${QUERY || '(none)'}   window: ${WINDOW_MIN}m`);
  const { rows, meta } = await querySentry({ perPage: 5 });
  console.log('\n--- meta.fields ---');
  console.log(JSON.stringify(meta.fields || meta, null, 2));
  console.log('\n--- first rows ---');
  console.log(JSON.stringify(rows.slice(0, 5), null, 2));
  console.log('\n--- attribution check ---');
  for (const r of rows.slice(0, 5)) {
    console.log(`  session_id -> ${JSON.stringify(extractSessionId(r))}`);
  }
  if (!rows.length) {
    log('no rows returned — widen SENTRY_BRIDGE_WINDOW_MIN, loosen SENTRY_BRIDGE_QUERY, or generate traffic first');
  }
}

module.exports = { pollOnce, querySentry, discover, rowToLdEvent, importToLd, EVENT_KEY };

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const mode = process.argv.includes('--discover') ? 'discover' : 'once';
  (mode === 'discover' ? discover() : pollOnce({ verbose: true }))
    .then(() => process.exit(0))
    .catch((err) => { log(`ERROR: ${err.message}`); process.exit(1); });
}
