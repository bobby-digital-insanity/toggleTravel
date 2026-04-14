# Datadog — Toggle Travel

This branch is instrumented with **Datadog APM** using the `dd-trace` Node.js tracer alongside the **Datadog Agent** on the EC2. This is a hybrid approach: the agent handles infrastructure metrics and log collection, while `dd-trace` adds distributed tracing and custom spans.

## What Was Changed vs `main`

- `public/js/nav.js` — injects the Datadog badge into the nav bar
- `dd-trace` initialization (see setup below)

## Agent Installation (EC2)

```bash
DD_API_KEY=<your-api-key> DD_SITE="datadoghq.com" bash -c "$(curl -L https://s3.amazonaws.com/dd-agent/scripts/install_script_agent7.sh)"
```

Configure log collection in `/etc/datadog-agent/datadog.yaml`:

```yaml
logs_enabled: true
```

Add a log config at `/etc/datadog-agent/conf.d/toggle-travel.d/conf.yaml`:

```yaml
logs:
  - type: file
    path: /var/log/toggle-travel/out-*.log
    service: toggle-travel
    source: nodejs
```

## SDK Installation (dd-trace)

```bash
npm install dd-trace
```

Add to the top of `src/server.js` — must be the very first line:

```javascript
require('dd-trace').init({
  service: 'toggle-travel',
  env: process.env.NODE_ENV || 'production',
  logInjection: true, // adds trace_id/span_id to Winston logs automatically
});
```

Add to `.env`:

```
DD_API_KEY=your-api-key
DD_SERVICE=toggle-travel
DD_ENV=production
```

Update `deployment/ecosystem.config.js` to pass DD env vars:

```javascript
env_production: {
  NODE_ENV: 'production',
  DD_SERVICE: 'toggle-travel',
  DD_ENV: 'production',
}
```

## What to Demo

**APM — Distributed Traces**
- **APM → Traces** → filter by `service:toggle-travel`
- Drill into a `POST /api/bookings` — shows `inventory_check` and `payment_authorized` stages as child spans (from Winston logs correlated via `logInjection`)
- Show the flame graph for a Vacation Mode call — the outbound call to Anthropic shows as a separate HTTP span

**Log Management**
- **Logs** → filter by `service:toggle-travel`
- Search `@booking_stage.stage:payment_declined` to isolate payment failures
- Search `@session_id:alex-r1-book` to trace a single user's full journey across all log lines
- Show log → trace correlation: click "View in APM" from a log line

**Dashboards**
- Build a dashboard with: requests/min, p95 latency, error rate, AI token usage
- The `vacation_mode_toggled` log event has `input_tokens` and `output_tokens` — create a log-based metric for token spend

**Monitors / Alerts**
- Create a monitor on error rate > 8% (the error spike flow generates 400/404s each round)
- Create a monitor on `payment_declined` count to alert on elevated payment failures

## Key Metrics to Highlight

| Signal | Where to find it |
|---|---|
| Request throughput | APM → Service page |
| P95 latency | APM → Service page |
| Error rate | APM → Service page → Errors tab |
| Payment declines | Logs → `@message:payment_declined` |
| AI token usage | Logs → `@message:vacation_mode_toggled` |
| Session journey | Logs → `@session_id:<value>` |
