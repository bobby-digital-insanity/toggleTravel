# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Branch: `sentry`** — LaunchDarkly for feature flagging, Sentry for observability. Nothing else.

## Commands

```bash
npm run dev       # Start with nodemon (auto-restart on changes)
npm start         # Start without watch
npm run lint      # ESLint on src/
npm run seed      # Run the Playwright load generator
node scripts/traffic-conductor.js   # 24/7 traffic conductor (PM2-managed in prod)
```

No test suite exists. There is no build step — the app runs directly from source.

## Architecture

Toggle Travel is a **Node.js/Express** server-rendered app used as a demo platform for comparing
observability vendors. Each git branch is a self-contained observability configuration deployed to
its own EC2 instance. This branch pairs LaunchDarkly flags with Sentry.

### Scope of this branch

**In:** LaunchDarkly feature flags (server + browser), Sentry errors/tracing/session replay, SQLite
persistence, the 24/7 traffic conductor, and the daily guarded-rollout checkout incident.

**Deliberately out:** AI Planner and agent mode, Vacation Mode, LD Experimentation and the
multi-armed bandit, the LD Observability SDKs. Do not port these back without asking — the point of
this branch is that flagging and observability come from two different vendors, with one variable
changed versus the `launchdarkly` branch.

### Server (`src/`)

- **`instrument.js`** — `Sentry.init()`. **Must be the first require in the process** (see
  `server.js`): the Node SDK patches HTTP/Express module internals at init time, so anything
  required earlier is invisible to auto-instrumentation. Also owns the `dotenv` call, because
  `Sentry.init` reads `SENTRY_DSN` at module load.
- **`server.js`** — Express entrypoint. Load order is critical: `instrument.js` → `launchdarkly.js`
  → `express`. Server starts only after `ld.init()` resolves. `Sentry.setupExpressErrorHandler` goes
  after all routes but before `errorHandler`.
- **`launchdarkly.js`** — LD Node SDK wrapper. Exposes `init()`, `getFlag(key, default, sessionId)`,
  `getClientSideId()`, `track()`, `flush()`. No SDK plugins. Gracefully degrades to flag defaults if
  `LD_SDK_KEY` is absent. Every `getFlag` call also reports the evaluation to Sentry.
- **`db.js`** — SQLite via `better-sqlite3` (`DB_PATH` env). Every query is wrapped in a manual
  **Sentry span** (`op: 'db.query'`), which is what puts SQLite timings in the request waterfall.
- **`logger.js`** — Winston. A `SentryTransport` forwards every line **twice**: as a
  **breadcrumb** (rides along with the next captured error; free, but not searchable) and as a
  **structured log** via `Sentry.logger` (searchable in Sentry Logs whether or not an error
  occurred). Both exist because they answer different questions — see the comment in the file.
  Object-valued Winston metadata is JSON-stringified, since log attributes must be flat scalars.
- **`metrics.js`** — thin wrapper over `Sentry.metrics` (`count` / `distribution` / `gauge`).
  Naming is `<domain>.<event>`; dimensions go in `attributes`, never in the metric name, or
  cardinality explodes and nothing aggregates. Emitted from the request scope, so every metric
  inherits the `flag.*` tags the LD bridge attached — a `booking.failed` spike is sliceable by the
  flag that caused it. Every call is wrapped: telemetry must never break a request.
- **`routes/`** — `health`, `destinations`, `search`, `bookings`, `demo`.
- **`services/`**
  - `destinationService.js` — SQLite-backed. `search()` maps the `search-ranking` flag to an
    `ORDER BY` through the `RANKING_SQL` **whitelist** — the flag value is never interpolated into
    SQL.
  - `bookingService.js` — SQLite-backed. Atlantis (`dest-013`) always 404s by design.
  - `externalMockService.js` — Simulated external calls (weather, pricing, payment auth), with
    `dynamic-pricing-enabled` and `payment-failure-rate` as flag hooks.
- **`middleware/requestLogger.js`** — Tags the Sentry scope with `session_id` (= the LD context key,
  the join between a Sentry issue and an LD evaluation) and sets the `x-trace-id` response header.

### Flags → Sentry: the part worth understanding

This is the branch's headline integration, and it is **hand-rolled on purpose**. Sentry ships an
official `launchDarklyIntegration()` + `buildLaunchDarklyFlagUsedHandler()` pair, and it is not used.
Three findings drove that, all verified against the installed packages rather than the docs:

1. **In `@sentry/node`, `launchDarklyIntegration` is a no-op shim.** It lives in
   `integrations/featureFlagShims/` and its whole body is a `console.warn` saying it "can only be
   used in the browser". It exists so isomorphic code doesn't crash. Server-side must use
   `featureFlagsIntegration()` + `addFeatureFlag()` manually.
2. **No Sentry CDN bundle contains it.** The vendored `bundle.tracing.replay.min.js` exports
   `replayIntegration` and `browserTracingIntegration` but neither `featureFlagsIntegration` nor
   `launchDarklyIntegration`. This app has no build step, so an npm-only integration is unavailable
   in the browser.
3. **Sentry's flag support is boolean-only.** The `FeatureFlag` type is `{flag: string, result:
   boolean}` and non-boolean values are silently dropped. Four of this branch's six browser flags
   are strings or arrays, so the official handler would ignore most of them.

So both sides report flags **twice**: booleans go through `featureFlagsIntegration` (which populates
Sentry's dedicated Feature Flags panel and drives flag-change suspect detection), and *every* flag —
boolean or not — is also mirrored onto an indexed `flag.<key>` tag. The tag is the only reason
`flag.booking-flow-variant:express` is searchable at all.

- Browser: an **LD inspector** (`type: 'flag-used'`) in `public/js/flags.js` calls
  `TTSentry.reportFlag()` in `public/js/sentry.js`.
- Server: `reportFlagToSentry()` in `src/launchdarkly.js`, called from every `getFlag()`.

Two gotchas:

- **Tags land on the isolation scope, not the current scope.** `Sentry.getCurrentScope()` will look
  empty; check `Sentry.getIsolationScope().getScopeData().tags`. Events still include them.
- **`setupExpressErrorHandler` captures only 5xx by default.** `server.js` widens
  `shouldHandleError` to include 404s, because the Atlantis 404 is a headline demo error. Unrouted
  URLs return JSON from the SPA fallback rather than throwing, so this doesn't turn crawler traffic
  into issues.

### Signals emitted

`enableLogs` and `enableMetrics` both default to `true` in SDK v10 and are set explicitly in
`instrument.js` anyway — the option moved out of `_experiments` across versions, and "is logging on?"
should be answerable from that file. Enabling them emits nothing on its own; something has to call
`Sentry.logger` / `Sentry.metrics`.

| Metric | Kind | Attributes |
|---|---|---|
| `booking.created` | count | destination_id, travelers |
| `booking.failed` | count | reason (destination_unreachable / payment_declined / checkout_v2), http_status, destination_id |
| `booking.amount` | distribution (usd) | destination_id |
| `booking.payment_duration` | distribution (ms) | outcome |
| `search.performed` | count | ranking, region, has_query |
| `search.results` | distribution | ranking |
| `checkout.v2_failure` | count | destination_id, checkout_version |
| `checkout.confirm_clicked` / `.completed` / `.failed` | count (browser) | destination_id, http_status, new_checkout_flow |
| `checkout.duration` | distribution (ms, browser) | outcome |

**Browser logs and metrics require the right CDN bundle.** The vendored file is
`bundle.tracing.replay.logs.metrics.min.js`. The plain `tracing.replay` bundle exports neither
`Sentry.logger` nor `Sentry.metrics`, so swapping it back would silently disable both — the helpers
in `sentry.js` no-op rather than throw, which is safe but invisible.

Not wired: profiling, cron monitors.

### Flags

| Flag | Type | Default | Drives |
|---|---|---|---|
| `show-demo-panel` | bool | `true` | Load Gen nav link |
| `promo-banner-text` | string | `''` | Top promo banner (live-updates via `onChange`) |
| `featured-destinations` | array | `[]` | Home page grid; empty = first six |
| `booking-flow-variant` | string | `standard` | Booking flow variant |
| `search-ranking` | string | `recommended` | Result sort (`RANKING_SQL` whitelist) |
| `new-checkout-flow` | bool | `false` | The daily incident — treatment 500s every confirm |
| `dynamic-pricing-enabled` | bool | `true` | Server-side: price jitter |
| `payment-failure-rate` | number | `0.05` | Server-side: simulated decline rate |
| `simulated-latency-ms` | number | `1200` | Server-side: search latency |

All have safe code defaults, so the app runs correctly against an empty LD project.

**Identity precedence must stay aligned** across `public/js/flags.js`, `public/js/api.js`
(`sessionKey()`), and the `x-session-id` header: `tt-user-email` → `tt-persona-email` →
`tt-session-id`. If the browser and server evaluate against different context keys, the guarded
rollout disagrees with itself mid-checkout — the badge says "new checkout" while the server serves
the old one.

### 24/7 traffic & the daily checkout incident

**`scripts/traffic-conductor.js`** — PM2 app `toggle-traffic`. Three loops:

1. **Browser tier** — spawns `playwright-load.js` on a diurnal cadence (peak/trough via env),
   standing down while a manual `/api/demo/seed` run is active.
2. **API tier** — cheap `fetch` traffic with rotating synthetic identities via `x-session-id`.
3. **Incident scheduler** — daily at `INCIDENT_HOUR_ET` (7am ET), starts a **guarded rollout** on
   `new-checkout-flow` via LD REST (`releaseKind: guarded`, `LD-API-Version: beta`), watches for
   LaunchDarkly's auto-rollback, and force-stops after `INCIDENT_AUTO_REVERT_MIN` as a backstop.
   Ensure-creates the flag + `booking-error` metric at boot.

**The incident, end to end:** treatment (`true`) at 50% / control (`false`) at 50%, guarded by
`booking-error` with `autoRollback`. `routes/bookings.js` evaluates the flag per request;
treatment-arm confirms **always** throw `CheckoutV2Error` (500) for all destinations and fire
`booking-error` **server-side** against the same context that evaluated the flag, so the cheap API
tier feeds the guard. `booking.html` also fires it client-side, shows a styled "500 — Checkout
Unavailable" banner, and displays a "✨ NEW CHECKOUT" badge. In Sentry the 500s arrive tagged
`flag.new-checkout-flow: true` with a linked session replay. LaunchDarkly detects the regression
against the healthy control arm and rolls back within minutes; the conductor re-arms clean for the
next day. Guarded rollouts cap treatment at 50% by design — the control arm is required for the
comparison.

**LaunchDarkly layout:** this branch is an **environment** (`sentry`) inside the shared
`ToggleTravel` project — not a separate project. Siblings: `launch-darkly`, `datadog`, `dynatrace`,
`grafana`, `test`, `production`. Flags and metrics are project-wide, so the flags the other branches
created already exist here; targeting and rollouts are per-environment, so the daily incident in
`sentry` cannot collide with the one on the `launchdarkly` branch.

**`LD_ENV_KEY` has no code default, deliberately.** It used to fall back to `production` — which is a
real, `critical: true` environment in this project. A missing `LD_ENV_KEY` would therefore *not*
404; it would successfully start a daily guarded rollout on `new-checkout-flow` in Production.
`traffic-conductor.js` now refuses to start the incident scheduler unless `LD_ENV_KEY` is set
explicitly, and the deploy workflow injects `LD_ENV_KEY: sentry` from job-level `env:` (it is config,
not a secret, so it stays reviewable in the workflow file). Traffic tiers are unaffected by the
refusal.

### Load generator (`scripts/playwright-load.js`)

Six flows per round: `windowShopper` ×2, `abandonedCheckout`, `completeBooking`, Atlantis (deliberate
404), `errorFlow`. Plus `--checkout <n>` / `--checkout-only` for the incident surge and
`--unique-personas <pct>` for fresh synthetic identities.

Three things that will bite:

1. **`completeBooking` must not pick Atlantis.** Atlantis has the highest rating (5.0), so the
   default `recommended` sort puts it first — and it always 404s. The selector is
   `#results-grid a.card[data-id]:not([data-id="dest-013"])`. Taking `.card.first()` would produce
   zero successful bookings.
2. **Persona identity is seeded via `addInitScript`, not after navigation.** `flags.js` reads
   `tt-persona-email` as the LD context key at init, so a post-navigation write is too late.
3. **`flushTelemetry()` is mandatory before closing a browser.** Headless Chromium skips a real
   unload, so without it the tail of every session is lost — Sentry replays and the `booking-error`
   events that feed the rollout guard. Do not use `runBeforeUnload`.

### Frontend (`public/`)

Vanilla HTML/JS, no framework, no build step. Both SDKs are **vendored** as files
(`sentry.browser.min.js`, `ldclient.min.js`). Script order matters and is the same on every page:
Sentry bundle → LD bundle → `sentry.js` → `flags.js` → `api.js` → `nav.js`.

- **`public/js/sentry.js`** — `window.TTSentry`. Owns the shared `/api/config` fetch, Sentry init,
  flag reporting, identify, and capture.
- **`public/js/flags.js`** — `window.LDFlags`. Awaits `TTSentry.init()` first so the inspector has
  somewhere to report and LD init errors are themselves captured.

**Replay privacy** mirrors the launchdarkly branch: Diamond-plan users are recorded masked
(`maskAllText`/`maskAllInputs`/`blockAllMedia`), everyone else readable for demo purposes. Replay
options are fixed at integration construction, so a mid-session tier change across the Diamond
boundary triggers a page reload (`tt:user-changed`).

**Replay sampling is deliberately not 1.0.** `replaysSessionSampleRate` defaults to **0.1** because
the 24/7 conductor would otherwise burn a replay quota on synthetic sessions and bury the
interesting ones. `replaysOnErrorSampleRate` is 1.0 — the error-triggered replay is the one anyone
watches. Sessions are tagged `traffic_source: load-gen | organic` so synthetic traffic can be
filtered out.

### Deployment

- **GitHub Actions** (`.github/workflows/deploy-sentry.yml`) — on push to `sentry`. Creates a Sentry
  release, deploys over SSH, finalizes the release. **No source maps are uploaded** — there is no
  build step and the frontend ships unminified, so traces are already readable; the release exists
  for deploy grouping and regression detection.
- **`secrets` is not available in step-level `if:`.** It is collapsed once into the job-level
  `HAS_SENTRY_TOKEN` env var, which is what lets the release steps skip cleanly before Sentry is set
  up. Do not move that check back into a step `if:`.
- **Nginx is two files.** `nginx.conf` (HTTP-only) and `nginx-tls.conf`. The deploy picks the TLS one
  only when `/etc/letsencrypt/live/$DOMAIN/fullchain.pem` exists. This is deliberate: referencing a
  cert that doesn't exist yet fails `nginx -t` and aborts the reload, which would break the first
  deploy to a fresh box. Deploy → get the cert → deploy again.
- **Every deploy overwrites the live nginx config**, so never let `certbot --nginx` own it. Use
  `certonly`. Certs live outside the repo at `/etc/letsencrypt/` and survive deploys.
- **PM2** (`deployment/ecosystem.config.js`) — `toggle-travel` (2 cluster workers) and
  `toggle-traffic` (1 fork; it spawns Playwright and must not run twice).
- **`.env`** lives at `/var/www/toggle-travel/.env` on EC2, injected by the workflow on every deploy.

Domain: `https://toggletravel-sentry.launchdarklydemos.com`

## Key Environment Variables

```
PORT                          # Default 3000
NODE_ENV                      # development | production
LD_SDK_KEY                    # LaunchDarkly server-side SDK key
LD_CLIENT_SIDE_ID             # LD client-side ID (served to the browser via /api/config)
LD_API_TOKEN                  # LD REST token (Writer) — conductor's daily guarded rollout
LD_PROJECT_KEY                # ToggleTravel (shared project); injected by the deploy workflow
LD_ENV_KEY                    # sentry — NO code default; the conductor refuses the incident without it
SENTRY_DSN                    # Public write-only credential; also served to the browser
SENTRY_ENVIRONMENT            # Defaults to NODE_ENV
SENTRY_RELEASE                # Set to the git SHA by the deploy workflow
SENTRY_TRACES_SAMPLE_RATE     # Default 1.0 (demo app; lower for real traffic)
DB_PATH                       # Prod: /var/lib/toggle-travel/toggle.db (survives deploys)
SIMULATE_LATENCY_MAX_MS       # Default 1200 — set to 0 to disable artificial latency
SIMULATE_PAYMENT_FAILURE_RATE # Default 0.05 (5%)
TRAFFIC_ENABLED               # Conductor master switch (true on EC2 via PM2 env_production)
TRAFFIC_PEAK_INTERVAL_MIN     # Browser rounds cadence at peak (default 5)
TRAFFIC_TROUGH_INTERVAL_MIN   # …and overnight (default 20)
TRAFFIC_API_RPM               # API-tier req/min at peak (default 20)
TRAFFIC_UNIQUE_PCT            # % of flows as new identities (default 70)
INCIDENT_ENABLED / INCIDENT_HOUR_ET (7) / INCIDENT_MONITOR_WINDOW_MIN (5) / INCIDENT_AUTO_REVERT_MIN (20)
INCIDENT_API_RPM (15) / INCIDENT_CHECKOUT_COUNT (6)  # incident API rate + browser checkout-surge sessions
INCIDENT_TEST_DELAY_MIN       # Testing: fire the incident N minutes after boot
```

## Observability — per branch

| Branch | Server | Browser | Logs |
|---|---|---|---|
| `sentry` | `@sentry/node` auto-instrumentation + manual DB spans | `@sentry/browser` (tracing + replay) | Winston → Sentry breadcrumbs |
| `launchdarkly` | LD Observability Node SDK | LD Observability browser SDK + Session Replay | Winston with custom `LDTransport` |
| `datadog` | `dd-trace` auto-instrumentation | DD RUM | Winston JSON → DD agent |
| `dynatrace` | TBD | TBD | TBD |
| `grafana` | Not yet implemented | — | — |
