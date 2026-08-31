#!/bin/bash
# =============================================================================
# Toggle Travel — EC2 Bootstrap (sentry branch)
# =============================================================================
# Run ONCE on a fresh Amazon Linux 2023 instance:
#
#   curl -fsSL https://raw.githubusercontent.com/bobby-digital-insanity/toggleTravel/sentry/deployment/setup-ec2.sh \
#     | sudo bash
#
# After this, .github/workflows/deploy-sentry.yml handles every subsequent
# deploy. That workflow is an UPDATE mechanism — it assumes this script has
# already run (it does `cd /var/www/toggle-travel && git pull` and calls
# nginx/pm2/npm), so running it against a bare instance fails immediately.
#
# Two things this script must get exactly right, because the deploy workflow
# connects as ec2-user and inherits none of root's environment:
#
#   1. Node comes from NodeSource, installed globally at /usr/bin/node — NOT
#      from nvm. An earlier version of this script installed nvm under `sudo`,
#      which lands in /root/.nvm and is invisible to ec2-user, so every
#      subsequent `npm`/`pm2` call in the deploy failed.
#   2. Everything ec2-user has to write — the checkout, logs, the SQLite dir —
#      is chowned to ec2-user. A root-owned checkout makes `git pull` fail.
#
# Prerequisites: security group inbound 22 (reachable from GitHub Actions
# runners, i.e. 0.0.0.0/0), 80, and 443.
# =============================================================================

set -euo pipefail

REPO_URL="https://github.com/bobby-digital-insanity/toggleTravel.git"
BRANCH="${BRANCH:-sentry}"
APP_USER="ec2-user"
APP_DIR="/var/www/toggle-travel"
LOG_DIR="/var/log/toggle-travel"
DATA_DIR="/var/lib/toggle-travel"

echo "==> Toggle Travel bootstrap — branch '$BRANCH'"

# ── 1. System packages ────────────────────────────────────────────────────────
# gcc-c++/make/python3 are required to build better-sqlite3 (a native module).
echo "==> Installing system packages"
dnf update -y
dnf install -y git nginx gcc-c++ make python3

# ── 2. Node.js 20 (global, via NodeSource) ────────────────────────────────────
# Global install so both root and ec2-user resolve node/npm from /usr/bin, which
# is what the deploy workflow's PATH expects.
echo "==> Installing Node.js 20"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs
fi
echo "    node $(node --version), npm $(npm --version)"

# ── 3. PM2 ────────────────────────────────────────────────────────────────────
echo "==> Installing PM2"
npm install -g pm2

# ── 4. Directories ────────────────────────────────────────────────────────────
echo "==> Creating directories"
mkdir -p "$APP_DIR" "$LOG_DIR" "$DATA_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR" "$DATA_DIR"

# ── 5. Clone the branch as ec2-user ───────────────────────────────────────────
echo "==> Cloning $BRANCH"
if [ -d "$APP_DIR/.git" ]; then
  echo "    already a git checkout — fetching instead"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# ── 6. Dependencies ───────────────────────────────────────────────────────────
echo "==> Installing npm dependencies"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

echo "==> Installing Playwright browsers (load generator + traffic conductor)"
sudo -u "$APP_USER" npx playwright install chromium firefox webkit || \
  echo "    WARNING: Playwright install failed — the traffic conductor will error until it succeeds"

# ── 7. Environment file ───────────────────────────────────────────────────────
# The deploy workflow injects the real secrets into .env on every deploy. This
# just guarantees the file exists with sane non-secret defaults, and that
# ec2-user owns it (the workflow appends to it as ec2-user).
echo "==> Seeding .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<ENVEOF
NODE_ENV=production
PORT=3000
DB_PATH=$DATA_DIR/toggle.db
LD_PROJECT_KEY=ToggleTravel
LD_ENV_KEY=sentry
SENTRY_ENVIRONMENT=production
ENVEOF
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
echo "    (secrets are injected by the deploy workflow, not here)"

# ── 8. Nginx ──────────────────────────────────────────────────────────────────
# HTTP-only config to start. The deploy workflow switches to nginx-tls.conf
# automatically once a Let's Encrypt cert exists for the domain — referencing a
# cert that isn't there yet would fail `nginx -t` and abort the reload.
echo "==> Configuring Nginx (HTTP-only until a cert exists)"
cp "$APP_DIR/deployment/nginx.conf" /etc/nginx/conf.d/toggle-travel.conf
nginx -t
systemctl enable nginx
systemctl restart nginx

# ── 9. Start the app under PM2 as ec2-user ────────────────────────────────────
echo "==> Starting app under PM2"
cd "$APP_DIR"
sudo -u "$APP_USER" pm2 start deployment/ecosystem.config.js --env production
sudo -u "$APP_USER" pm2 save

echo "==> Enabling PM2 on boot"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -1 | bash || \
  echo "    WARNING: pm2 startup failed — the app will not survive a reboot"

# ── 10. Verify ────────────────────────────────────────────────────────────────
echo "==> Waiting for the app to come up"
sleep 6
for i in 1 2 3 4 5; do
  STATUS=$(curl -so /dev/null -w "%{http_code}" http://localhost:3000/health || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo ""
    echo "✅ Bootstrap complete — app healthy on port 3000"
    echo ""
    echo "Next steps:"
    echo "  1. Re-run the GitHub Actions deploy to inject the real LD/Sentry secrets"
    echo "  2. Point Route 53 at this instance, then:"
    echo "       sudo certbot certonly --nginx -d toggletravel-sentry.launchdarklydemos.com"
    echo "  3. Re-run the deploy — it will detect the cert and switch to TLS"
    exit 0
  fi
  echo "    attempt $i: HTTP $STATUS — waiting 3s"
  sleep 3
done

echo ""
echo "❌ App did not become healthy. Recent logs:"
sudo -u "$APP_USER" pm2 logs toggle-travel --lines 40 --nostream || true
exit 1
