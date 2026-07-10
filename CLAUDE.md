# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start with nodemon (auto-restart on changes)
npm start         # Start without watch
npm run lint      # ESLint on src/
npm run seed      # Run load generator script
node scripts/traffic-conductor.js   # 24/7 traffic conductor (PM2-managed in prod)
```

No test suite exists. There is no build step — the app runs directly from source.

## Architecture

Toggle Travel is a **Node.js/Express** server-rendered app used as a demo platform for comparing observability vendors. Each git branch is a self-contained observability configuration deployed to its own EC2 instance.

### Server (`src/`)

- **`server.js`** — Express entrypoint. Module load order is critical: `tracer.js` → `launchdarkly.js` → `express`. Server starts only after `ld.init()` resolves.
- **`tracer.js`** — Initializes `dd-trace`. Must be the first `require` in the process for APM auto-instrumentation to patch all subsequent modules.
- **`launchdarkly.js`** — LD Node SDK wrapper. Exposes `init()`, `getFlag(key, default, sessionId)`, and `getClientSideId()`. Gracefully degrades (flag defaults) if `LD_SDK_KEY` is absent.
- **`logger.js`** — Winston logger. In production: JSON format with DD trace/span IDs injected for log-trace correlation. In dev: colorized plaintext.
- **`routes/`** — Express routers: `health`, `destinations`, `search`, `bookings`, `vacationMode`, `demo`.
  - Guarded-rollout demo: the rollout itself is configured manually in the LD UI on `atlantis-booking-enabled` (false→true, guarded by the `booking-error` metric, auto-rollback on). The load gen's Atlantis surge (`--atlantis <n>`, `--atlantis-only`) generates the error increase that trips it: each surge session gets a unique persona email (= distinct randomization unit), treatment-arm sessions book Atlantis (dest-013), 404, and fire `booking-error` client-side via `LDFlags.track` in `booking.html`.

### 24/7 traffic & the daily checkout incident

- **`scripts/traffic-conductor.js`** — PM2 app `toggle-traffic` (see `deployment/ecosystem.config.js`). Three loops: (1) browser tier — spawns `playwright-load.js --rounds 1 --unique-personas 70` on a diurnal cadence (peak/trough intervals via env), pausing while a manual `/api/demo/seed` run is active; (2) API tier — cheap `fetch` traffic with rotating synthetic identities via `x-session-id`; (3) incident scheduler — daily at `INCIDENT_HOUR_ET` (8am ET) runs `turnFlagOn` on `new-checkout-flow` via LD REST (`LD_API_TOKEN`), auto-reverts after `INCIDENT_AUTO_REVERT_MIN` if not manually toggled off. Ensure-creates the flag at boot.
- **Checkout incident mechanics**: `routes/bookings.js` evaluates `new-checkout-flow` per request; when ON, ~50% of confirms throw `CheckoutV2Error` (500). Browser sends `x-session-id` (set in `public/js/api.js` from the same identity flags.js uses) so server-side evals share the browser's LD context key. `booking.html` shows a "✨ NEW CHECKOUT" badge while the flag is on and fires the `booking-error` metric on failures — recovery = toggle the flag off in LD.
- **`services/`**
  - `vacationModeService.js` — Calls Anthropic Claude API. Returns structured JSON (welcome message, 3 destination recommendations, vibe, persona) when enabling; plain text farewell when disabling.
  - `bookingService.js` — SQLite-backed (via `src/db.js`, `better-sqlite3`; `DB_PATH` env). Booking create runs staged (inventory → payment → persist) with structured stage logs; Atlantis (dest-013) always 404s by design.
  - `externalMockService.js` — Simulates external calls: weather (50–200ms jitter), pricing (100–400ms, 3% timeout rate), payment auth (100–300ms, configurable failure rate).
  - `destinationService.js` — Reads from `src/data/destinations.json`.
- **`middleware/simulateLatency.js`** — Adds random delay (0–`SIMULATE_LATENCY_MAX_MS`) to search requests. Intentional for observability demos.

### Frontend (`public/`)

Vanilla HTML/JS with no framework. Pages: `index`, `search`, `destination`, `booking`, `bookings`, `vacation-mode`, `demo`.

- **`public/js/flags.js`** — `window.LDFlags` module. Fetches `LD_CLIENT_SIDE_ID` from `/api/config`, initializes the LD browser SDK, conditionally attaches Session Replay, and wires DD RUM `addFeatureFlagEvaluation` via an LD inspector.
- **`public/js/rum.js`** — Datadog RUM init (branch-specific credentials).
- **`public/js/api.js`** — Fetch wrappers for all backend API calls.
- **`public/js/nav.js`** — Shared nav: calls `LDFlags.init()`, renders `promo-banner-text` flag value, subscribes to real-time flag changes.

Feature flag defaults (defined in `flags.js`): `show-vacation-mode-ui`, `show-demo-panel`, `featured-destinations`, `booking-flow-variant`, `promo-banner-text`.

### Deployment

- **GitHub Actions** (`.github/workflows/deploy-<vendor>.yml`) — Each branch has its own workflow triggered on push. Deploys via SSH to the branch's EC2 instance.
- **PM2** (`deployment/ecosystem.config.js`) — Runs 2 cluster workers. Log files at `/var/log/toggle-travel/out-*.log` (wildcard needed for cluster mode).
- **Nginx** (`deployment/nginx.conf`) — Reverse proxy to `localhost:3000`.
- **`.env`** lives at `/var/www/toggle-travel/.env` on EC2. LD keys are injected by the deploy workflow from GitHub Secrets on every deploy.

### Observability — per branch

| Branch | Server tracing | RUM | Logs |
|---|---|---|---|
| `datadog` | `dd-trace` auto-instrumentation, service=`toggle-travel` | DD RUM (`public/js/rum.js`) | Winston JSON → DD agent → DD + LD dual-ship |
| `launchdarkly` | LD Observability Node SDK | LD Observability browser SDK + Session Replay | Winston with custom `LDTransport` |
| `dynatrace` | TBD | TBD | TBD |
| `grafana` | Not yet implemented | — | — |

On the `datadog` branch, the DD agent is configured to dual-ship logs and traces to both Datadog and LaunchDarkly via `additional_endpoints` in `DD_AGENT_CONFIG.yaml` (gitignored, lives on EC2).

## Key Environment Variables

```
PORT                          # Default 3000
NODE_ENV                      # development | production
ANTHROPIC_API_KEY             # Required for Vacation Mode
CLAUDE_MODEL                  # Default claude-opus-4-5
LD_SDK_KEY                    # LaunchDarkly server-side SDK key
LD_CLIENT_SIDE_ID             # LaunchDarkly client-side ID (served to browser via /api/config)
LD_API_TOKEN                  # LD REST token (Writer, ToggleTravel) — traffic conductor's daily flag flips
LD_PROJECT_KEY                # Default ToggleTravel
LD_ENV_KEY                    # Default launch-darkly
TRAFFIC_ENABLED               # Conductor master switch (true on EC2 via PM2 env_production)
TRAFFIC_PEAK_INTERVAL_MIN     # Browser rounds cadence at peak (default 5)
TRAFFIC_TROUGH_INTERVAL_MIN   # …and overnight (default 20)
TRAFFIC_API_RPM               # API-tier req/min at peak (default 20)
TRAFFIC_UNIQUE_PCT            # % of flows as new identities (default 70)
INCIDENT_ENABLED / INCIDENT_HOUR_ET / INCIDENT_AUTO_REVERT_MIN  # Daily checkout incident
SIMULATE_LATENCY_MAX_MS       # Default 1200 — set to 0 to disable artificial latency
SIMULATE_PAYMENT_FAILURE_RATE # Default 0.05 (5%)
```
