'use strict';

// Sentry browser SDK bootstrap.
//
// The SDK bundle itself is vendored at /js/sentry.browser.min.js (same approach
// as the LD client SDK) and must load before this file. The DSN is not baked in
// at build time — this app has no build step — so it comes from /api/config at
// runtime. A DSN is a public, write-only credential designed to ship to
// browsers, so serving it is not a leak.

window.TTSentry = (function () {
  let initPromise = null;
  let maskedAtInit = false; // whether this page's replay started masked

  // Shared /api/config fetch. flags.js reuses this so the two SDKs don't each
  // make their own request on every page load.
  const config = (function () {
    let p = null;
    return {
      get() {
        if (!p) {
          p = fetch('/api/config')
            .then((r) => r.json())
            .catch((err) => {
              console.warn('[Sentry] /api/config failed:', err.message);
              return {};
            });
        }
        return p;
      },
    };
  }());

  // Mirrors the launchdarkly branch's replay privacy model so the two branches
  // are comparable: Diamond-plan users are recorded masked, everyone else is
  // recorded readable for demo purposes. A real app would mask by default.
  function resolvePlan() {
    const tier = localStorage.getItem('tt-user-tier');
    if (!tier) return 'anonymous';
    return tier.charAt(0).toUpperCase() + tier.slice(1);
  }

  function isLoadGen() {
    return !!localStorage.getItem('tt-run-id');
  }

  async function init() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (typeof Sentry === 'undefined') {
        console.warn('[Sentry] Bundle not loaded — skipping init');
        return;
      }

      const cfg = await config.get();
      if (!cfg.sentryDsn) {
        console.warn('[Sentry] No DSN configured — Sentry disabled');
        return;
      }

      maskedAtInit = resolvePlan() === 'Diamond';

      // ── Replay sampling ────────────────────────────────────────────────────
      // This app runs a 24/7 traffic generator, so recording 100% of sessions
      // would burn through a Sentry replay quota fast and bury the interesting
      // sessions in synthetic ones. Default to a 10% sample of ordinary
      // sessions but ALWAYS keep a replay when an error occurs — the
      // error-triggered replay is the one anyone actually watches.
      const sessionSampleRate = typeof cfg.sentryReplaySessionSampleRate === 'number'
        ? cfg.sentryReplaySessionSampleRate
        : 0.1;

      const integrations = [];
      if (Sentry.browserTracingIntegration) {
        integrations.push(Sentry.browserTracingIntegration());
      }
      if (Sentry.replayIntegration) {
        integrations.push(Sentry.replayIntegration({
          maskAllText: maskedAtInit,
          maskAllInputs: maskedAtInit,
          blockAllMedia: maskedAtInit,
        }));
      }

      Sentry.init({
        dsn: cfg.sentryDsn,
        environment: cfg.sentryEnvironment || 'development',
        release: cfg.sentryRelease || undefined,
        integrations,
        tracesSampleRate: 1.0,
        replaysSessionSampleRate: sessionSampleRate,
        replaysOnErrorSampleRate: 1.0,
        // Logs and metrics. These require the logs.metrics CDN bundle — the
        // plain tracing.replay bundle has no Sentry.logger or Sentry.metrics, so
        // swapping public/js/sentry.browser.min.js back would silently disable
        // both (the helpers below no-op rather than throw).
        enableLogs: true,
        enableMetrics: true,
        // Send sentry-trace/baggage headers to our own API so a browser
        // transaction and its server transaction stitch into one trace. The
        // server whitelists both headers in its CORS config.
        tracePropagationTargets: [/^\//, window.location.origin],
      });

      // Tag synthetic traffic so real browsing can be separated from load-gen
      // sessions in the Sentry UI.
      Sentry.setTag('traffic_source', isLoadGen() ? 'load-gen' : 'organic');
      Sentry.setTag('plan', resolvePlan());

      console.log(
        `[Sentry] Initialized — env=${cfg.sentryEnvironment}, replay=${maskedAtInit ? 'masked' : 'readable'}, sessionSample=${sessionSampleRate}`
      );
    })();

    return initPromise;
  }

  // Replay privacy options are fixed when the integration is constructed, so a
  // mid-session tier switch across the Diamond boundary needs a fresh page load
  // to take effect. nav.js fires tt:user-changed on every sign-in/sign-out.
  // Same constraint (and same fix) as the launchdarkly branch.
  window.addEventListener('tt:user-changed', () => {
    if (typeof Sentry === 'undefined' || !initPromise) return;
    const nowMasked = resolvePlan() === 'Diamond';
    if (nowMasked !== maskedAtInit) {
      console.log('[Sentry] Plan crossed the Diamond boundary — reloading to apply replay privacy');
      location.reload();
    }
  });

  // Report a flag evaluation to Sentry. Called by the LD inspector in flags.js.
  //
  // Sentry's dedicated feature-flag support is boolean-only AND is not present
  // in any CDN bundle (verified: the tracing+replay bundle exports neither
  // featureFlagsIntegration nor launchDarklyIntegration). So the tag is the
  // primary mechanism here and the integration is used only if a future
  // npm-based build makes it available.
  function reportFlag(key, value) {
    if (typeof Sentry === 'undefined') return;
    try {
      if (typeof value === 'boolean' && Sentry.getClient) {
        const flagsIntegration = Sentry.getClient()?.getIntegrationByName?.('FeatureFlags');
        if (flagsIntegration?.addFeatureFlag) flagsIntegration.addFeatureFlag(key, value);
      }
      const asTag = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
      Sentry.setTag(`flag.${key}`, asTag.slice(0, 200));
    } catch (err) {
      console.warn('[Sentry] reportFlag failed:', err.message);
    }
  }

  function identify(email, extras = {}) {
    if (typeof Sentry === 'undefined') return;
    try {
      Sentry.setUser({ email, id: email, ...extras });
      if (extras.tier) Sentry.setTag('plan', extras.tier.charAt(0).toUpperCase() + extras.tier.slice(1));
    } catch (err) {
      console.warn('[Sentry] identify failed:', err.message);
    }
  }

  // ── Structured logs ────────────────────────────────────────────────────────
  // Searchable in Sentry Logs, unlike breadcrumbs. Guarded on Sentry.logger so a
  // bundle without logs support degrades to a no-op instead of throwing.
  function log(level, message, attributes = {}) {
    if (typeof Sentry === 'undefined' || !Sentry.logger) return;
    try {
      const fn = Sentry.logger[level] || Sentry.logger.info;
      fn(message, withAttribution({ traffic_source: isLoadGen() ? 'load-gen' : 'organic', ...attributes }));
    } catch (_) { /* never let telemetry throw */ }
  }

  // ── Metrics ────────────────────────────────────────────────────────────────
  // Same naming rule as the server (src/metrics.js): `<domain>.<event>`, with
  // dimensions in attributes, never baked into the metric name.
  // Same attribution requirement as the server (see src/metrics.js): every
  // metric carries the LD context key so the Sentry -> LD bridge can map it to
  // contextKeys.user. Precedence must match api.js sessionKey() and flags.js.
  function attributionKey() {
    try {
      return localStorage.getItem('tt-user-email')
        || localStorage.getItem('tt-persona-email')
        || localStorage.getItem('tt-session-id')
        || null;
    } catch (_) { return null; }
  }

  function withAttribution(attributes) {
    const key = attributionKey();
    return key && attributes.session_id === undefined
      ? { ...attributes, session_id: key }
      : attributes;
  }

  const metric = {
    count(name, value = 1, attributes = {}) {
      if (typeof Sentry === 'undefined' || !Sentry.metrics) return;
      try { Sentry.metrics.count(name, value, { attributes: withAttribution(attributes) }); } catch (_) { /* noop */ }
    },
    distribution(name, value, attributes = {}, unit = undefined) {
      if (typeof Sentry === 'undefined' || !Sentry.metrics) return;
      try {
        Sentry.metrics.distribution(name, value, { attributes: withAttribution(attributes), ...(unit ? { unit } : {}) });
      } catch (_) { /* noop */ }
    },
    gauge(name, value, attributes = {}, unit = undefined) {
      if (typeof Sentry === 'undefined' || !Sentry.metrics) return;
      try {
        Sentry.metrics.gauge(name, value, { attributes: withAttribution(attributes), ...(unit ? { unit } : {}) });
      } catch (_) { /* noop */ }
    },
  };

  function captureException(err, context = {}) {
    if (typeof Sentry === 'undefined') return;
    try {
      Sentry.captureException(err, { extra: context });
    } catch (_) { /* never let reporting throw */ }
  }

  return { init, config, reportFlag, identify, captureException, log, metric, isLoadGen };
}());
