'use strict';

const BASE = '';

// Same identity precedence as flags.js — keeps the server-side LD context key
// aligned with the browser SDK's context, so server flag evaluations and
// logs/traces attribute to the same user.
function sessionKey() {
  try {
    return (
      localStorage.getItem('tt-user-email') ||
      localStorage.getItem('tt-persona-email') ||
      localStorage.getItem('tt-session-id') ||
      ''
    );
  } catch (_) {
    return '';
  }
}

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  const key = sessionKey();
  if (key) opts.headers['x-session-id'] = key;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  const traceId = res.headers.get('x-trace-id');

  if (traceId) {
    console.log(`[Toggle Travel] Trace ID: ${traceId} — ${method} ${path}`);
    showTraceBanner(traceId, method, path);
  }

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.traceId = traceId;
    throw err;
  }
  return data;
}

const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
};

// Trace ID banner for demo visibility
let bannerTimeout;
function showTraceBanner(traceId, method, path) {
  let banner = document.getElementById('trace-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'trace-banner';
    banner.className = 'trace-banner';
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<span>🔍</span><span><strong>Trace:</strong> ${traceId.slice(0, 16)}…</span><span style="opacity:.6">${method} ${path}</span>`;
  banner.classList.add('visible');
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => banner.classList.remove('visible'), 5000);
}

window.api = api;
