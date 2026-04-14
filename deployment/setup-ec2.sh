#!/bin/bash
# Toggle Travel — EC2 Bootstrap Script
# Run as: sudo bash setup-ec2.sh
# Tested on Amazon Linux 2023

set -euo pipefail

APP_DIR="/var/www/toggle-travel"
LOG_DIR="/var/log/toggle-travel"
REPO_URL="https://github.com/your-org/toggleTravel.git"  # Update this

echo "==> Updating system packages"
dnf update -y

echo "==> Installing dependencies"
dnf install -y git nginx

echo "==> Installing Node.js via nvm"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 20
nvm use 20
nvm alias default 20

echo "==> Installing PM2 globally"
npm install -g pm2

echo "==> Creating app directories"
mkdir -p "$APP_DIR" "$LOG_DIR"

echo "==> Cloning repository"
git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

echo "==> Installing npm dependencies"
npm install --omit=dev

echo "==> Setting up environment"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "WARNING: .env file not found!"
  echo "Copy .env.example to .env and fill in your values:"
  echo "  cp $APP_DIR/.env.example $APP_DIR/.env"
  echo "  nano $APP_DIR/.env"
fi

echo "==> Configuring Nginx"
cp "$APP_DIR/deployment/nginx.conf" /etc/nginx/conf.d/toggle-travel.conf
nginx -t
systemctl enable nginx
systemctl start nginx

echo "==> Starting app with PM2"
cd "$APP_DIR"
pm2 start deployment/ecosystem.config.js --env production
pm2 save

echo "==> Configuring PM2 startup on reboot"
env PATH=$PATH:$(which node) pm2 startup systemd -u ec2-user --hp /home/ec2-user
pm2 save

echo ""
echo "✅ Toggle Travel deployed successfully!"
echo ""
echo "Next steps:"
echo "  1. Edit /var/www/toggle-travel/.env with your ANTHROPIC_API_KEY (and any vendor SDK keys)"
echo "  2. Restart: pm2 restart toggle-travel"
echo "  3. Visit http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)"
echo ""
echo "Useful commands:"
echo "  pm2 status           - Check app status"
echo "  pm2 logs             - Stream logs"
echo "  pm2 restart toggle-travel --update-env  - Reload with new env vars"
