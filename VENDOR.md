# Grafana Labs — Toggle Travel

This branch is instrumented with the **Grafana stack**: **Grafana Alloy** (the unified agent) on the EC2 collects logs, metrics, and traces, shipping them to **Loki** (logs), **Tempo** (traces), and **Prometheus/Mimir** (metrics) — all viewable in a single Grafana dashboard.

## What Was Changed vs `main`

- `public/js/nav.js` — injects the Grafana Labs badge into the nav bar
- OpenTelemetry SDK integration (see setup below)

## Grafana Alloy Installation (EC2)

Follow the official Grafana Alloy install for Amazon Linux:

```bash
# Add the Grafana repo and install Alloy
curl -s https://packages.grafana.com/gpg.key | sudo rpm --import -
sudo tee /etc/yum.repos.d/grafana.repo <<EOF
[grafana]
name=grafana
baseurl=https://packages.grafana.com/oss/rpm
repo_gpgcheck=1
enabled=1
gpgcheck=1
gpgkey=https://packages.grafana.com/gpg.key
EOF
sudo dnf install -y alloy
sudo systemctl enable alloy && sudo systemctl start alloy
```

Configure `/etc/alloy/config.alloy` to collect the PM2 log files and ship to your Grafana Cloud endpoint (or self-hosted Loki/Tempo).

## OTLP SDK Installation

```bash
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http
```

Create `src/instrumentation.js`:

```javascript
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

const sdk = new NodeSDK({
  serviceName: 'toggle-travel',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

Update `deployment/ecosystem.config.js`:

```javascript
node_args: '--require ./src/instrumentation.js',
```

Add to `.env`:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
OTEL_SERVICE_NAME=toggle-travel
```

Alloy receives on port 4318 and forwards to Tempo.

## Alloy Config (Log Collection)

In `/etc/alloy/config.alloy`, add a log pipeline to ship the Winston JSON logs to Loki:

```hcl
local.file_match "toggle_travel" {
  path_targets = [{"__path__" = "/var/log/toggle-travel/*.log"}]
}

loki.source.file "toggle_travel" {
  targets    = local.file_match.toggle_travel.targets
  forward_to = [loki.write.grafana_cloud.receiver]
}

loki.write "grafana_cloud" {
  endpoint {
    url = "https://logs-prod-<region>.grafana.net/loki/api/v1/push"
    basic_auth {
      username = env("GRAFANA_LOKI_USER")
      password = env("GRAFANA_API_KEY")
    }
  }
}
```

## What to Demo

**Logs (Loki)**
- Open **Explore → Loki** → query `{filename=~"/var/log/toggle-travel/.*"}`
- Parse the JSON: `| json | line_format "{{.message}} — {{.duration_ms}}ms"`
- Filter payment declines: `| json | message="booking_stage" | stage="payment_declined"`
- Trace a user session: `| json | session_id="alex-r1-book"`

**Traces (Tempo)**
- Open **Explore → Tempo** → search by service `toggle-travel`
- The `POST /api/bookings` trace shows the full span tree including `inventory_check` and `payment_authorized` stages
- Use **Trace to logs** integration to jump from a trace span directly into the matching Loki log lines

**Dashboards**
- Create a dashboard using Loki log metrics:
  - `count_over_time({filename=~".*toggle-travel.*"} | json | message="booking_created" [5m])` — bookings/min
  - `count_over_time({filename=~".*toggle-travel.*"} | json | stage="payment_declined" [5m])` — decline rate
  - `avg_over_time({filename=~".*toggle-travel.*"} | json | message="vacation_mode_toggled" | unwrap duration_ms [5m])` — AI latency

**The Grafana Advantage**
- Single pane for logs, traces, and metrics — show jumping from a slow trace → into the log → onto a dashboard showing the broader trend
- Correlations: annotate the dashboard with the seed script run timestamps

## Key Signals to Highlight

| Signal | Tool | Query/Location |
|---|---|---|
| HTTP request rate | Loki → Dashboard | log metric on `http_request` |
| Error rate | Loki | filter `status_code` ≥ 400 |
| Booking conversion | Loki | count `booking_created` |
| Payment decline rate | Loki | count `payment_declined` stage |
| AI latency P95 | Loki | unwrap `duration_ms` on `vacation_mode_toggled` |
| Trace waterfall | Tempo | service `toggle-travel` |
