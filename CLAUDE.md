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

- **`scripts/traffic-conductor.js`** — PM2 app `toggle-traffic` (see `deployment/ecosystem.config.js`). Three loops: (1) browser tier — spawns `playwright-load.js --rounds 1 --unique-personas 70` on a diurnal cadence (peak/trough intervals via env), pausing while a manual `/api/demo/seed` run is active; (2) API tier — cheap `fetch` traffic with rotating synthetic identities via `x-session-id`; (3) incident scheduler — daily at `INCIDENT_HOUR_ET` (7am ET) starts a **guarded rollout** on `new-checkout-flow` via LD REST (`LD_API_TOKEN`), watches for LaunchDarkly's auto-rollback, and force-stops after `INCIDENT_AUTO_REVERT_MIN` only as a backstop. Ensure-creates the flag + `booking-error` metric at boot.
- **The guarded-rollout checkout incident**: at 7am the conductor calls `startAutomatedRelease` (guarded, `releaseKind: guarded`, `LD-API-Version: beta` header) on `new-checkout-flow` — treatment (`true`) at 50%, control (`false`) at 50%, guarded by the `booking-error` metric with `autoRollback`. `routes/bookings.js` evaluates the flag per request; treatment-arm confirms **always** throw `CheckoutV2Error` (500) for all destinations, and it fires `booking-error` **server-side** via `launchdarkly.js` `track()` (same `req.sessionId`/`x-session-id` context that evaluated the flag) so the cheap API-tier **checkout surge** feeds the guard. `booking.html` also fires `booking-error` client-side (replay timeline) and shows a styled "500 — Checkout Unavailable" banner + the "✨ NEW CHECKOUT" badge for treatment users. LaunchDarkly detects the regression vs. the healthy control arm and rolls back within minutes; the conductor then re-arms clean for the next day. Guarded rollouts cap treatment at 50% by design (the control arm is required for the comparison).

### AI Planner — agent mode

The AI Planner page has a **Conversation | Agent** toggle (`public/ai-planner.html`). Conversation mode is the original single-model path. Agent mode (`ai-planner-agent-enabled`, default off — it costs roughly 30x a conversation turn) runs a multi-agent fan-out.

- **`agents/supervisor.js`** — `runAgentTurn()` drives three phases: the supervisor's PLAN call decides which specialists a request needs, the chosen specialists run **in parallel**, then a second supervisor call COMPOSEs the single customer-facing answer. Which specialists run is the supervisor's decision, never the code's.
- **LD agent graph `ai-planner-graph`** — the roster and wiring are LD config, not code. Root = `ai-planner-agent`; one edge per specialist; each edge's **handoff JSON** carries that specialist's `label`, `timeoutMs`, `pass` and `reportFormat`, which the prompts and the per-specialist timeout read at runtime. Adding a fifth specialist or retuning a timeout is a graph edit in LD with no deploy. Backed by a plain multivariate flag whose `default` variation is `{root, edges}`; REST is `/api/v2/projects/ToggleTravel/agent-graphs/ai-planner-graph` (`PATCH` needs `rootConfigKey` **and** `edges` together, and LD assigns its own edge keys).
- **`aiGraph.js` — the new AI SDK (AgentControl)** — agent mode runs on `@launchdarkly/ai-node` + `@launchdarkly/ai-server` (the `js-ai-sdk` packages), while conversation mode stays on `@launchdarkly/server-sdk-ai`. Both share one LDClient (`initClient(client)` from `launchdarkly.js` `init()`), so the process keeps a single flag stream. `resolveGraph()` gives the topology with each node's config already evaluated; `def.runNode(node, prompt, {variables, toolHandlers, from})` executes one node through the tracked path, so `$ld:ai:duration:total`, `tokens:*`, `tool_call` and per-edge `graph:handoff_*` are automatic. The whole-workflow events (`graph:invocation_success`, `:duration:total`, `:total_tokens`, `:path`) are only emitted by the SDK's own `graph().invoke()` router, so `createGraphRun()` emits them for this app's custom fan-out.
- **LD AI Configs (agent mode)** — `ai-planner-agent` (supervisor; two variations with a targeting rule on the `complexity` context attribute: Sonnet 5 for `simple`, Opus 5 for `complex`), plus specialists `ai-planner-agent-weather` (Haiku 4.5), `-location` (Sonnet 5), `-budget` (Haiku 4.5), `-timing` (Sonnet 5). Model choice is entirely LD config.
- **Tools** — LD project tools `get_weather_forecast` and `search_destinations` own each tool's name, description and JSON schema; `src/tools/` owns the implementations, bound by name through `TOOL_REGISTRY`. A tool declared in LD with no registry entry is silently skipped, so **the registry keys must equal the LD tool keys**. Weather data is real (Open-Meteo, no API key). The catalog tool is built on `destinationService.list()`, not `.search()`, because `search()` applies a random pricing multiplier — two specialists would then cite different prices for the same trip.
- **Prompt variables (user context)** — `buildPromptVariables()` in `routes/aiPlanner.js` is the single source of the Mustache variables handed to every AI Config resolution on the route (completion, classifier, judge, and all agent configs): `user_name`, `user_key`, `product_tier` (Title Case for prose), `tier_key` (lowercase, matches the targeting rules), `signed_in` (for `{{#signed_in}}` sections), `today`, plus `name`/`tier` aliases for older variations. The `ai-planner` variations' system message uses them — "You are a support agent for `{{product_tier}}` customers. Address the user as `{{user_name}}`." — so personalization is a variation edit in LD, not a deploy. The LD AI SDK also injects the raw context as `ldctx`, so a prompt can reach `{{ldctx.tier}}` without the variable being listed. The dev view prints the variables and the fully rendered system prompt (`debug.systemPrompt`).
- **`ai-planner-classifier` / `ai-planner-judge`** — both now exist as real AI Configs (previously the code fell back to hardcoded defaults, which meant the judge silently ran on OpenAI). Both modes classify and judge through the same LD configs; agent mode does not retry, since the answer already came from the full fan-out.

Gotchas worth knowing before touching this code:

0. **New-SDK traps, all three hit in practice.** (a) The packages are **ESM-only** and this app is CommonJS — `aiGraph.js` loads them through a cached dynamic `import()`. (b) Handlers are selected by *provider + LD mode*, so an agent-mode node needs an `agent` handler; a messages handler throws "Handler for provider Anthropic with mode agent not found". (c) `createLangChainAgentsHandler()` returns an **empty answer** for every Claude 5 node — it does `typeof content === 'string' ? content : ''` and Claude 5 returns an array of content blocks — so `aiGraph.js` registers its own `['*','agent']` handler with a block-aware `extractText()`, which also honours LD's `max_tokens` and still omits sampling params. Tool results must be strings too: `instrumentTools()` JSON-stringifies them (`src/tools/` returns objects) and records the call names, since the new SDK reports tool calls as events/spans rather than in the response.

1. **Sampling params are fatal on Claude 5.** `temperature`/`topP`/`topK` return a hard 400 on Opus 5 and Sonnet 5 but are accepted by Haiku 4.5. `sanitizeParameters()` in `routes/aiPlanner.js` strips them per model; `src/anthropic.js` also self-heals by dropping the flagged param and retrying.
2. **`ManagedResult.content` is empty on Opus 5.** The LangChain provider's `extractLastMessageContent` only handles string content, and Opus 5 has thinking on by default so it returns an array of blocks. `extractText()` in `agents/supervisor.js` recovers the text from `result.raw`. This is also why judges are **not** attached via LD's `judgeConfiguration`: `ManagedAgent.run()` hands the judge that same empty string, so it would score a blank answer.
3. **`aiClient.createAgent()` cannot bind tools.** It calls `RunnerFactory.createAgent(config, undefined, …)`, so every LD-declared tool is skipped. `getAgent()` in `launchdarkly.js` resolves the config and builds the runner itself to pass the registry. The registry is passed in by the caller rather than imported, because the tool modules reach services that require `launchdarkly.js` (a cycle that would leave `externalMockService`'s `getFlag` undefined).

### Experimentation & Multi-armed bandit

- **Setup**: `scripts/ld-experiment-setup.js` (invoked once, idempotently, at conductor boot) creates via LD REST — metrics `booking-conversion` (event `confirm-booking`), `promo-click`, `destination-view` (all higher-is-better, unit `user`); the `search-ranking` flag; and both analyses through the stable `POST .../experiments` endpoint (`type: 'experiment'` vs `type: 'mab'`, `startIteration` to run). Requires `LD_API_TOKEN` + a `maintainerId` (`LD_MAINTAINER_ID`, defaults to the project owner). Safe to re-run — skips anything that exists.
- **Experiment "Promo Banner Messaging"** on `promo-banner-text` (4 promos, fixed 25/25/25/25): which promo drives the most bookings. Primary metric `booking-conversion`, secondary `promo-click` (fired on the banner CTA in `nav.js`).
- **MAB "Search Ranking Optimizer"** on `search-ranking` (recommended / price-low / price-high / trending; reallocates hourly): auto-shifts to the sort maximizing `destination-view` (fired on `destination.html`). `destinationService.search` maps the ranking → `ORDER BY`; `search.html` evaluates the flag after LD init and passes it to `/api/search`.
- **Load-gen bias** (`playwright-load.js`) reads both flags via `readActiveFlags()` and biases rewards so the demo shows a decisive winner: **Free Upgrade** completes bookings ~90% vs ~55% (experiment), and **trending** shoppers view 3–5 destinations vs 1–2 (MAB). `completeBooking` books a non-Atlantis destination so the conversion signal isn't masked by the Atlantis 404.
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
INCIDENT_ENABLED / INCIDENT_HOUR_ET (7) / INCIDENT_MONITOR_WINDOW_MIN (5) / INCIDENT_AUTO_REVERT_MIN (20)  # Daily guarded-rollout checkout incident
INCIDENT_API_RPM (15) / INCIDENT_CHECKOUT_COUNT (6)  # incident API rate + browser checkout-surge sessions
LD_MAINTAINER_ID              # maintainer for REST-created experiments (defaults to project owner)
AGENT_SPECIALIST_TIMEOUT_MS    # Default 60000 — per-specialist cap in agent mode
WEATHER_TIMEOUT_MS            # Default 6000 — Open-Meteo request timeout
SIMULATE_LATENCY_MAX_MS       # Default 1200 — set to 0 to disable artificial latency
SIMULATE_PAYMENT_FAILURE_RATE # Default 0.05 (5%)
```
