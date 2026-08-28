'use strict';

// LaunchDarkly JS Client SDK.
// Fetches the client-side ID from /api/config, initializes the LD client, wires
// flag evaluations into Sentry via an LD inspector, and exposes flag reads +
// real-time change listeners via window.LDFlags.
//
// The SDK bundle is vendored at /js/ldclient.min.js and must load before this.

window.LDFlags = (function () {
  let ldClient = null;
  let initPromise = null;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const DEFAULTS = {
    'show-demo-panel':          true,
    'featured-destinations':    [],
    'booking-flow-variant':     'standard',
    'promo-banner-text':        '',
    'new-checkout-flow':        false,
    'search-ranking':           'recommended',
  };

  // Set by the Playwright load generator per browser session
  function isLoadGen() {
    return !!localStorage.getItem('tt-run-id');
  }

  // Stable anonymous key, persisted so a returning browser keeps its flag
  // bucketing (and its guarded-rollout arm) across page loads.
  function getSessionKey() {
    let key = localStorage.getItem('tt-session-id');
    if (!key) {
      key = 'anon-' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem('tt-session-id', key);
    }
    return key;
  }

  // ── LD → Sentry bridge ──────────────────────────────────────────────────────
  // An LD inspector fires on every flag evaluation. Forwarding those to Sentry is
  // what makes an error say "this happened while new-checkout-flow was true".
  //
  // Sentry ships an official launchDarklyIntegration() +
  // buildLaunchDarklyFlagUsedHandler() pair that does exactly this, and it is
  // NOT used here for two concrete reasons:
  //   1. It is absent from every Sentry CDN bundle, and this app has no build
  //      step to import it from npm.
  //   2. It records boolean flags only. Four of this app's six client flags are
  //      strings or arrays, so the official handler would silently ignore them.
  // TTSentry.reportFlag handles both cases — see public/js/sentry.js.
  function sentryInspector() {
    return {
      type: 'flag-used',
      name: 'sentry-flag-bridge',
      synchronous: true,
      method: (flagKey, detail) => {
        try {
          window.TTSentry?.reportFlag(flagKey, detail?.value);
        } catch (_) { /* never break a flag read */ }
      },
    };
  }

  async function init() {
    if (ldClient) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        // Sentry first, so the inspector has somewhere to report to and any
        // error thrown during LD init is itself captured.
        await window.TTSentry?.init();

        const cfg = window.TTSentry
          ? await window.TTSentry.config.get()
          : await fetch('/api/config').then((r) => r.json());

        const ldClientSideId = cfg.ldClientSideId;
        if (!ldClientSideId) {
          console.warn('[LD] No client-side ID configured — using flag defaults');
          return;
        }

        // Identity precedence must match api.js's sessionKey(), or the browser
        // and the server will evaluate flags against different contexts and the
        // guarded rollout will disagree with itself mid-checkout.
        const runId        = localStorage.getItem('tt-run-id');
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

        ldClient = LDClient.initialize(ldClientSideId, context, {
          inspectors: [sentryInspector()],
        });

        await ldClient.waitForInitialization(5);
        console.log('[LD] Client SDK initialized — flags ready');
      } catch (err) {
        console.warn('[LD] Init failed — using flag defaults:', err.message);
        window.TTSentry?.captureException(err, { phase: 'ld_init' });
      } finally {
        readyResolve();
      }
    })();

    return initPromise;
  }

  // Read a flag value, falling back to the defined default
  function get(key) {
    const defaultValue = key in DEFAULTS ? DEFAULTS[key] : null;
    if (!ldClient) {
      // Still report the default so Sentry reflects what the app actually used.
      window.TTSentry?.reportFlag(key, defaultValue);
      return defaultValue;
    }
    return ldClient.variation(key, defaultValue);
  }

  // Subscribe to real-time flag changes
  function onChange(key, callback) {
    if (!ldClient) return;
    ldClient.on('change:' + key, callback);
  }

  // Track a custom metric event against the current context. Used by the
  // guarded-rollout demo: booking.html fires 'booking-error' on failed confirms,
  // which LD attributes to the same context that evaluated the flag.
  function track(eventName, data = undefined, metricValue = undefined) {
    if (!ldClient) return;
    try {
      ldClient.track(eventName, data, metricValue);
      console.log('[LD] Tracked event:', eventName);
    } catch (err) {
      console.warn('[LD] track failed:', err.message);
    }
  }

  // Identify a known user — call when their email becomes known (booking form,
  // nav user switch).
  async function identify(email, extras = {}) {
    if (!email) return;
    // Load-gen personas are already the LD context key via tt-persona-email.
    if (isLoadGen()) return;
    await ready;
    window.TTSentry?.identify(email, extras);
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

  // Push buffered analytics events. The load generator must call this before
  // closing a browser or the session's events (including booking-error, which
  // feeds the rollout guard) are lost.
  async function flush() {
    await ready;
    try {
      if (ldClient && typeof ldClient.flush === 'function') await ldClient.flush();
      return true;
    } catch (err) {
      console.warn('[LD] flush failed:', err.message);
      return false;
    }
  }

  return { init, get, onChange, identify, track, flush, isLoadGen, getSessionKey, ready };
}());
