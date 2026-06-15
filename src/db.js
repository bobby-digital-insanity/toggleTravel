'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { trace, SpanStatusCode, SpanKind } = require('@opentelemetry/api');

const logger = require('./logger');

const tracer = trace.getTracer('toggletravel-db');

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
  // Idempotent: INSERT OR IGNORE picks up new destinations added to the JSON
  // without overwriting existing rows. Run on every boot.
  const seed = require('./data/destinations.json');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO destinations (id, name, region, tagline, description, base_price, currency,
      hero_image, activities, best_season, weather_summary, rating, duration, highlights)
    VALUES (@id, @name, @region, @tagline, @description, @base_price, @currency,
      @hero_image, @activities, @best_season, @weather_summary, @rating, @duration, @highlights)
  `);
  const tx = db.transaction((rows) => {
    let inserted = 0;
    for (const r of rows) {
      const result = insert.run(r);
      if (result.changes > 0) inserted += 1;
    }
    return inserted;
  });
  const inserted = tx(seed.map((d) => ({
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

  if (inserted > 0) logger.info('db_seeded', { table: 'destinations', rows_inserted: inserted });
}

function operationOf(sql) {
  const m = sql.trim().match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i);
  return m ? m[1].toUpperCase() : 'UNKNOWN';
}

function tableOf(sql) {
  const m = sql.match(/\b(?:FROM|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return m ? m[1] : undefined;
}

function withSpan(sql, fn) {
  const op = operationOf(sql);
  const table = tableOf(sql);
  const spanName = table ? `${op} ${table}` : op;

  return tracer.startActiveSpan(spanName, { kind: SpanKind.CLIENT }, (span) => {
    span.setAttributes({
      'db.system': 'sqlite',
      'db.name': path.basename(DB_PATH),
      'db.statement': sql,
      'db.operation': op,
      ...(table ? { 'db.sql.table': table } : {}),
    });
    try {
      const result = fn();
      if (Array.isArray(result)) span.setAttribute('db.row_count', result.length);
      else if (result && typeof result.changes === 'number') span.setAttribute('db.row_count', result.changes);
      else if (result && typeof result === 'object') span.setAttribute('db.row_count', 1);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
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
