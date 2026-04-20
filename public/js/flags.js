'use strict';

// LaunchDarkly JS Client SDK
// Fetches the client-side ID from /api/config, initializes the LD client,
// and exposes flag reads + real-time change listeners via window.LDFlags.

window.LDFlags = (function () {
  let ldClient = null;

  const DEFAULTS = {
    'show-vacation-mode-ui': true,
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

      const context = { kind: 'user', key: getSessionKey() };
      console.log('[LD] Initializing with client-side ID:', ldClientSideId.slice(0, 8) + '...');
      ldClient = LDClient.initialize(ldClientSideId, context);

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LD init timed out after 5s')), 5000)
      );
      await Promise.race([ldClient.waitForInitialization(), timeout]);
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

  return { init, get, onChange };
}());
