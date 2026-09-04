'use strict';

// LaunchDarkly JS Client SDK
// Fetches the client-side ID from /api/config, initializes the LD client,
// and exposes flag reads + real-time change listeners via window.LDFlags.

window.LDFlags = (function () {
  let ldClient = null;
  let initPromise = null;
  let readyResolve;
  let maskedAtInit = false; // whether this page's replay started in Diamond strict mode
  const ready = new Promise((r) => { readyResolve = r; });

  const DEFAULTS = {
    'show-demo-panel':            true,
    'featured-destinations':      [],
    'booking-flow-variant':       'standard',
    'promo-banner-text':          '',
    'ai-planner-enabled':         false,
    'ai-planner-agent-enabled':   false,
    'atlantis-booking-enabled':   false,
    'new-checkout-flow':          false,
    'search-ranking':             'recommended',
  };

  // Set by Playwright load script (scripts/playwright-load.js) per browser session
  function isLoadGen() {
    return !!localStorage.getItem('tt-run-id');
  }

  function isLocalhost() {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  }

  // ── LaunchDarkly dev toolbar ─────────────────────────────────────────────
  // Loads the toolbar bundle out of node_modules (server.js serves the package
  // at /vendor/ld-toolbar in dev only) and mounts it with the *same* plugin
  // instances the client was initialized with — the toolbar can only override
  // flags and read events through those shared instances.
  async function mountDevToolbar({ flagOverridePlugin, eventInterceptionPlugin }, clientSideId) {
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/ld-toolbar/cdn/toolbar.min.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('bundle failed to load'));
        document.head.appendChild(script);
      });
      if (!window.LaunchDarklyToolbar) throw new Error('window.LaunchDarklyToolbar missing');
      window.LaunchDarklyToolbar.init({
        flagOverridePlugin,
        eventInterceptionPlugin,
        clientSideId,
        position: 'bottom-right',
      });
      console.log('[LD] Dev toolbar mounted — window.ldToolbar.toggle() to hide/show');
    } catch (err) {
      console.warn('[LD] Dev toolbar failed to mount:', err.message);
    }
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

  // ── Plan session property ───────────────────────────────────────────────
  // Every recorded session gets a `plan` property (searchable in Session Replay).
  // Precedence: signed-in nav tier → load-gen persona plan (tt-user-plan) →
  // stable hash of the context key (anonymous visitors keep the same plan
  // across visits).
  const PLANS = ['Beta', 'Silver', 'Gold', 'Platinum', 'Diamond'];

  function resolvePlan() {
    const tier = localStorage.getItem('tt-user-tier');
    if (tier) return tier.charAt(0).toUpperCase() + tier.slice(1); // 'gold' → 'Gold'

    const injected = localStorage.getItem('tt-user-plan'); // set by load gen
    if (injected) return injected;

    const key = localStorage.getItem('tt-persona-email') || getSessionKey();
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    return PLANS[Math.abs(hash) % PLANS.length];
  }

  function setPlanSessionProperty() {
    try {
      if (window.LDRecord?.addSessionProperties) {
        const plan = resolvePlan();
        window.LDRecord.addSessionProperties({ plan, masked: plan === 'Diamond' });
        console.log('[LD] Session property set — plan:', plan);
      }
    } catch (err) {
      console.warn('[LD] addSessionProperties failed:', err.message);
    }
  }

  // privacySetting is fixed when the SessionReplay plugin is constructed, so a
  // mid-session tier switch that crosses the Diamond boundary (in either
  // direction) needs a fresh page load for masking to apply. nav.js fires
  // tt:user-changed on every sign-in/sign-out.
  window.addEventListener('tt:user-changed', () => {
    if (!ldClient) return;
    const nowMasked = resolvePlan() === 'Diamond';
    if (nowMasked !== maskedAtInit) {
      console.log('[LD] Plan crossed the Diamond boundary — reloading to apply replay privacy');
      location.reload();
    }
  });

  async function init() {
    if (ldClient) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
    try {
      const res = await fetch('/api/config');
      const { ldClientSideId, devToolbar } = await res.json();

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
        // Privacy is decided per user at record time: Diamond-plan users are
        // automatically masked ('strict' masks all text + images in the browser,
        // before anything is uploaded). Everyone else records readable ('none')
        // for demo purposes; real apps would use 'default' or 'strict' here.
        // resolvePlan() is synchronous (localStorage only), so the plan is
        // known before the plugin is constructed.
        maskedAtInit = resolvePlan() === 'Diamond';
        plugins.push(new SessionReplay.default({
          privacySetting: maskedAtInit ? 'strict' : 'none',
          inlineStylesheet: true,
          inlineImages: true,
        }));
        console.log(`[LD] Session Replay plugin enabled (privacySetting: ${maskedAtInit ? 'strict, Diamond auto-mask' : 'none'})`);
      }

      // Dev toolbar plugins must be constructed before the client, since they
      // register through LDClient.initialize. Skipped for load-gen sessions.
      let toolbarPlugins = null;
      if (devToolbar && isLocalhost() && !isLoadGen()) {
        try {
          const { FlagOverridePlugin, EventInterceptionPlugin } =
            await import('/vendor/ld-toolbar/dist/js/plugins.js');
          toolbarPlugins = {
            flagOverridePlugin: new FlagOverridePlugin(),
            eventInterceptionPlugin: new EventInterceptionPlugin(),
          };
          plugins.push(toolbarPlugins.flagOverridePlugin, toolbarPlugins.eventInterceptionPlugin);
          console.log('[LD] Dev toolbar plugins registered');
        } catch (err) {
          console.warn('[LD] Dev toolbar plugins failed to load:', err.message);
        }
      }

      ldClient = LDClient.initialize(ldClientSideId, context, { plugins });

      await ldClient.waitForInitialization(5);
      console.log('[LD] Client SDK initialized — flags ready');

      if (toolbarPlugins) await mountDevToolbar(toolbarPlugins, ldClientSideId);
    } catch (err) {
      console.warn('[LD] Init failed — using flag defaults:', err.message);
    } finally {
      setPlanSessionProperty();
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
      setPlanSessionProperty(); // tier may have just changed (nav user switch)
    } catch (err) {
      console.warn('[LD] identify failed:', err.message);
    }
  }

  return { init, get, onChange, identify, track, flushSessionReplay, isLoadGen, ready };
}());
