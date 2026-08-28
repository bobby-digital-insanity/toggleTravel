'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const Sentry = require('@sentry/node');

const logger = require('./logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'toggle.db');

let db = null;

function init() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate();
  seedDestinations();

  logger.info('db_initialized', { path: DB_PATH });
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS destinations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      tagline TEXT,
      description TEXT,
      base_price INTEGER NOT NULL,
      currency TEXT,
      hero_image TEXT,
      activities TEXT,
      best_season TEXT,
      weather_summary TEXT,
      rating REAL,
      duration INTEGER,
      highlights TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_destinations_region ON destinations(region);
    CREATE INDEX IF NOT EXISTS idx_destinations_base_price ON destinations(base_price);

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      destination_id TEXT NOT NULL,
      destination_name TEXT NOT NULL,
      travelers INTEGER NOT NULL,
      departure_date TEXT,
      return_date TEXT,
      contact_email TEXT NOT NULL,
      total_amount INTEGER NOT NULL,
      transaction_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (destination_id) REFERENCES destinations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bookings_contact_email ON bookings(contact_email);
  `);
}

function seedDestinations() {
  // JSON is the source of truth: upsert every row on boot so edits to the JSON
  // (new destinations, image swaps, price changes) propagate without breaking
  // the bookings.destination_id foreign key (INSERT OR REPLACE would delete+reinsert
  // and trip the FK).
  const seed = require('./data/destinations.json');
  const upsert = db.prepare(`
    INSERT INTO destinations (id, name, region, tagline, description, base_price, currency,
      hero_image, activities, best_season, weather_summary, rating, duration, highlights)
    VALUES (@id, @name, @region, @tagline, @description, @base_price, @currency,
      @hero_image, @activities, @best_season, @weather_summary, @rating, @duration, @highlights)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      region = excluded.region,
      tagline = excluded.tagline,
      description = excluded.description,
      base_price = excluded.base_price,
      currency = excluded.currency,
      hero_image = excluded.hero_image,
      activities = excluded.activities,
      best_season = excluded.best_season,
      weather_summary = excluded.weather_summary,
      rating = excluded.rating,
      duration = excluded.duration,
      highlights = excluded.highlights
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) upsert.run(r);
  });
  tx(seed.map((d) => ({
    id: d.id,
    name: d.name,
    region: d.region,
    tagline: d.tagline,
    description: d.description,
    base_price: d.basePrice,
    currency: d.currency,
    hero_image: d.heroImage,
    activities: JSON.stringify(d.activities || []),
    best_season: d.bestSeason,
    weather_summary: d.weatherSummary,
    rating: d.rating,
    duration: d.duration,
    highlights: JSON.stringify(d.highlights || []),
  })));

  logger.info('db_seeded', { table: 'destinations', rows: seed.length });
}

function operationOf(sql) {
  const m = sql.trim().match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i);
  return m ? m[1].toUpperCase() : 'UNKNOWN';
}

function tableOf(sql) {
  const m = sql.match(/\b(?:FROM|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return m ? m[1] : undefined;
}

// better-sqlite3 is synchronous and has no Sentry auto-instrumentation, so every
// query is wrapped in a manual span. This is what puts SQLite timings inside the
// request waterfall in Sentry Performance instead of leaving a silent gap
// between "request received" and "response sent".
//
// The launchdarkly branch wraps these same calls in raw OpenTelemetry spans via
// @opentelemetry/api — a package that arrives transitively with the LD
// Observability SDK. That SDK is absent here, so the span API is Sentry's.
function withSpan(sql, fn) {
  const op = operationOf(sql);
  const table = tableOf(sql);
  const spanName = table ? `${op} ${table}` : op;

  return Sentry.startSpan(
    {
      name: spanName,
      op: 'db.query',
      attributes: {
        'db.system': 'sqlite',
        'db.name': path.basename(DB_PATH),
        'db.statement': sql,
        'db.query.text': sql,
        'db.operation': op,
        ...(table ? { 'db.sql.table': table } : {}),
      },
    },
    (span) => {
      const result = fn();
      if (Array.isArray(result)) span?.setAttribute('db.row_count', result.length);
      else if (result && typeof result.changes === 'number') span?.setAttribute('db.row_count', result.changes);
      else if (result && typeof result === 'object') span?.setAttribute('db.row_count', 1);
      return result;
    }
  );
}

function all(sql, params = {}) {
  return withSpan(sql, () => db.prepare(sql).all(params));
}

function get(sql, params = {}) {
  return withSpan(sql, () => db.prepare(sql).get(params));
}

function run(sql, params = {}) {
  return withSpan(sql, () => db.prepare(sql).run(params));
}

module.exports = { init, all, get, run, DB_PATH };
