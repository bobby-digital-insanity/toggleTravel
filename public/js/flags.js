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

  // Identify a known user — call when their email becomes known (e.g. booking form)
  async function identify(email) {
    if (!ldClient || !email) return;
    try {
      await ldClient.identify({ kind: 'user', key: email, name: email });
      console.log('[LD] Identified user:', email);
    } catch (err) {
      console.warn('[LD] identify failed:', err.message);
    }
  }

  return { init, get, onChange, identify };
}());
