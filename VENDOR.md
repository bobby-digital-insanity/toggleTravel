# Dynatrace — Toggle Travel

This branch is instrumented with the **Dynatrace OneAgent** — a zero-code-change approach. The OneAgent auto-instruments Node.js, Express, HTTP calls, and Nginx without any modifications to the application source.

## What Was Changed vs `main`

Only `public/js/nav.js` — injects the Dynatrace badge into the nav bar. Zero application code changes.

## OneAgent Installation (EC2)

1. Log into your Dynatrace environment → **Deploy Dynatrace** → **Start installation** → **Linux**
2. Copy the generated `wget` install command and run it on the EC2
3. The agent auto-detects PM2/Node.js and begins instrumenting immediately — no restart required

```bash
# Example (your token and URL will differ)
wget -O Dynatrace-OneAgent.sh "https://<env>.live.dynatrace.com/api/v1/deployment/installer/agent/unix/default/latest?Api-Token=<token>"
sudo sh Dynatrace-OneAgent.sh
```

The agent injects into the running PM2 processes. Allow 2–3 minutes for data to appear.

## What to Demo

**Services & Distributed Traces**
- Navigate to **Applications & Microservices → Services** → find `toggle-travel`
- Click into any `POST /api/bookings` trace — shows the full waterfall including the inventory check and payment authorization sub-calls
- Filter traces by response code to isolate the 5% payment decline errors

**Error Rate**
- Run the seed script to generate traffic: `node scripts/seed-load.js --host http://<EC2-IP> --rounds 5`
- Go to **Services → toggle-travel → Events** — the error spike flow generates 400/404s on every round
- Set up a Davis anomaly alert on error rate to show proactive detection

**AI Inference (Vacation Mode)**
- Toggle Vacation Mode on the site — Dynatrace captures the outbound HTTPS call to `api.anthropic.com`
- Show the external service dependency in the service map
- Response time distribution shows AI latency (typically 2–6s) clearly separated from non-AI requests

**Service Map**
- **Smartscape / Service Map** shows: Browser → Nginx → Node.js → Anthropic API
- The pricing engine timeouts (3%) and payment declines (5%) appear as dependency health degradations

## Key Metrics to Highlight

| Metric | Where to find it |
|---|---|
| Request throughput | Service overview → Requests/min |
| P50/P95/P99 response time | Service overview → Response time |
| Error rate | Service overview → Failure rate |
| AI call latency | External services → api.anthropic.com |
| Top slow requests | Distributed traces → sorted by duration |
