'use strict';

/**
 * `get_weather_forecast` — the real-data half of the AI Planner's agent mode.
 *
 * The schema and description live in LaunchDarkly (project tool
 * `get_weather_forecast`); this module is only the implementation that the tool
 * registry binds to that name. Forecasts come from Open-Meteo, which needs no
 * API key — so there is no new secret to inject on deploy.
 */

const logger = require('../logger');

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS || 6000);

// WMO weather codes → label, and whether a traveler would call it severe.
// https://open-meteo.com/en/docs — codes 95+ are thunderstorms.
const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Rain showers', 81: 'Heavy showers', 82: 'Violent showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};
const SEVERE_CODES = new Set([65, 75, 82, 95, 96, 99]);

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Destinations Toggle Travel sells that are not real places. Atlantis (dest-013)
// is in the catalog on purpose, and "Atlantis" geocodes to a real town near Cape
// Town — so without this guard the tool would return a confident, entirely wrong
// forecast for it. Fictional places have no weather; say so.
const FICTIONAL = [/^atlantis\b/i];

function isFictionalPlace(name) {
  return FICTIONAL.some((re) => re.test(String(name || '').trim()));
}

// Name → coordinates. Open-Meteo's geocoder matches on a bare place name, so
// "Marrakech, Morocco" misses while "Marrakech" hits — try the full string
// first, then progressively shorter prefixes.
async function geocode(location) {
  const attempts = [location];
  const head = String(location).split(',')[0].trim();
  if (head && head !== location) attempts.push(head);

  for (const attempt of attempts) {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(attempt)}&count=1&language=en&format=json`;
    const data = await fetchJson(url);
    const hit = data.results?.[0];
    if (hit) {
      return { lat: hit.latitude, lon: hit.longitude, resolvedName: [hit.name, hit.country].filter(Boolean).join(', ') };
    }
  }
  return null;
}

/**
 * Tool implementation. Returns a plain object; the agent runner stringifies it.
 * Errors are returned as data rather than thrown — a tool that throws ends the
 * agent's turn, while an error it can read lets it report the gap honestly.
 */
async function getWeatherForecast({ location, lat, lon, days } = {}) {
  const started = Date.now();
  const span = Math.min(Math.max(Number(days) || 7, 1), 16);

  if (isFictionalPlace(location)) {
    return { error: `"${location}" is not a real place, so there is no weather forecast for it. Do not recommend it on weather grounds.` };
  }

  try {
    let coords = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    let resolvedName = location || null;

    if (!coords) {
      if (!location) return { error: 'Provide either a location name or both lat and lon.' };
      const geo = await geocode(location);
      if (!geo) {
        // Atlantis lands here by design: no real place, so no forecast.
        return { error: `No such place found: "${location}". It may not be a real location, so no forecast exists for it.` };
      }
      coords = { lat: geo.lat, lon: geo.lon };
      resolvedName = geo.resolvedName;
    }

    const url = `${FORECAST_URL}?latitude=${coords.lat}&longitude=${coords.lon}`
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max,weather_code'
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=mm&forecast_days=${span}&timezone=auto`;
    const data = await fetchJson(url);
    const d = data.daily || {};

    const forecast = (d.time || []).map((date, i) => {
      const code = d.weather_code?.[i];
      return {
        date,
        highF: Math.round(d.temperature_2m_max?.[i]),
        lowF: Math.round(d.temperature_2m_min?.[i]),
        precipChancePct: d.precipitation_probability_max?.[i] ?? null,
        precipMm: d.precipitation_sum?.[i] ?? null,
        windGustMph: Math.round(d.wind_gusts_10m_max?.[i] ?? 0),
        conditions: WMO[code] || `Code ${code}`,
        severe: SEVERE_CODES.has(code) || (d.wind_gusts_10m_max?.[i] ?? 0) > 40,
      };
    });

    logger.info('tool_weather_forecast', {
      location: resolvedName, days: forecast.length, duration_ms: Date.now() - started,
    });

    return { location: resolvedName, latitude: coords.lat, longitude: coords.lon, units: { temperature: 'F', wind: 'mph', precipitation: 'mm' }, forecast };
  } catch (err) {
    logger.warn('tool_weather_forecast_failed', { location, error: err.message });
    return { error: `Weather lookup failed: ${err.message}` };
  }
}

module.exports = { getWeatherForecast, isFictionalPlace, WMO };
