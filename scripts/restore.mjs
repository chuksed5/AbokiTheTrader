#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Aboki Data Restore
// Pulls a backup zip from S3 and restores data/ from it.
//
// Usage:
//   node scripts/restore.mjs                  ← lists available backups
//   node scripts/restore.mjs <s3-key>         ← restores that specific backup
//   node scripts/restore.mjs --latest         ← restores the most recent backup
// ─────────────────────────────────────────────────────────────

import { execSync } from "child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

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

const {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION = "us-east-1",
  BACKUP_S3_BUCKET,
} = process.env;

if (!BACKUP_S3_BUCKET || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  console.error("Missing S3 credentials or BACKUP_S3_BUCKET in .env — cannot restore from S3");
  process.exit(1);
}

const client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

async function listBackups() {
  const res = await client.send(new ListObjectsV2Command({
    Bucket: BACKUP_S3_BUCKET,
    Prefix: "aboki-backups/",
  }));
  return (res.Contents || [])
    .filter(o => o.Key.endsWith(".zip"))
    .sort((a, b) => b.LastModified - a.LastModified);
}

async function downloadAndRestore(s3Key) {
  console.log(`\nDownloading s3://${BACKUP_S3_BUCKET}/${s3Key} ...`);
  const res = await client.send(new GetObjectCommand({
    Bucket: BACKUP_S3_BUCKET,
    Key: s3Key,
  }));

  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  const tmpZip = join(ROOT, "backups", "_restore_tmp.zip");
  mkdirSync(join(ROOT, "backups"), { recursive: true });
  writeFileSync(tmpZip, buffer);
  console.log(`Downloaded: ${(buffer.length / 1024).toFixed(1)} KB`);

  // Confirm before overwriting
  console.log(`\n⚠️  This will OVERWRITE your current data/ folder.`);
  console.log(`   Stop the Aboki agent FIRST if it's running (pm2 stop all).\n`);
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmed = await new Promise(res => rl.question("Type YES to confirm restore: ", ans => { rl.close(); res(ans.trim()); }));
  if (confirmed !== "YES") {
    console.log("Restore cancelled.");
    process.exit(0);
  }

  console.log("Restoring data/ ...");
  execSync(`unzip -o "${tmpZip}" "data/*" -d "${ROOT}"`, { stdio: "inherit" });
  console.log("\n✅ Restore complete. You can restart the agent now.");
}

async function main() {
  const args = process.argv.slice(2);
  const backups = await listBackups();

  if (!args.length) {
    // List mode
    if (!backups.length) {
      console.log("No backups found in S3.");
      return;
    }
    console.log(`\nAvailable backups in s3://${BACKUP_S3_BUCKET}/aboki-backups/:\n`);
    backups.forEach((b, i) => {
      const age = Math.round((Date.now() - b.LastModified) / (1000 * 60 * 60));
      console.log(`  [${i + 1}] ${b.Key}  (${(b.Size / 1024).toFixed(1)} KB, ${age}h ago)`);
    });
    console.log(`\nTo restore: node scripts/restore.mjs <s3-key>`);
    console.log(`Latest:     node scripts/restore.mjs --latest\n`);
    return;
  }

  const s3Key = args[0] === "--latest"
    ? backups[0]?.Key
    : args[0].startsWith("aboki-backups/") ? args[0] : `aboki-backups/${args[0]}`;

  if (!s3Key) { console.error("No backups available."); process.exit(1); }
  await downloadAndRestore(s3Key);
}

main().catch(e => { console.error("Restore error:", e.message); process.exit(1); });
