#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Aboki Data Backup
// Zips data/, uploads to S3, sends a Telegram report.
// Designed to run as a standalone cron job — completely
// independent of the main agent process, so backups keep
// working even if the agent crashes.
//
// Run manually:  node scripts/backup.mjs
// Cron (every 6h): 0 */6 * * * cd /path/to/AbokiTheTrader && node scripts/backup.mjs >> logs/backup.log 2>&1
// ─────────────────────────────────────────────────────────────

import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Load .env manually (no dotenv dep needed) ──
function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = val;
  }
}
loadEnv();

// ── Config ──
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION = "us-east-1",
  BACKUP_S3_BUCKET,
} = process.env;

const DATA_DIR  = join(ROOT, "data");
const BACKUP_DIR = join(ROOT, "backups");
const MAX_LOCAL_BACKUPS = 3; // keep last 3 zips locally, delete older ones

if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const zipName   = `aboki-data-${timestamp}.zip`;
const zipPath   = join(BACKUP_DIR, zipName);

// ── Helpers ──
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

async function sendTelegram(text, filePath = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

  if (filePath && existsSync(filePath)) {
    const size = statSync(filePath).size;
    // Telegram bot file limit is 50 MB — send file only if under that
    if (size < 50 * 1024 * 1024) {
      const { FormData, Blob } = await import("node:buffer").catch(() => ({}));
      // Use curl for multipart upload (more reliable in cron environments than fetch multipart)
      try {
        execSync(
          `curl -s -X POST "${base}/sendDocument" ` +
          `-F chat_id="${TELEGRAM_CHAT_ID}" ` +
          `-F document=@"${filePath}" ` +
          `-F caption="${text.replace(/"/g, '\\"')}" ` +
          `-F parse_mode="HTML"`,
          { stdio: "pipe" }
        );
        return;
      } catch (e) {
        log(`Telegram file send failed, falling back to text: ${e.message}`);
      }
    }
  }

  // Plain text fallback
  await fetch(`${base}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  }).catch(e => log(`Telegram message failed: ${e.message}`));
}

// ── Step 1: Zip the data/ folder ──
function createZip() {
  if (!existsSync(DATA_DIR)) {
    throw new Error(`data/ directory not found at ${DATA_DIR}`);
  }
  log(`Zipping ${DATA_DIR} → ${zipPath}`);
  execSync(`zip -rq "${zipPath}" . -i "data/*"`, { cwd: ROOT });
  const size = statSync(zipPath).size;
  log(`Zip created: ${formatBytes(size)}`);
  return size;
}

// ── Step 2: Upload to S3 ──
async function uploadToS3(zipSize) {
  if (!BACKUP_S3_BUCKET || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    log("S3 credentials or bucket not configured — skipping S3 upload");
    return { uploaded: false, s3Key: null };
  }

  const client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  // Check bucket is accessible before trying to upload
  try {
    await client.send(new HeadBucketCommand({ Bucket: BACKUP_S3_BUCKET }));
  } catch (e) {
    throw new Error(`Cannot access S3 bucket "${BACKUP_S3_BUCKET}": ${e.message}`);
  }

  const s3Key = `aboki-backups/${zipName}`;
  log(`Uploading to s3://${BACKUP_S3_BUCKET}/${s3Key}`);

  const fileBuffer = readFileSync(zipPath);
  await client.send(new PutObjectCommand({
    Bucket: BACKUP_S3_BUCKET,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: "application/zip",
    Metadata: {
      "backup-timestamp": timestamp,
      "agent": "aboki",
    },
  }));

  log(`S3 upload complete`);
  return { uploaded: true, s3Key };
}

// ── Step 3: Prune old local backups ──
function pruneLocalBackups() {
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("aboki-data-") && f.endsWith(".zip"))
    .map(f => ({ name: f, path: join(BACKUP_DIR, f), mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = files.slice(MAX_LOCAL_BACKUPS);
  for (const f of toDelete) {
    unlinkSync(f.path);
    log(`Pruned old local backup: ${f.name}`);
  }
}

// ── Step 4: Summarise what's inside data/ ──
function dataSummary() {
  if (!existsSync(DATA_DIR)) return "data/ not found";
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
  const lines = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"));
      // Pull meaningful count from known file shapes
      if (Array.isArray(raw)) {
        lines.push(`${f}: ${raw.length} entries`);
      } else if (raw.calls) {
        const active = raw.calls.filter(c => !c.closedAt).length;
        lines.push(`${f}: ${raw.calls.length} calls (${active} active)`);
      } else if (raw.trades) {
        const wins  = raw.trades.filter(t => t.outcome === "WIN").length;
        const losses = raw.trades.filter(t => t.outcome === "LOSS").length;
        lines.push(`${f}: ${raw.trades.length} trades (W:${wins} L:${losses})`);
      } else {
        lines.push(`${f}: ✓`);
      }
    } catch {
      lines.push(`${f}: (unreadable)`);
    }
  }
  return lines.join("\n") || "No JSON files in data/";
}

// ── Main ──
async function main() {
  log("=== Aboki Backup Starting ===");
  const startedAt = Date.now();
  let zipSize = 0;
  let s3Info = { uploaded: false, s3Key: null };
  let error = null;

  try {
    zipSize  = createZip();
    s3Info   = await uploadToS3(zipSize);
    pruneLocalBackups();
  } catch (e) {
    error = e.message;
    log(`ERROR: ${error}`);
  }

  const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary  = dataSummary();

  const status = error ? "❌ FAILED" : "✅ SUCCESS";
  const msg =
    `<b>🗄 Aboki Backup — ${status}</b>\n\n` +
    `<b>Time:</b> ${new Date().toUTCString()}\n` +
    `<b>Duration:</b> ${duration}s\n` +
    `<b>Zip size:</b> ${formatBytes(zipSize)}\n` +
    `<b>S3:</b> ${s3Info.uploaded ? `✅ s3://${BACKUP_S3_BUCKET}/${s3Info.s3Key}` : "⏭ Skipped (no credentials)"}\n` +
    (error ? `<b>Error:</b> ${error}\n` : "") +
    `\n<b>Data snapshot:</b>\n<code>${summary}</code>`;

  // Send zip to Telegram if it's small enough (it usually will be — data/ is pure JSON),
  // otherwise just send the summary text.
  await sendTelegram(msg, error ? null : zipPath);

  log(`=== Aboki Backup ${error ? "FAILED" : "Complete"} in ${duration}s ===`);
  process.exit(error ? 1 : 0);
}

main();
