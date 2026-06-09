'use strict';

// LaunchDarkly JS Client SDK
// Fetches the client-side ID from /api/config, initializes the LD client,
// and exposes flag reads + real-time change listeners via window.LDFlags.

window.LDFlags = (function () {
  let ldClient = null;
  let initPromise = null;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const DEFAULTS = {
    'show-demo-panel':        true,
    'featured-destinations':  [],
    'booking-flow-variant':   'standard',
    'promo-banner-text':      '',
    'ai-planner-enabled':     true,
  };

  // Set by Playwright load script (scripts/playwright-load.js) per browser session
  function isLoadGen() {
    return !!localStorage.getItem('tt-run-id');
  }

  // Resolve or create a stable anonymous session key
  function getSessionKey() {
    let key = localStorage.getItem('tt-session-id');
    if (!key) {
      key = 'anon-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('tt-session-id', key);
    }
    return key;
  }

  async function init() {
    if (ldClient) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
    try {
      const res = await fetch('/api/config');
      const { ldClientSideId } = await res.json();

      if (!ldClientSideId) {
        console.warn('[LD] No client-side ID configured — using flag defaults');
        return;
      }

      const runId       = localStorage.getItem('tt-run-id');
      const personaEmail = localStorage.getItem('tt-persona-email');
      const tier         = localStorage.getItem('tt-user-tier');
      const tierEmail    = localStorage.getItem('tt-user-email');
      const tierName     = localStorage.getItem('tt-user-name');
      const key          = tierEmail || personaEmail || getSessionKey();
      const context      = {
        kind: 'user',
        key,
        name: tierName || personaEmail || runId || undefined,
        ...(runId ? { loadRunId: runId } : {}),
        ...(tier ? { tier } : {}),
      };
      console.log('[LD] Initializing with client-side ID:', ldClientSideId.slice(0, 8) + '...');

      const plugins = [];
      if (typeof Observability !== 'undefined' && Observability.default) {
        plugins.push(new Observability.default({
          tracingOrigins: true,
          networkRecording: {
            enabled: true,
            recordHeadersAndBody: true,
          },
        }));
        console.log('[LD] Observability plugin enabled');
      }
      if (typeof SessionReplay !== 'undefined' && SessionReplay.default) {
        // LD defaults to privacySetting 'strict' (masks all text + images). Use 'none' for
        // readable demo replays; switch to 'default' in production to mask PII inputs/patterns.
        plugins.push(new SessionReplay.default({
          privacySetting: 'none',
          inlineStylesheet: true,
          inlineImages: true,
        }));
        console.log('[LD] Session Replay plugin enabled (privacySetting: none)');
      }

      ldClient = LDClient.initialize(ldClientSideId, context, { plugins });

      await ldClient.waitForInitialization(5);
      console.log('[LD] Client SDK initialized — flags ready');
    } catch (err) {
      console.warn('[LD] Init failed — using flag defaults:', err.message);
    } finally {
      readyResolve();
    }
    })();

    return initPromise;
  }

  // Read a flag value, falling back to the defined default
  function get(key) {
    const defaultValue = key in DEFAULTS ? DEFAULTS[key] : null;
    if (!ldClient) return defaultValue;
    return ldClient.variation(key, defaultValue);
  }

  // Subscribe to real-time flag changes
  function onChange(key, callback) {
    if (!ldClient) return;
    ldClient.on('change:' + key, callback);
  }

  // Push the final replay payload (call before closing the browser in load gen).
  // Do NOT call LDRecord.stop() or dispatch beforeunload — both cancel in-flight uploads.
  async function flushSessionReplay() {
    await ready;

    const state = window.LDRecord?.getRecordingState?.() ?? 'unknown';

    try {
      if (ldClient && typeof ldClient.flush === 'function') {
        await ldClient.flush();
      }
      console.log('[LD] Session replay flush started (state:', state, ')');
      return true;
    } catch (err) {
      console.warn('[LD] Session replay flush failed:', err.message);
      return false;
    }
  }

  // Identify a known user — call when their email becomes known (e.g. booking form, user select)
  async function identify(email, extras = {}) {
    if (!email) return;
    // Load-gen personas are already the LD context key via tt-persona-email; re-identify tears down replay
    if (isLoadGen()) return;
    await ready;
    if (!ldClient) return;
    try {
      const runId = localStorage.getItem('tt-run-id');
      const ctx = { kind: 'user', key: email, name: email, ...(runId ? { loadRunId: runId } : {}), ...extras };
      await ldClient.identify(ctx);
      console.log('[LD] Identified user:', email, extras);
    } catch (err) {
      console.warn('[LD] identify failed:', err.message);
    }
  }

  return { init, get, onChange, identify, flushSessionReplay, isLoadGen, ready };
}());
