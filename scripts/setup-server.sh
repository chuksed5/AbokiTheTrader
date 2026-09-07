#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Aboki Server Setup Script
# Run this ONCE after deploying to AWS Lightsail.
# Sets up: pm2, cron jobs (backup + weekly backtest), log rotation.
#
# Usage:
#   chmod +x scripts/setup-server.sh
#   ./scripts/setup-server.sh
# ─────────────────────────────────────────────────────────────

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Aboki Server Setup"
echo "   Root: $ROOT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Prerequisites ──
echo "Checking prerequisites..."
node --version > /dev/null 2>&1 || fail "Node.js not found. Run: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
ok "Node.js $(node --version)"
zip --version > /dev/null 2>&1 || { warn "Installing zip..."; sudo apt-get install -y zip > /dev/null; }
ok "zip available"
curl --version > /dev/null 2>&1 || fail "curl not found"
ok "curl available"

# ── 2. Install dependencies ──
echo ""
echo "Installing dependencies..."
cd "$ROOT"
if command -v pnpm &> /dev/null; then
  NODE_OPTIONS="--max-old-space-size=1024" pnpm install --no-optional 2>&1 | tail -5
else
  NODE_OPTIONS="--max-old-space-size=1024" npm install --legacy-peer-deps 2>&1 | tail -5
fi
ok "Dependencies installed"

# ── 3. Check .env ──
echo ""
echo "Checking .env..."
if [ ! -f "$ROOT/.env" ]; then
  fail ".env file not found — copy .env.example and fill it in: cp .env.example .env && nano .env"
fi

required=("TELEGRAM_BOT_TOKEN" "TELEGRAM_CHAT_ID" "HELIUS_API_KEY" "GROQ_API_KEY")
missing=()
for var in "${required[@]}"; do
  grep -q "^${var}=." "$ROOT/.env" 2>/dev/null || missing+=("$var")
done
[ ${#missing[@]} -gt 0 ] && warn "Missing in .env: ${missing[*]}" || ok ".env looks good"

# Check S3 specifically — optional, but flagged clearly since backups
# still work without it (they just stay local + go to Telegram, no S3 upload)
if ! grep -q "^BACKUP_S3_BUCKET=." "$ROOT/.env" 2>/dev/null || ! grep -q "^AWS_ACCESS_KEY_ID=." "$ROOT/.env" 2>/dev/null; then
  warn "S3 backup vars (BACKUP_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) not set"
  warn "Backups will still zip locally and send to Telegram — just no S3 upload"
else
  ok "S3 backup vars present"
fi

# ── 4. Create directories ──
echo ""
mkdir -p "$ROOT/data" "$ROOT/backups" "$ROOT/logs"
ok "data/, backups/, logs/ ready"

# ── 5. pm2 ──
echo ""
echo "Setting up pm2..."
sudo npm install -g pm2 2>/dev/null | tail -2
ok "pm2 $(pm2 --version)"

if [ ! -f "$ROOT/ecosystem.config.cjs" ]; then
  cat > "$ROOT/ecosystem.config.cjs" << 'ECOSYSTEM'
module.exports = {
  apps: [{
    name: "aboki",
    script: "src/index.ts",
    interpreter: "node_modules/.bin/tsx",
    cwd: __dirname,
    watch: false,
    autorestart: true,
    max_restarts: 20,
    min_uptime: "10s",
    restart_delay: 5000,
    env: { NODE_ENV: "production" },
    error_file: "logs/aboki-error.log",
    out_file: "logs/aboki-out.log",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }],
};
ECOSYSTEM
  ok "Created ecosystem.config.cjs"
fi

pm2 startup 2>/dev/null | grep "sudo" | bash 2>/dev/null || warn "Run 'pm2 startup' manually and follow instructions"
ok "pm2 startup configured"

# ── 6. Cron jobs ──
echo ""
echo "Installing cron jobs..."

# Every 6h backup
BACKUP_CRON="0 */6 * * * cd \"$ROOT\" && node scripts/backup.mjs >> logs/backup.log 2>&1"
# Every Sunday 3am — auto-backtest, auto-apply score changes, Telegram report
BACKTEST_CRON="0 3 * * 0 cd \"$ROOT\" && node scripts/backtest.mjs >> logs/backtest.log 2>&1"

CRONTAB=$(crontab -l 2>/dev/null || echo "")

if echo "$CRONTAB" | grep -q "backup.mjs"; then
  warn "Backup cron already installed"
else
  (echo "$CRONTAB"; echo "$BACKUP_CRON") | crontab -
  ok "Backup cron installed (every 6 hours)"
fi

if echo "$CRONTAB" | grep -q "backtest.mjs"; then
  warn "Backtest cron already installed"
else
  (crontab -l 2>/dev/null; echo "$BACKTEST_CRON") | crontab -
  ok "Backtest cron installed (every Sunday 3am UTC)"
fi

# ── 6b. Smoke test the backup script ──
# Confirms backup.mjs actually runs end-to-end before you walk away and
# trust the 6h cron to have your back.
echo ""
echo "Running backup smoke test..."

if [ ! "$(ls -A "$ROOT/data" 2>/dev/null)" ]; then
  echo '{"test": true, "note": "dummy file for smoke test"}' > "$ROOT/data/.smoke-test.json"
  CREATED_DUMMY=true
fi

if node "$ROOT/scripts/backup.mjs"; then
  ok "Backup smoke test passed"
else
  warn "Backup smoke test failed — check logs/backup.log for details"
fi

if [ "${CREATED_DUMMY}" = "true" ]; then
  rm -f "$ROOT/data/.smoke-test.json"
fi

# ── 7. Log rotation ──
echo ""
if command -v logrotate &> /dev/null; then
  sudo tee /etc/logrotate.d/aboki > /dev/null << LOGROTATE
$ROOT/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
LOGROTATE
  ok "Log rotation configured (7 days)"
else
  warn "logrotate not available"
fi

# ── 8. Summary ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}   Setup complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Start Aboki:"
echo "  pm2 start ecosystem.config.cjs"
echo "  pm2 save"
echo "  pm2 logs aboki"
echo ""
echo "Manual commands:"
echo "  node scripts/backup.mjs              ← run backup now"
echo "  node scripts/backtest.mjs            ← run backtest + apply changes"
echo "  node scripts/backtest.mjs --dry-run  ← preview without applying"
echo "  node scripts/restore.mjs             ← list S3 backups"
echo "  node scripts/restore.mjs --latest    ← restore most recent backup"
echo ""
echo "Cron schedule:"
echo "  Every 6h   → backup to S3 + Telegram"
echo "  Every Sunday 3am → backtest, auto-apply scores, Telegram report"
echo ""
