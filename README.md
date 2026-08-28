# Toggle Travel — Sentry

A demo travel booking app built to showcase observability tooling. The same application runs across multiple EC2 instances — each branch is instrumented with a different vendor so you can compare what each tool sees from identical traffic.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + Express |
| Process manager | PM2 (2 cluster instances) |
| Reverse proxy | Nginx |
| Logging | Winston (structured JSON) |
| Feature flags | LaunchDarkly (Node + JS client SDKs) |
| Observability | Sentry (errors, tracing, session replay) |
| Database | SQLite (better-sqlite3) |
| Infrastructure | AWS EC2 (t2.medium) |
| CI/CD | GitHub Actions → SSH deploy |

## Branch Strategy

Each branch targets a dedicated EC2. The only diff between `main` and a vendor branch is the vendor's nav badge and any SDK instrumentation code.

The `sentry` branch is the one exception worth noting: it adds LaunchDarkly feature flagging *and* Sentry observability, so it can be compared against `launchdarkly` (which uses LaunchDarkly for both) with the observability vendor as the only variable.

| Branch | Vendor | EC2 Secrets |
|---|---|---|
| `main` | Clean base — no vendor code | — |
| `dynatrace` | Dynatrace OneAgent | `EC2_HOST_DT` / `EC2_SSH_KEY_DT` |
| `launchdarkly` | LaunchDarkly Observability | `EC2_HOST_LD` / `EC2_SSH_KEY_LD` |
| `datadog` | Datadog Agent + dd-trace | `EC2_HOST_DD` / `EC2_SSH_KEY_DD` |
| `grafana` | Grafana Alloy + OTLP | `EC2_HOST_GF` / `EC2_SSH_KEY_GF` |
| `sentry` | LaunchDarkly flags + Sentry | `EC2_HOST_SENTRY` / `EC2_SSH_KEY_SENTRY` |

> Adding a new vendor: branch off `main`, add the vendor's badge to `nav.js`, add SDK/agent setup, create a deploy workflow following the existing pattern.

## What the App Does

- **Destination catalog** — 13 travel destinations with simulated weather and dynamic pricing (Atlantis, `dest-013`, is deliberately unbookable and always 404s)
- **Search** — filter by region, price, keyword, departure date
- **Booking flow** — inventory check → payment authorization (5% simulated decline rate) → confirmation
- **Feature flags** — LaunchDarkly drives the promo banner, featured destinations, result ranking, and the checkout code path; every evaluation is reported to Sentry as a searchable `flag.<key>` tag
- **Daily checkout incident** — a guarded rollout on `new-checkout-flow` ships a deliberately broken checkout to 50% of traffic each morning; LaunchDarkly auto-rolls-back on the `booking-error` metric while Sentry captures the flag-attributed 500s
- **Simulated latency** — configurable via `SIMULATE_LATENCY_MAX_MS` env var
- **External mock services** — weather API (50–200ms), pricing engine (100–400ms, 3% timeout), payment processor (100–300ms, 5% decline)

## Telemetry Signals

Every request produces structured JSON logs (Winston). Key events:

| Event | Fields |
|---|---|
| `http_request` | method, path, status_code, duration_ms, session_id, ip, user_agent |
| `booking_stage` | stage (inventory_check / payment_authorized / payment_declined), booking_id, duration_ms, session_id |
| `booking_created` | booking_id, destination, travelers, total_amount, transaction_id, session_id |
| `payment_authorized` | transaction_id, amount |
| `destinations_listed` | count |
| `weather_api_response` | destination_id, temperature, condition |
| `pricing_engine_response` | destination_id, multiplier, dynamic_pricing |
| `checkout_v2_failed` | checkout_version, destination_id, session_id (the daily incident) |
| `booking_failed_destination_unreachable` | booking_id, destination_id, quoted_amount (Atlantis 404) |

Log files on EC2: `/var/log/toggle-travel/out-{0,1}.log` and `error-{0,1}.log`

## Local Setup

```bash
git clone https://github.com/bobby-digital-insanity/toggleTravel
cd toggleTravel
cp .env.example .env
# Optional: add LD_SDK_KEY / LD_CLIENT_SIDE_ID / SENTRY_DSN to .env.
# Without them the app still runs — flags fall back to code defaults and Sentry is disabled.
npm install
npm run dev
```

App runs at `http://localhost:3000`

## Generating Traffic

The seed load script simulates realistic user sessions:

```bash
# Default: 3 rounds against localhost
node scripts/playwright-load.js

# Against a live EC2
node scripts/playwright-load.js --host http://<EC2-IP> --rounds 5

# Checkout surge — what the traffic conductor runs during the daily incident
node scripts/playwright-load.js --checkout 6 --checkout-only --unique-personas 100

# Extended demo session with longer pauses between rounds
node scripts/playwright-load.js --host http://<EC2-IP> --rounds 10 --pause 30
```

**Six flow types per round:**

| Flow | Description | Requests |
|---|---|---|
| Window Shopper | Browses destinations, never books | ~5 |
| Abandoned | Searches and views but walks away | ~7 |
| Complete Booking | Full happy path with confirmation | ~7 |
| Atlantis | Books `dest-013`, always 404s (Sentry error signal) | ~5 |
| Error Spike | Intentional 400/404s for error rate signals | ~4 |

Each round is ~30–35 requests. A 3-round run takes roughly 4–5 minutes.

Every session ends by flushing Sentry replay/events and LaunchDarkly analytics before the browser
closes — headless Chromium skips a real unload, so without that flush the tail of each session is
lost, including the `booking-error` events that feed the rollout guard.

## EC2 UserData

See `deployment/user-data.sh` for the full bootstrap script. Secrets are injected into `/var/www/toggle-travel/.env` by the deploy workflow on every deploy
(`LD_SDK_KEY`, `LD_CLIENT_SIDE_ID`, `LD_API_TOKEN`, `SENTRY_DSN`, `SENTRY_RELEASE`), so no SSM
parameters are required for this branch.
