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

### AI Planner

The AI Planner page has a **Conversation | Agent** toggle (`public/ai-planner.html`). Both modes run on the LaunchDarkly AI SDK (`@launchdarkly/ai-node` + `@launchdarkly/ai-server`, the `js-ai-sdk` packages) sharing the app's one LDClient (`initClient(client)` from `launchdarkly.js` `init()`). The old `@launchdarkly/server-sdk-ai` is gone. Everything LD-side that the code depends on (targeting rules, judge attachments, metrics, tool versions, the graph's second variation, the experiment) is created idempotently by `scripts/ld-ai-planner-setup.js`, which the traffic conductor also runs at boot — run it once after a fresh environment, or with `--dry-run` to see what it would change.

- **Request → context** — `src/ai/context.js` `buildContext(req)` builds a **multi-context** `{ kind: 'multi', user: {...}, session: {...} }`. The user's tier is resolved **server-side** from `src/users.js` by `x-user-key`; a disagreeing `x-user-tier` header is logged as `tier_header_mismatch` and ignored (unknown keys may use the header if it is a real tier, marked `tierSource: 'header'`). Anonymous visitors carry `anonymous: true`. The classifier stamps `complexity` on the **user** part; every flag, AI Config and custom event on this feature evaluates against the full context (`getFlagFor` / `trackFor` in `launchdarkly.js`), so tier rules on `ai-planner-agent-enabled`, the judge thresholds or `ai-planner-limits` work. `name` is a private attribute. `public/js/flags.js` builds the same multi-context shape in the browser.
- **Prompt variables** — `buildPromptVariables()` is the single source of the Mustache variables for every AI Config on the feature: `user_name`, `user_key`, `product_tier` (Title Case), `tier_key`, `signed_in` (for `{{#signed_in}}` sections), `today`, legacy `name`/`tier`, and `ldctx` (the user part). Prompts are rendered with real Mustache (`src/ai/handlers.js` `render()`) — the SDK's own `parseTemplate()` does not support sections. The SDK also injects `ldContext`.
- **Provider handlers** — `src/ai/handlers.js` registers one `messages` handler per provider (Anthropic with streaming, Gemini/Google, OpenAI) wrapping `src/anthropic.js` / `gemini.js` / `openai.js` `chat()`, plus the `['*','agent']` handler from `aiGraph.js`, all on the SDK's `globalRegistry`. Each handler opens an OTel `ld.ai.generation` span with the SDK's `setLdSpanAttributes` / `setUsageSpanAttributes` / `setModelIdentityAttributes` so LD Observability traces correlate with the Monitoring tab. The Anthropic system prompt carries `cache_control`; the agent handler uses LangChain's `anthropicPromptCachingMiddleware`.
- **Conversation mode** (`src/ai/conversation.js`) — classify (`ai-planner-classifier`) → stream `ai-planner` → judge → retry → relevance. `src/ai/invoke.js` has `invokeConfig()` (the SDK's `config().invoke()` with `skipJudges`) and `streamConfig()`, this repo's streaming executor: the SDK's `config().stream()` drops the run's trackData from its `done` event, and that trackData is what feedback and judge scores attribute to. It emits the same `$ld:ai:*` events plus `$ld:ai:tokens:ttf`. The route answers **SSE** when the client sends `Accept: text/event-stream` (tokens stream into the bubble; a judge-rejected draft is replaced and shown struck-through in the dev view) and JSON otherwise (`scripts/chat-load.js`).
- **Routing is a targeting rule on `complexity`** — after the setup script, `ai-planner`'s rules are `complexity in [complex] → Sonnet 5`, `tier in [diamond] AND complexity in [complex] → Opus 5`, fallthrough Haiku 4.5 (variation `claude-haiku-4-5`, formerly misnamed `gemini-latest`). Tier drives tone through `{{product_tier}}`, not the model. The judge-triggered retry re-resolves the same config with `complexity: 'complex'`, so the strong model comes from that rule. The dev view and banner print the **served variation key + version** (from trackData / `_ldMeta`) as the proof — the SDK does not expose which rule matched.
- **Judges** (`src/ai/judges.js`) — which judges run is the `judgeConfiguration` attached to the served variation in LD (`ai-planner-judge` + `relevance` at 100%, `toxicity` sampled at 10%, after the setup script). `buildJudgeTasks()` applies LD's sampling; each task then runs as a normal tracked call of the judge config, with both template conventions supplied (`{{message_history}}`/`{{response_to_evaluate}}` and `{{message}}`/`{{response}}`), and the score is tracked against the **answering** run (`evaluationMetricKey`, answer trackData + `judgeConfigKey`). Two judges, two failure modes: the accuracy judge catches fabricated data and is the only one that retries; `relevance` catches off-topic drift / prompt-injection compliance and is report-only in conversation mode. Thresholds: LD number flags `ai-planner-judge-threshold` / `ai-planner-relevance-threshold` (0.7). Judges run on Haiku 4.5 after the script (a 0–1 score does not need a frontier model).
- **Agent mode** (`agents/supervisor.js`) — PLAN (root `ai-planner-agent`) → specialists in parallel → COMPOSE (`ai-planner-agent-compose`, the graph's sole terminal node), on the LD agent graph `ai-planner-graph` (roster and wiring are LD config; each root→specialist edge's handoff JSON carries `label`, `timeoutMs`, `pass`, `required`, `reportFormat`). PLAN uses **forced structured output** (LangChain `toolStrategy` on a JSON schema whose `specialists` enum is the live roster; an LD `outputFormat` on the node wins if present); an unparseable plan falls back to the location specialist, not the whole team. The catalog is **pre-fetched once** per turn and handed to every specialist. A failed `required` specialist is reported to the composer as unverified (`meta.unverified`). Judging: when the compose node has judges attached in LD the SDK's `runNode()` runs them (sampled, graph-attributed); otherwise the app's default pair runs with the specialist findings as evidence. The LD boolean `ai-planner-relevance-block` (default false) makes a relevance failure withhold the answer. Progress is streamed as SSE events (`plan`, `specialist`, `compose_start`, …). Whole-turn cap `AGENT_TURN_TIMEOUT_MS` (90 s); a client disconnect aborts the LangChain loop via an AbortSignal in `variables.__signal`.
- **Tools** — LD project tools `get_weather_forecast` (v2 adds a batch `locations` array; `src/tools/weather.js` fans out to Open-Meteo in parallel) and `search_destinations`; `src/tools/` owns the implementations bound by name through `TOOL_REGISTRY` — **registry keys must equal the LD tool keys**. The specialist prompt only asks for the batched weather call when the node's tool schema actually has `locations`. The catalog tool uses `destinationService.list()`, not `.search()` (random pricing multiplier).
- **Hardening** (`routes/aiPlanner.js`) — message ≤ 2000 chars (413), history capped at 12 turns / 4000 chars each, per-context sliding-window limits from the LD JSON flag `ai-planner-limits` backed by SQLite (`src/ai/limits.js`, cluster-safe; 429 with Retry-After), request-abort cancellation, provider SDK `maxRetries`. Customer text is delimited as data in all three agent prompt builders.
- **Custom metrics** — events `ai-planner-agent-turn` (count), `ai-planner-agent-specialists` and `ai-planner-agent-tool-calls` (numeric; one event per numeric value), `ai-planner-judge-retry`; plus numeric metrics `ai-judge-accuracy` / `ai-judge-relevance` on the SDK's `$ld:ai:judge:*` events (used by the experiment and the AI guarded rollout). All created by the setup script.
- **LD-side demos the script sets up** — experiment "AI Planner Model Quality" (Haiku vs Sonnet 5 on the fallthrough, primary `ai-judge-accuracy`); the `ai-planner` variation `bad-prompt` for the conductor's opt-in daily AI guarded rollout (`INCIDENT_AI_ENABLED`; mutually exclusive with the experiment — the conductor skips the day when the experiment is running); a second `ai-planner-graph` variation `lite` (weather + budget) for `tier in [silver, beta]`; the compose node on Sonnet 5 for all (no mirrored complexity rule); the supervisor's hardcoded roster removed from its instructions.

Gotchas worth knowing before touching this code:

0. **New-SDK traps, all hit in practice.** (a) The packages are **ESM-only** and this app is CommonJS — `aiGraph.js` loads them through a cached dynamic `import()`. (b) Handlers are selected by *provider + LD mode*; a messages-mode judge attached to an agent node is served by the exact provider handler only if it is in the `handlers` passed to `resolveGraph` (so pass `getHandlers()`, not just the agent handler). (c) The stock `createLangChainAgentsHandler()` returns an **empty answer** for Claude 5 (array content blocks) — `aiGraph.js` registers its own agent handler with a block-aware `extractText()`. (d) `config().stream()` drops trackData; `parseUsage` is not exported; `buildJudgeTasks()`+`runJudge()` hand the judge only the answer (no question) — hence `streamConfig()` and the judge runner in this repo. (e) `runNode()` always runs the judges attached to a node (no skip option). Tool results must be strings: `instrumentTools()` JSON-stringifies them.
1. **Sampling params are fatal on Claude 5.** `temperature`/`topP`/`topK` return a hard 400 on Opus 5 and Sonnet 5 but are accepted by Haiku 4.5. `sanitizeParameters()` in `src/ai/handlers.js` strips them per model; the provider wrappers also self-heal by dropping the flagged param and retrying.
2. **Opus 5 / Sonnet 5 spend budget on thinking.** `max_tokens` on the agent variations (set by the script: PLAN/COMPOSE 1024, specialists 2048) is deliberately above a pure-output estimate — a truncated PLAN costs a fan-out of the wrong specialists.
3. **The judge templates use LD's reserved names.** After the script, `ai-planner-judge` reads `{{message_history}}`/`{{response_to_evaluate}}` so the SDK's own judge runner (agent mode, compose node) can fill it; the app's runner supplies both conventions. A messages handler must not append `userInput` when the rendered template already embeds it (judge templates do) — `buildCall()` checks.
4. **Cost until the LD script has run:** `ai-planner` still carries the generic `accuracy`/`relevance`/`toxicity` judges at 100% (three Sonnet 4.5 calls per turn) and still routes on tier; the code handles both states, the script fixes them.

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
AGENT_SPECIALIST_TIMEOUT_MS    # Default 60000 — per-specialist cap in agent mode (edge handoff.timeoutMs wins)
AGENT_TURN_TIMEOUT_MS          # Default 90000 — whole agent turn (PLAN + specialists + COMPOSE)
WEATHER_TIMEOUT_MS            # Default 6000 — Open-Meteo request timeout
TRAFFIC_AI_ENABLED (false) / TRAFFIC_AI_RPH (6) / TRAFFIC_AI_AGENT_PCT (10) / TRAFFIC_AI_DAILY_TOKENS (200000)  # conductor AI tier (opt-in)
INCIDENT_AI_ENABLED (false) / INCIDENT_AI_HOUR_ET (9) / INCIDENT_AI_RPM (4)  # conductor daily AI guarded rollout (opt-in)
SIMULATE_LATENCY_MAX_MS       # Default 1200 — set to 0 to disable artificial latency
SIMULATE_PAYMENT_FAILURE_RATE # Default 0.05 (5%)
```
