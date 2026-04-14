#!/bin/bash
# =============================================================================
# Toggle Travel — EC2 UserData Script
# =============================================================================
# HOW TO USE:
#   1. Replace GITHUB_REPO below with your repo (e.g. your-username/toggleTravel)
#   2. Store your secrets in AWS SSM Parameter Store (see SETUP CHECKLIST below)
#   3. Paste this entire script into EC2 → Advanced → User Data at launch time
#
# SETUP CHECKLIST (do these BEFORE launching the EC2):
#   □ SSM Parameter (SecureString): /toggle-travel/anthropic-api-key
#       → Your Anthropic API key (sk-ant-...)
#   □ SSM Parameter (String):       /toggle-travel/otel-endpoint
#       → Your OTLP endpoint, e.g. https://api.honeycomb.io
#         (use "disabled" to skip OTel export)
#   □ SSM Parameter (String):       /toggle-travel/otel-headers
#       → Any auth headers, e.g. x-honeycomb-team=YOUR_KEY
#         (use "none" if not needed)
#   □ EC2 IAM Role attached with policy:
#       ssm:GetParameter on arn:aws:ssm:*:*:parameter/toggle-travel/*
#   □ EC2 Security Group inbound rules:
#       Port 80   — 0.0.0.0/0      (HTTP, public)
#       Port 22   — your IP only   (SSH, for you)
#
# LOGS: tail -f /var/log/toggle-travel-setup.log
# =============================================================================

set -euo pipefail
exec > >(tee /var/log/toggle-travel-setup.log | logger -t toggle-travel-setup) 2>&1

# ── CONFIGURE THESE ──────────────────────────────────────────────────────────
GITHUB_REPO="bobby-digital-insanity/toggleTravel"   # <-- REPLACE THIS
APP_USER="ec2-user"
APP_DIR="/var/www/toggle-travel"
LOG_DIR="/var/log/toggle-travel"
AWS_REGION="us-east-1"   # <-- change if your EC2 is in a different region
# ─────────────────────────────────────────────────────────────────────────────

echo "=========================================="
echo " Toggle Travel — Setup starting"
echo " $(date)"
echo "=========================================="

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/9] Installing system packages..."
dnf update -y
dnf install -y git nginx

# ── 2. Node.js 20 via NodeSource ──────────────────────────────────────────────
echo "[2/9] Installing Node.js 20..."
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs
node --version
npm --version

# ── 3. PM2 ───────────────────────────────────────────────────────────────────
echo "[3/9] Installing PM2..."
npm install -g pm2

# ── 4. App directory ─────────────────────────────────────────────────────────
echo "[4/9] Creating directories..."
mkdir -p "$APP_DIR" "$LOG_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"

# ── 5. Clone repository ───────────────────────────────────────────────────────
echo "[5/9] Cloning https://github.com/$GITHUB_REPO ..."
sudo -u "$APP_USER" git clone "https://github.com/$GITHUB_REPO.git" "$APP_DIR"

# ── 6. Fetch secrets from SSM ─────────────────────────────────────────────────
echo "[6/9] Fetching secrets from SSM Parameter Store..."

get_ssm() {
  aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$1" \
    --with-decryption \
    --query "Parameter.Value" \
    --output text 2>/dev/null || echo "${2:-}"
}

ANTHROPIC_API_KEY=$(get_ssm "/toggle-travel/anthropic-api-key" "REPLACE_ME")
OTEL_ENDPOINT=$(get_ssm "/toggle-travel/otel-endpoint" "disabled")
OTEL_HEADERS=$(get_ssm "/toggle-travel/otel-headers" "none")

# Build the .env file
cat > "$APP_DIR/.env" << EOF
NODE_ENV=production
PORT=3000

# Anthropic AI
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
CLAUDE_MODEL=claude-opus-4-5

# OpenTelemetry
OTEL_SERVICE_NAME=toggle-travel
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.version=1.0.0
EOF

# Only add OTel endpoint if not disabled
if [ "$OTEL_ENDPOINT" != "disabled" ]; then
  echo "OTEL_EXPORTER_OTLP_ENDPOINT=$OTEL_ENDPOINT" >> "$APP_DIR/.env"
fi
if [ "$OTEL_HEADERS" != "none" ]; then
  echo "OTEL_EXPORTER_OTLP_HEADERS=$OTEL_HEADERS" >> "$APP_DIR/.env"
fi

cat >> "$APP_DIR/.env" << 'EOF'

# Demo simulation
SIMULATE_LATENCY_MAX_MS=1200
SIMULATE_PAYMENT_FAILURE_RATE=0.05
EOF

chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "  .env written"

# ── 7. Install npm dependencies ───────────────────────────────────────────────
echo "[7/9] Installing npm dependencies..."
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

# ── 8. Nginx ─────────────────────────────────────────────────────────────────
echo "[8/9] Configuring Nginx..."
cp "$APP_DIR/deployment/nginx.conf" /etc/nginx/conf.d/toggle-travel.conf

# Remove default Nginx welcome page if present
rm -f /etc/nginx/conf.d/default.conf /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t
systemctl enable nginx
systemctl start nginx

# ── 9. Start app with PM2 ────────────────────────────────────────────────────
echo "[9/9] Starting app with PM2..."
cd "$APP_DIR"

# Start using ecosystem config
sudo -u "$APP_USER" pm2 start deployment/ecosystem.config.js --env production

# Configure PM2 to restart on system reboot
env PATH="$PATH:/usr/bin:/usr/local/bin" \
  pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"
sudo -u "$APP_USER" pm2 save

# ── Write deploy script ───────────────────────────────────────────────────────
# This script is called by GitHub Actions on every push to main
cat > /usr/local/bin/deploy-toggle-travel.sh << 'DEPLOY'
#!/bin/bash
set -euo pipefail
APP_DIR="/var/www/toggle-travel"
APP_USER="ec2-user"

echo "[deploy] Starting deploy at $(date)"

cd "$APP_DIR"

# Pull latest code
sudo -u "$APP_USER" git pull origin main

# Install any new/updated dependencies
sudo -u "$APP_USER" npm install --omit=dev

# Reload app without downtime (PM2 cluster reload)
sudo -u "$APP_USER" pm2 reload toggle-travel --update-env

echo "[deploy] Done at $(date)"
DEPLOY

chmod +x /usr/local/bin/deploy-toggle-travel.sh

# ── Health check ─────────────────────────────────────────────────────────────
echo ""
echo "Waiting 5 seconds for app to start..."
sleep 5

HTTP_STATUS=$(curl -so /dev/null -w "%{http_code}" http://localhost/health || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ Health check passed (HTTP $HTTP_STATUS)"
else
  echo "⚠  Health check returned HTTP $HTTP_STATUS — check logs:"
  echo "   sudo -u ec2-user pm2 logs toggle-travel --lines 30"
fi

PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 || echo "unknown")
echo ""
echo "=========================================="
echo " Toggle Travel is running!"
echo " http://$PUBLIC_IP"
echo ""
echo " Useful commands (SSH in as ec2-user):"
echo "   pm2 status"
echo "   pm2 logs toggle-travel"
echo "   pm2 restart toggle-travel --update-env"
echo "   cat /var/log/toggle-travel-setup.log"
echo "=========================================="
