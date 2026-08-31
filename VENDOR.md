# Sentry — Toggle Travel

This branch pairs **LaunchDarkly feature flags** with **Sentry** for observability: error monitoring,
performance tracing, and session replay. It is the counterpart to the `launchdarkly` branch, which
uses LaunchDarkly for both. One variable changes between them — the observability vendor — so the
two are directly comparable.

## What Was Changed vs `main`

- `src/instrument.js` — new. `Sentry.init()`, required first in the process
- `src/launchdarkly.js` — new. LD Node SDK wrapper; reports every evaluation to Sentry
- `src/db.js` — new. SQLite, with each query wrapped in a Sentry span
- `src/logger.js` — Winston logs forwarded to Sentry as breadcrumbs
- `public/js/sentry.js`, `public/js/flags.js` — new. Browser SDKs + the LD→Sentry flag inspector
- `public/js/nav.js` — Sentry badge, flag-driven nav and promo banner
- `deployment/nginx-tls.conf` — new. TLS config, selected only once a cert exists

## SDK Installation

```bash
npm install @sentry/node
```

Server — `src/instrument.js`, required as the **first line** of `src/server.js`:

```javascript
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  release: process.env.SENTRY_RELEASE,
  tracesSampleRate: 1.0,
  integrations: [Sentry.featureFlagsIntegration()],
});
```

Browser — the bundle is **vendored** at `public/js/sentry.browser.min.js` because this app has no
build step:

```bash
curl -o public/js/sentry.browser.min.js \
  https://browser.sentry-cdn.com/10.72.0/bundle.tracing.replay.min.js
```

Add to `.env`:

```
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production
```

## Wiring LaunchDarkly flags into Sentry

Sentry's official `launchDarklyIntegration()` is **not** used here, for three reasons verified
against the installed packages:

1. In `@sentry/node` it is a no-op shim that warns "can only be used in the browser".
2. No Sentry CDN bundle contains it, and this app cannot import from npm in the browser.
3. It records **boolean flags only** — most of this app's browser flags are strings or arrays.

Instead an **LD inspector** forwards evaluations, and every flag is mirrored onto an indexed
`flag.<key>` tag so non-boolean flags are searchable:

```javascript
// public/js/flags.js
ldClient = LDClient.initialize(clientSideId, context, {
  inspectors: [{
    type: 'flag-used',
    name: 'sentry-flag-bridge',
    synchronous: true,
    method: (flagKey, detail) => window.TTSentry.reportFlag(flagKey, detail?.value),
  }],
});
```

Booleans additionally go through `featureFlagsIntegration`, which populates Sentry's dedicated
Feature Flags panel on an issue.

## What to Demo

**The daily checkout incident (the headline)**
At 7am ET the traffic conductor starts a **guarded rollout** on `new-checkout-flow` — 50% treatment,
50% control, guarded by the `booking-error` metric with auto-rollback.

1. **Sentry → Issues** → `CheckoutV2Error: payment intent missing`. Error count climbs from zero.
2. Open the issue → the **Feature Flags** panel shows `new-checkout-flow: true`, and the tag
   `flag.new-checkout-flow:true` is on every event. The flag *is* the root cause, stated on the
   issue.
3. Search `flag.new-checkout-flow:true` in the issue stream — every treatment-arm error, nothing
   from control.
4. Open the linked **Session Replay** → watch a real user hit "Confirm & Pay", see the "500 —
   Checkout Unavailable" banner and the "✨ NEW CHECKOUT" badge.
5. **LaunchDarkly** → the rollout auto-rolls-back within minutes on the guard metric. Return to
   Sentry: the error rate falls back to zero. Nobody paged anybody.

**Errors**
- `Destination unreachable: Atlantis` — a deliberate 404, generated every load-gen round.
  `setupExpressErrorHandler` is widened to capture 404s so this appears at all.
- `Payment authorization declined` — the simulated 5% decline rate.
- **Issues → filter by `traffic_source:organic`** to exclude synthetic load-gen sessions.

**Tracing**
- **Performance → `POST /api/bookings`** — the waterfall shows `inventory_check`, payment auth, and
  the SQLite `INSERT bookings` span (manual spans from `src/db.js`; `better-sqlite3` has no auto
  instrumentation).
- Browser and server transactions stitch into one trace via `sentry-trace`/`baggage` propagation.
- The app surfaces the trace id in an `x-trace-id` response header and shows it in an on-page banner
   — copy it straight into Sentry's trace search.

**Session Replay**
- Sampled at **10%** of ordinary sessions but **100% on error**, because the 24/7 traffic generator
  would otherwise flood the quota.
- Diamond-plan users are recorded **masked** (all text, inputs and media) while other tiers record
  readable — switch users in the nav to show privacy tiers.

**Logs**
- **Logs** → every Winston line arrives as a structured, searchable log with its metadata as
  attributes (`booking_id`, `session_id`, `stage`, `destination_id`…).
- Search `checkout_v2_failed` during the daily incident, or `booking_failed_destination_unreachable`
  for the Atlantis 404s.
- These are distinct from breadcrumbs: breadcrumbs only appear attached to an error, logs are
  queryable at any time. The app sends both.

**Metrics**
- **Metrics** → `booking.created`, `booking.failed` (by `reason`), `booking.amount` (p50/p95 basket
  size), `search.results` by `ranking`, and the browser-side `checkout.*` funnel.
- During the incident, `checkout.v2_failure` climbs while `booking.created` flatlines — and because
  metrics are emitted from the request scope, they carry the `flag.*` tags, so the spike is
  attributable to `new-checkout-flow` directly.

**Releases**
- Each deploy creates a release tagged with the git SHA, so Sentry can attribute a new issue to the
  deploy that introduced it. No source maps needed — the frontend ships unminified.

## Key Signals

| Signal | Where to find it |
|---|---|
| Flag-attributed errors | Issues → tag `flag.new-checkout-flow` |
| Checkout failure spike | Issues → `CheckoutV2Error` |
| Deliberate 404s | Issues → `Destination unreachable` |
| DB query timings | Performance → transaction → `db.query` spans |
| Session journey | Issues → tag `session_id` (= the LD context key) |
| Synthetic vs real traffic | tag `traffic_source` (`load-gen` / `organic`) |
| Replay of a failure | Issue → linked Session Replay |
