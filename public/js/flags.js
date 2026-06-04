'use strict';

// LaunchDarkly JS Client SDK
// Fetches the client-side ID from /api/config, initializes the LD client,
// and exposes flag reads + real-time change listeners via window.LDFlags.

window.LDFlags = (function () {
  let ldClient = null;

  const DEFAULTS = {
    'show-demo-panel':        true,
    'featured-destinations':  [],
    'booking-flow-variant':   'standard',
    'promo-banner-text':      '',
  };

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
    try {
      const res = await fetch('/api/config');
      const { ldClientSideId } = await res.json();

      if (!ldClientSideId) {
        console.warn('[LD] No client-side ID configured — using flag defaults');
        return;
      }

      const tier      = localStorage.getItem('tt-user-tier');
      const tierEmail = localStorage.getItem('tt-user-email');
      const tierName  = localStorage.getItem('tt-user-name');
      const context = {
        kind: 'user',
        key: tierEmail || getSessionKey(),
        ...(tierName ? { name: tierName } : {}),
        ...(tier ? { tier } : {}),
      };
      console.log('[LD] Initializing with client-side ID:', ldClientSideId.slice(0, 8) + '...');

      const plugins = [];
      if (typeof SessionReplay !== 'undefined' && SessionReplay.default) {
        plugins.push(new SessionReplay.default());
        console.log('[LD] Session Replay plugin enabled');
      }

      ldClient = LDClient.initialize(ldClientSideId, context, { plugins });

      await ldClient.waitForInitialization(5);
      console.log('[LD] Client SDK initialized — flags ready');
    } catch (err) {
      console.warn('[LD] Init failed — using flag defaults:', err.message);
    }
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

  // Re-identify the LD context (e.g. when the user select changes)
  async function identify(key, extras = {}) {
    if (!key || !ldClient) return;
    try {
      const ctx = { kind: 'user', key, ...extras };
      if (!ctx.name && key.includes('@')) ctx.name = key;
      await ldClient.identify(ctx);
      console.log('[LD] Identified:', key, extras);
    } catch (err) {
      console.warn('[LD] identify failed:', err.message);
    }
  }

  return { init, get, onChange, identify };
}());
