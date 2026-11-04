# AI Planner (Conversation + Agent mode) — Architecture Review and Work Order

Reviewed 2026-09-03 against the `launchdarkly` branch at commit `2ed1c08`, the live LaunchDarkly project `ToggleTravel` (environment `launch-darkly`), the installed SDK sources (`@launchdarkly/server-sdk-ai@1.2.3`, `@launchdarkly/ai-server@0.1.1`), and the last ~10 days of `ai_planner_chat` / `ai_planner_agent_turn` logs in LD Observability.

This document is written as a hand-off for an implementing agent. Each item says what is wrong, why it matters for the demo story (cheaper / safer / faster / observable), where it lives, and what to do. Items are ordered by priority within each section. P0 = the demo story is currently false or broken; P1 = a real gap against production best practice; P2 = polish.

Files in scope: `src/routes/aiPlanner.js`, `src/agents/supervisor.js`, `src/aiGraph.js`, `src/launchdarkly.js`, `src/anthropic.js`, `src/gemini.js`, `src/openai.js`, `src/tools/*`, `public/ai-planner.html`, `scripts/chat-load.js`, `CLAUDE.md`.

---

## 0. What is good and should not be touched

- Model, prompt, tool schemas, specialist roster, per-edge timeouts and report formats all live in LD. That is the right split.
- The `['*','agent']` handler in `aiGraph.js` with block-aware `extractText()` is the correct workaround for Claude 5 content arrays; keep it until the upstream handler is fixed.
- Sharing one `LDClient` between the old and new AI SDK (`initClient(client)`) is correct.
- Tools return errors as data instead of throwing; the catalog tool uses `list()` not `search()` for price stability; Atlantis is guarded in both tools. All good agent-tool hygiene.
- Thumbs up/down feedback is wired for both modes and reaches the LD `$ld:ai:feedback:user:*` metrics.
- The graph-level `$ld:ai:graph:*` events emitted by `createGraphRun()` match what the SDK's own router emits, so the graph Monitoring tab is populated correctly.

---

## 1. P0 — The routing story is not true in conversation mode

### 1.1 `ai-planner` targets on `tier`, not `complexity`

**Observed in LD.** The `ai-planner` completion config's rules (env `launch-darkly`) are:

| Rule | Clause | Variation |
|---|---|---|
| 1 | `tier in [admin, beta, silver]` | Claude Haiku 4.5 (variation key `gemini-latest`) |
| 2 | `tier in [gold, platinum]` | Claude Sonnet 5 |
| 3 | `tier in [diamond]` | Claude Opus 5 |
| fallthrough | | Claude Haiku 4.5 |

There is **no rule on `complexity`**. Only the agent-mode configs (`ai-planner-agent`, `ai-planner-agent-compose`) have the `complexity in [complex] → Opus 5` rule.

**Consequences.**
- The classifier call in conversation mode (one Haiku call per turn, ~1–2 s) has zero effect on which model answers. It is pure cost and latency.
- The judge-triggered retry re-resolves `ai-planner` with `complexity: 'complex'` and gets **the same variation back**, so the "retry on the strong model" is a retry on the same model. The logs confirm two retries on Haiku in the last window; both re-ran Haiku.
- `CLAUDE.md`, the code comments, the dev view ("routed by: targeting rule on context.complexity"), and the demo script all describe behaviour that does not exist.

**Decide the story, then make code and LD agree.** Two coherent options:

- **Option A (recommended for the demo): route on complexity, personalize on tier.** In LD, change `ai-planner` rules to: `complexity in [complex] → Sonnet 5` (or Opus 5), fallthrough Haiku 4.5. Keep tier out of model selection; tier already drives tone via `{{product_tier}}` in the prompt. Optionally add one rule `tier in [diamond] AND complexity in [complex] → Opus 5` to show compound targeting. This makes the classifier, the retry, the dev view and the docs true.
- **Option B: route on tier only.** Delete the classifier from conversation mode, delete the retry, and change the dev view/docs. Cheaper and honest, but loses the "cheaper" story.

Either way, update the dev view text in `public/ai-planner.html` (`'routed by'` lines) to print the actual matched rule rather than a hardcoded string. The old SDK does not expose the matched rule; the closest honest label is the served `variationKey` (available on `config.tracker` track data / `_ldMeta.variationKey` via a raw `client.variation`). Print that.

### 1.2 Variation named `gemini-latest` serves Claude Haiku

Cosmetic but confusing on stage: rename the `ai-planner` variation key/name to `claude-haiku-4-5`. Do it via the LD UI or `PATCH /ai-configs/ai-planner/variations/gemini-latest` (variations are patched by key).

---

## 2. P0 — Judge results are mostly invisible to LaunchDarkly

### 2.1 Agent mode never emits judge scores

`runJudgeConfig()` in `routes/aiPlanner.js` tracks the judge call's own duration/tokens on the judge config, but the **score** is only pushed to LD in conversation mode via `tracker.trackJudgeResult()` for the accuracy judge. In `/agent-chat` there is no tracker and no `client.track(evaluationMetricKey, …)`, so `$ld:ai:judge:accuracy` receives nothing from agent mode, and `$ld:ai:judge:relevance` receives nothing from **either** mode. The autogen metrics `ld_autogen__ai-judge-accuracy` / `ld_autogen__ai-judge-relevance` exist in the project and will stay flat.

**Fix.** In `runJudgeConfig()`, after parsing the score, emit the evaluation metric against the *answering* config's track data, not the judge's:

- Conversation mode: call `tracker.trackJudgeResult()` for **both** judges (it already exists for accuracy). Pass `metricKey: src.evaluationMetricKey`.
- Agent mode: `client.track(src.evaluationMetricKey, context, { ...composeRun.trackData, judgeConfigKey: configKey }, score)`. This is exactly what the new SDK's `runJudges()` does (see `ai-server/dist/judges.js`), so the graph Monitoring tab will attribute the score to the compose node and the graph run.

Better still, see §4.1: let the new SDK run the judges and this whole problem disappears.

### 2.2 The `judgeConfiguration` attached in LD is dead, and would be expensive if it woke up

All three `ai-planner` variations have `accuracy`, `relevance`, `toxicity` attached at `samplingRate: 1`. Nothing invokes them today (the route calls provider `chat()` directly). If conversation mode is moved to `config().invoke()` (§4.1), all three judges will fire on every turn, tripling judge cost. Also, the generic `accuracy` judge and `ai-planner-judge` both write to `$ld:ai:judge:accuracy` with different rubrics, which will muddle the metric.

**Fix in LD.**
- Detach the generic `accuracy` and `toxicity` from `ai-planner` (or keep `toxicity` at `samplingRate: 0.1` as a "safety sampling" demo point).
- Attach `ai-planner-judge` (the travel-specific rubric) instead of generic `accuracy`.
- Set `relevance` to `samplingRate: 1` only if you want it as the injection gate; otherwise 0.25. Sampling rate is the LD lever for judge cost and is a good on-stage moment.
- Delete the leftover `relevance` variation `sonnet-4-5` whose prompt still says `[REPLACE WITH CRITERIA]. test`.

### 2.3 Judge model choice contradicts the code's rationale

`routes/aiPlanner.js` says the judge fallback runs on OpenAI "to avoid self-preference bias", but the live `ai-planner-judge` and `relevance` configs serve **Claude Sonnet 4.5**. Two Sonnet 4.5 judge calls per turn cost more than the Haiku answer they are grading (Sonnet 4.5 is 3× Haiku 4.5 on input, 3× on output at LD's model-config prices). Pick one:

- Cheap and adequate for a 0–1 score: Haiku 4.5 for both judges.
- Independent: `OpenAI.gpt-4o-mini` or `gpt-5-mini` for both (keys are already in `.env` and the deploy workflow).

Update the comment either way.

---

## 3. P0 — Custom LD events have no metrics, and contexts lose attributes

### 3.1 `ai-planner-agent-turn` and `ai-planner-judge-retry` are fired but no LD metric exists

The metrics list for `ToggleTravel` has 70 metrics; none are keyed to these events, so the `track()` calls in `supervisor.js` and `routes/aiPlanner.js` are invisible. Create them (REST `POST /api/v2/metrics/ToggleTravel`, same pattern as `scripts/ld-experiment-setup.js`):

| Metric key | Event | Kind | Success |
|---|---|---|---|
| `ai-planner-agent-turn` | `ai-planner-agent-turn` | custom, count | — |
| `ai-planner-agent-specialists` | `ai-planner-agent-turn` | custom numeric, value = `specialist_count` | lower is better |
| `ai-planner-agent-tool-calls` | `ai-planner-agent-turn` | custom numeric, value = `tool_calls` | lower is better |
| `ai-planner-judge-retry` | `ai-planner-judge-retry` | custom, count | lower is better |

For the numeric ones, pass the number as the `metricValue` argument to `track()`, not inside `data`.

Add these to `ld-experiment-setup.js` so they are ensure-created at conductor boot like the booking metrics.

### 3.2 `getFlag()` and `track()` build a key-only context

`launchdarkly.js` `getFlag(key, default, sessionId)` and `track(event, sessionId, …)` construct `{ kind: 'user', key }` and drop `name`, `tier`, `complexity`. So:

- `ai-planner-api`, `ai-planner-agent-enabled`, `ai-planner-judge-threshold`, `ai-planner-relevance-threshold` cannot be targeted by tier (e.g. "Diamond gets a stricter judge threshold", "agent mode only for Platinum+"), which is exactly the kind of rule the demo should show.
- Every custom event lands on a context with no attributes, so LD experiments and metric breakdowns by tier are impossible.

**Fix.** Add `getFlagFor(key, default, context)` and `trackFor(event, context, data, value)` that accept the full context built by `buildContext(req)`; use them everywhere in `routes/aiPlanner.js` and `supervisor.js`. Keep the old signatures for the other routes.

### 3.3 Anonymous contexts should be marked anonymous; consider multi-context

Anonymous visitors are `{ kind: 'user', key: 'anon-xxxx' }`. LD best practice is `anonymous: true` on those (they are then excluded from the Contexts list and from context-based billing) and, ideally, a multi-context `{ kind: 'multi', user: {...}, session: { key: sessionId } }` so flags can target either the person or the session. Apply in `buildContext(req)` and in `public/js/flags.js` `identify()`.

### 3.4 Client-controlled headers decide the model bill

`x-user-tier` from the browser selects Opus vs Haiku (and, after §1.1, could still gate agent mode). Fine for a demo, unacceptable as a "production reference". Add a server-side resolution step: look the tier up from the persona/user store keyed by `x-user-key` (or a signed cookie) and ignore the header when they disagree. Log a `tier_header_mismatch` warning so the demo can show it.

---

## 4. P1 — SDK architecture: one process, two AI SDKs, three hand-rolled providers

### 4.1 Move conversation mode to `@launchdarkly/ai-server` `config().invoke()` / `.stream()`

Today conversation mode uses the old `server-sdk-ai` (`completionConfig` + manual `tracker.*` calls) and hand-rolled `chat()` wrappers for Anthropic, Gemini and OpenAI, with `pickChat()` sniffing the model name. The new SDK already models exactly this: a **handler per provider+mode** selected by the config's `provider.name`. Benefits of moving:

- Judges attached in LD (`judgeConfiguration`) run automatically with correct attribution (fixes §2.1 without custom code). The SDK also handles judge sampling and cross-provider handler fallback.
- `invoke(userInput, context, variables, history)` takes the conversation history natively.
- `.stream()` gives token streaming and `$ld:ai:tokens:ttf` (time-to-first-token) for free; the project already has `ld_autogen__ai-time-to-first-token*` metrics that are empty.
- Single `trackData` shape → one feedback path (`recordGraphFeedback`) instead of two token formats.
- Deletes `pickChat()`, most of `resolvePlannerConfig()`, and the duplicate tracker plumbing in `classifyMessage()` / `runJudgeConfig()` / `generate()`.

**Implementation sketch.**
1. Register three `messages` handlers with `createHandler(['Anthropic','messages'], …)`, `['Gemini','messages']`, `['OpenAI','messages']`. Each wraps the existing `src/anthropic.js` / `gemini.js` / `openai.js` `chat()` so the self-healing param logic is kept. Return `{ output, usage: { input_tokens, output_tokens } }`. Add a `stream` implementation for Anthropic at minimum.
2. Register them once in `globalRegistry` (from `@launchdarkly/ai-server`) alongside the agent handler, so judges resolved from a messages-mode config find an exact handler instead of falling back to the agent handler.
3. Conversation route: `const { invoke, stream } = config({ key: 'ai-planner' })`; `await invoke(message, context, variables, history)`; read `judgeResults` for the retry decision.
4. Classifier: `config({ key: 'ai-planner-classifier', skipJudges: true })`.
5. Keep `sanitizeParameters()` inside the Anthropic handler.
6. Remove `@launchdarkly/server-sdk-ai` and `server-sdk-ai-langchain` from `package.json` once `getAgent()`/`getAgentConfig()` in `launchdarkly.js` are deleted (they are unused by the routes today).

Do this as its own commit; it touches every LLM call.

### 4.2 The retry should happen inside LD's model, not around it

After §1.1 the retry is real again. Make it observable: emit `$ld:ai:generation:error`-style signal? No. Instead record the *first* generation's judge score on the first variation (so the Haiku variation's Monitoring shows the low score) and the retry's score on the strong variation. With `config().invoke()` this is automatic because each call has its own `trackData`.

### 4.3 Add streaming to the UI

Both modes render nothing for 5–75 s. Conversation mode should stream (SSE or chunked fetch) via `.stream()`. Agent mode cannot stream the final answer until COMPOSE, but it **can** stream progress events: "PLAN done (Opus 5, 1.2 s) → running weather, budget → weather done (13 tool calls)". Send them as SSE from `runAgentTurn()` via an `onEvent` callback; replace the fake elapsed-seconds ticker in `showTyping()`.

---

## 5. P1 — Agent mode cost and latency

Observed over the last window (LD Observability, `ai_planner_agent_turn`):

| Shape | Duration | Total tokens | Tool calls |
|---|---|---|---|
| simple, 1 specialist | 6–15 s | ~8k | 1–2 |
| complex, 3–4 specialists | 35–75 s | 24k–69k | 13–32 |
| PLAN produced 0 specialists | 6–9 s | ~2k | 0 |

Specialist failures in the sample: weather timed out in 2 of the last 4 complex runs, timing in 2 others, location once. The `handoff.required: true` on the weather edge is ignored by the code.

### 5.1 Stop re-fetching the catalog in every specialist

Every specialist starts by calling `search_destinations` for the same 13 records. Fetch the catalog **once** in `runAgentTurn()` (it is local JSON), attach the narrowed candidate list to the specialist prompt (or as a `candidates` field in the handoff payload), and tell specialists to call the tool only for filters the pre-fetched list cannot answer. Saves one tool round-trip and ~2–4k input tokens per specialist.

### 5.2 Give the weather tool a batch form

The 30-tool-call turns are the weather specialist calling `get_weather_forecast` once per destination. Add an optional `locations: [{name, lat, lon}]` array to the LD tool schema (new tool version) and let `src/tools/weather.js` fan out to Open-Meteo in parallel with `Promise.all`. One tool call instead of 13, and it removes the most common timeout.

### 5.3 Honour `required` and use it to short-circuit

A required specialist that fails should either (a) retry once with a shorter horizon, or (b) return 503-style "couldn't check the weather" instead of composing a confident answer on partial data. Read `handoff.required` in `runSpecialist()` and surface it in the compose prompt ("REQUIRED specialist unavailable — tell the customer you could not verify weather").

### 5.4 PLAN failure fallback is the most expensive path

An unparseable PLAN runs all four specialists. Use structured output instead of prose-JSON: give the supervisor a `submit_plan` tool whose schema is the plan object and force its use (LangChain `tool_choice`), or use the new SDK's `outputFormat` on the config. Then a parse failure is impossible and the fallback question goes away. If a fallback is still wanted, make it the cheapest sensible set (e.g. `location` only), not everything.

### 5.5 Set `max_tokens` on every agent variation

All six agent-mode variations have `model.parameters: {}`, so the handler passes no `maxTokens` and LangChain's default applies. Set explicit values in LD (PLAN 512, specialists 1024, COMPOSE 600) so the cost ceiling is LD config and visible in the banner.

### 5.6 Consider prompt caching for the specialist system prompts

Specialist instructions plus tool schemas are identical across calls. Anthropic prompt caching (`cache_control` on the system block) would cut input cost on Sonnet/Opus specialists substantially; the new SDK's `addCachedTokensToInput()` already knows how to fold `cache_read_input_tokens` into the LD token metrics. Implement in the Anthropic messages handler and in the agent handler (LangChain `ChatAnthropic` supports `cache_control` on message content blocks).

### 5.7 Agent-mode judges run at 100% on the most expensive path

Two Sonnet 4.5 judge calls after a 40 s Opus fan-out. Put them behind LD sampling (§2.2) and, once on the new SDK, attach `relevance` to the compose node's `judgeConfiguration` or use `graph({ graphJudge: 'relevance' })` semantics so the sample rate is an LD knob.

---

## 6. P1 — LD features the demo claims but does not use

### 6.1 No experiment on any AI Config

The project has experiments on `promo-banner-text` and `search-ranking`, none on AI. The strongest LD AI story is an experiment on `ai-planner`: Haiku 4.5 vs Sonnet 5 at 50/50 for the `simple` segment, primary metric `$ld:ai:judge:accuracy` (higher is better), secondaries `ld_autogen__ai-positive-feedback-rate`, `ld_autogen__ai-total-tokens`, `ld_autogen__ai-completion-duration`. Create it in `ld-experiment-setup.js` next to the others (same `POST .../experiments` shape, `type: 'experiment'`). This needs §2.1 fixed first or the primary metric will be empty.

### 6.2 No guarded rollout on a prompt or model change

Show the "safer" story: a guarded rollout of a new `ai-planner` variation (e.g. a prompt tweak) guarded by `ld_autogen__ai-judge-accuracy` and `ld_autogen__ai-completion-error`, auto-rollback on. The traffic conductor already does this for `new-checkout-flow`; add an optional daily `INCIDENT_AI_ENABLED` that rolls out a deliberately bad prompt variation ("always quote a fare") so the accuracy judge trips the rollback. That is a compelling, repeatable moment.

### 6.3 Roster is duplicated between the graph and the supervisor prompt

The supervisor's LD `instructions` hardcode the four specialists ("Available specialists: weather, location, budget, timing"), and `buildPlanPrompt()` appends the roster again from the graph edges. Adding a fifth specialist therefore needs two LD edits and the instructions could contradict the graph. Remove the list from the `ai-planner-agent` instructions and keep only the graph-derived roster in the user prompt. Then the claim in `CLAUDE.md` ("adding a fifth specialist is a graph edit") is true.

### 6.4 Compose targeting rule is "kept in sync by hand"

`ai-planner-agent-compose` mirrors the `complexity` rule of `ai-planner-agent`. Either accept it and document it, or make compose cheaper than plan by design (Sonnet 5 for both simple and complex; the specialists already did the hard work) and drop the rule. The second option is cheaper and removes the sync burden.

### 6.5 `ai-planner-graph` has no targeting

The graph flag has one live variation and no rules. A second variation with a smaller roster (e.g. weather + budget only) targeted at `tier in [silver, beta]` would demonstrate "graph as config" better than any slide, and costs nothing to add.

---

## 7. P1 — Production hardening gaps

- **No input cap.** `express.json()` default is 100 KB and `message` is unbounded. Cap `message` at ~2,000 chars and `conversationHistory` at the last N turns / ~8k tokens in the route; return 413. Also cap `conversationHistory` entries' `content` length.
- **No rate limiting or per-context budget.** Add a per-`context.key` sliding-window limit (e.g. 20 turns / 10 min conversation, 3 / 10 min agent) as an LD JSON flag `ai-planner-limits` so the limits are config. Return 429 with a friendly banner.
- **No cancellation.** A client that navigates away leaves a 60 s Opus fan-out running. Wire `req.on('close')` to an `AbortController` passed into `runNode` tool handlers and the Anthropic client.
- **No total-turn timeout in agent mode.** Per-specialist timeouts exist, but PLAN + COMPOSE have none. Add `AGENT_TURN_TIMEOUT_MS` (default 90 s) around `runAgentTurn()`.
- **Retry/backoff on provider 429/5xx** exists only for param errors. Add one retry with jitter for 429/529/5xx in the three provider wrappers (or rely on the SDK clients' built-in `maxRetries`, set explicitly).
- **PII in LD contexts.** `name` and email `key` are sent to LD as context attributes. Mark `name` private (`privateAttributes: ['name']` in the SDK config) or drop it and rely on `{{user_name}}` from the request only.
- **Prompt injection surface.** The user message is interpolated verbatim into PLAN, every specialist prompt, and COMPOSE. The relevance judge detects but does not block. Minimum: wrap the customer message in explicit delimiters in all three builders and instruct the models that content inside is data. Optionally block (not just report) when relevance fails in agent mode too, since the answer has not been shown yet.
- **Observability spans.** The custom `['*','agent']` handler emits LD metrics but **no OTel `ld.ai.*` spans** (`createHandler` only tags the function; the official handler packages create the spans themselves). The provider `chat()` wrappers also create no spans. LD Observability therefore sees the HTTP span to `api.anthropic.com` (undici auto-instrumentation) but not model/config/tokens. Wrap each handler body in `trace.getTracer('toggle-travel').startActiveSpan('ld.ai.generation', …)` and call the exported `setLdSpanAttributes(span, variables)` / `setUsageSpanAttributes()` / `setModelIdentityAttributes()` so traces and the AI Config Monitoring tab correlate.
- **Cluster-safe state.** Nothing is held in memory between requests; good. Keep it that way when adding rate limits (use the SQLite DB or LD-side limits).

---

## 8. P2 — Code structure and polish

- `routes/aiPlanner.js` is 748 lines. Split into `ai/context.js` (buildContext, buildPromptVariables), `ai/classifier.js`, `ai/judges.js`, `ai/conversation.js`, `ai/agent.js`, and keep the router thin.
- `getGraphMeta()` re-evaluates the graph flag that `resolveGraph()` just evaluated; expose `graphTrackData` from the SDK's `buildGraph` (it is returned internally) or cache the meta from `def`. Minor duplicate evaluation events.
- The 10 s banner poll on `/agent-config` resolves all six graph configs each tick (six evaluation events per client per 10 s). Poll every 30 s, or push changes with a server-side flag listener + SSE.
- `scripts/chat-load.js` still says "non-Diamond → Gemini" and never exercises agent mode. Update the comment; add `--agent` to send a small number of agent turns so the graph Monitoring tab has traffic. The traffic conductor never hits the planner at all; add an opt-in AI tier with a low RPM and a hard daily token budget.
- `DEFAULT_CLASSIFIER_CONFIG` / `DEFAULT_COMPLETION_CONFIG` fall back to Gemini while the live configs are Claude. Change the fallbacks to Haiku 4.5 so an LD outage does not silently switch providers.
- Dev view: show the served `variationKey` and `version` for every config (they are in `trackData` / `_ldMeta`); that is the on-stage proof that LD made the decision.
- `CLAUDE.md` needs updating for whichever routing option is chosen in §1.1, and for the judge changes in §2.

---

## 9. Suggested execution order

1. §1.1 decide routing option; edit `ai-planner` rules in LD; fix dev-view labels and `CLAUDE.md`. (LD + small code)
2. §2.1 emit judge scores in both modes; §2.2 clean up judge attachments; §2.3 pick judge models. (LD + small code)
3. §3.1 create metrics; §3.2 pass full contexts to `getFlag`/`track`; §3.3 anonymous flag. (small code + REST)
4. §5.1, §5.2, §5.4, §5.5 agent-mode cost fixes. (code + LD tool version)
5. §4.1 migrate conversation mode to `@launchdarkly/ai-server`; §4.3 streaming. (large code, own commit)
6. §6.1 experiment, §6.2 guarded rollout on an AI Config, §6.5 second graph variation. (LD via setup script)
7. §7 hardening; §8 structure.

Each step is independently shippable and demoable.
