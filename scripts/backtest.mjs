#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Aboki Auto-Backtest Harness
//
// What it does every time it runs:
//   1. Reads all closed calls from data/aboki-calls.json
//   2. Analyses which signals predicted winners vs losers
//   3. Generates score change recommendations
//   4. Auto-applies changes for 5 of 7 tracked features by patching
//      src/config/backtest-scores.ts (imported by aboki-trader.ts and
//      aboki-narrative.ts). Narrative match and high-concentration are
//      analysed and reported but NOT auto-applied — see the NOTE at
//      the bottom of src/config/backtest-scores.ts for why.
//   5. Restarts the agent via pm2 if changes were applied
//   6. Sends a full report to Telegram (including the report-only findings)
//
// Run manually:  node scripts/backtest.mjs
// Auto schedule: added to crontab by scripts/setup-server.sh
//   Every Sunday at 3am: 0 3 * * 0
// ─────────────────────────────────────────────────────────────

import { readFileSync, existsSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, "..");
const CALLS_FILE = join(ROOT, "data", "aboki-calls.json");
// Auto-apply patches ONLY this small shared config file — never the
// plugin files directly. aboki-trader.ts and aboki-narrative.ts both
// import their tunable constants from here (see src/config/backtest-scores.ts
// for why NARRATIVE_BOOST and HIGH_CONCENTRATION_PENALTY are excluded
// from auto-apply — they're still analysed and reported below).
const CONFIG_FILE = join(ROOT, "src", "config", "backtest-scores.ts");
const REPORT_FILE = join(ROOT, "data", "aboki-backtest-report.json");
const HISTORY_FILE = join(ROOT, "data", "aboki-backtest-history.json");

const MIN_CLOSED   = 30;   // don't apply changes below this
const MIN_SAMPLES  = 10;   // min calls with a feature before it's trusted
const MAX_ADJ_STEP = 5;    // max pts to move a score in one weekly cycle
// Safety bounds — auto-apply never moves scores outside these limits
const SCORE_MIN = -25;
const SCORE_MAX = +25;

// ── Load .env ──
function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq === -1) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  });
}
loadEnv();

// ── Feature definitions ──
// Each feature maps to a specific string anchor in aboki-trader.ts
// so the auto-apply can find and patch the exact score value.
const FEATURES = [
  {
    name: "High vol at entry (could be late)",
    key: "highVol",
    extract: c => c.reason?.includes("could be late") ?? false,
    direction: "lower_is_better",
    scoreVarName: "HIGH_VOL_PENALTY",
    autoApply: true,
  },
  {
    name: "Parabolic price at entry",
    key: "parabolic",
    extract: c => c.reason?.includes("parabolic — likely late") ?? false,
    direction: "lower_is_better",
    scoreVarName: "PARABOLIC_PENALTY",
    autoApply: true,
  },
  {
    name: "Dumping at entry",
    key: "dumping",
    extract: c => c.reason?.includes("dumping") ?? false,
    direction: "lower_is_better",
    scoreVarName: "DUMPING_PENALTY",
    autoApply: true,
  },
  {
    name: "Oversaturated ticker",
    key: "oversaturated",
    extract: c => c.reason?.includes("oversaturated rerun") ?? false,
    direction: "lower_is_better",
    scoreVarName: "OVERSATURATED_PENALTY",
    autoApply: true,
  },
  {
    name: "Community signals",
    key: "community",
    extract: c => c.reason?.includes("community signals") ?? false,
    direction: "higher_is_better",
    scoreVarName: "COMMUNITY_BOOST",
    autoApply: true,
  },
  {
    name: "Narrative match",
    key: "narrative",
    extract: c => c.reason?.includes("Narrative match") ?? false,
    direction: "higher_is_better",
    scoreVarName: "NARRATIVE_BOOST",
    // NOT auto-applied — narrative boost is a formula in aboki-narrative.ts
    // (avgStrength-scaled, capped at 25), not a flat constant. Reported only.
    autoApply: false,
  },
  {
    name: "High entry top holder (>15%)",
    key: "highConcentration",
    extract: c => (c.entryTopHolderPct ?? 0) > 15,
    direction: "lower_is_better",
    scoreVarName: "HIGH_CONCENTRATION_PENALTY",
    // NOT auto-applied — concentration data isn't fetched until after a
    // token already clears the buy threshold, so there's nothing to
    // subtract from yet. Reported only.
    autoApply: false,
  },
];

// ── Load calls ──
function loadCalls() {
  if (!existsSync(CALLS_FILE)) throw new Error(`${CALLS_FILE} not found`);
  const data = JSON.parse(readFileSync(CALLS_FILE, "utf8"));
  return (data.calls || []).filter(c => c.id && c.closedAt && c.calledMC > 0);
}

// ── Load current score values from src/config/backtest-scores.ts ──
// Reads the BACKTEST_SCORES block inside the shared config file.
function loadCurrentScores() {
  if (!existsSync(CONFIG_FILE)) return {};
  const code = readFileSync(CONFIG_FILE, "utf8");
  const match = code.match(/\/\/ BACKTEST_SCORES_START([\s\S]*?)\/\/ BACKTEST_SCORES_END/);
  if (!match) return {};
  const scores = {};
  match[1].split("\n").forEach(line => {
    const m = line.match(/export const\s+([\w_]+)\s*=\s*(-?\d+)/);
    if (m) scores[m[1]] = parseInt(m[2]);
  });
  return scores;
}

// ── Load current combo-veto state from src/config/backtest-scores.ts ──
function loadCurrentComboVeto() {
  if (!existsSync(CONFIG_FILE)) return false;
  const code = readFileSync(CONFIG_FILE, "utf8");
  const m = code.match(/export const HARD_VETO_HIGH_VOL_PARABOLIC\s*=\s*(true|false)/);
  return m ? m[1] === "true" : false;
}

// ── Analyse calls ──
function analyse(calls) {
  const WIN = 2;
  const winners = calls.filter(c => c.peakMultiple >= WIN);
  const losers  = calls.filter(c => c.peakMultiple < WIN);
  const hr = (w, l) => (w + l) > 0 ? Math.round((w / (w + l)) * 100) : null;
  const avg = (arr, fn) => arr.length ? (arr.reduce((s,x)=>s+fn(x),0)/arr.length).toFixed(1) : null;

  const currentScores = loadCurrentScores();

  const features = FEATURES.map(f => {
    const wY = winners.filter(c => f.extract(c)).length;
    const lY = losers.filter(c => f.extract(c)).length;
    const wN = winners.filter(c => !f.extract(c)).length;
    const lN = losers.filter(c => !f.extract(c)).length;
    const rateWith    = hr(wY, lY);
    const rateWithout = hr(wN, lN);
    const impact = (rateWith !== null && rateWithout !== null) ? rateWith - rateWithout : null;
    const sampleCount = wY + lY;
    const currentScore = currentScores[f.scoreVarName] ?? 0;

    let recommendation = null;
    if (f.autoApply && impact !== null && sampleCount >= MIN_SAMPLES) {
      if (f.direction === "lower_is_better") {
        if (impact > 10) {
          // Feature is actually positive — reduce penalty or flip to bonus
          const suggested = Math.min(currentScore + MAX_ADJ_STEP, SCORE_MAX);
          if (suggested !== currentScore) recommendation = { action: "REDUCE_PENALTY", suggestedScore: suggested };
        } else if (impact < -10) {
          // Feature is clearly negative — increase penalty
          const suggested = Math.max(currentScore - MAX_ADJ_STEP, SCORE_MIN);
          if (suggested !== currentScore) recommendation = { action: "INCREASE_PENALTY", suggestedScore: suggested };
        }
      } else {
        if (impact < -10 && currentScore > 0) {
          const suggested = Math.max(currentScore - MAX_ADJ_STEP, 0);
          if (suggested !== currentScore) recommendation = { action: "REDUCE_BONUS", suggestedScore: suggested };
        } else if (impact > 10 && currentScore < SCORE_MAX) {
          const suggested = Math.min(currentScore + MAX_ADJ_STEP, SCORE_MAX);
          if (suggested !== currentScore) recommendation = { action: "INCREASE_BONUS", suggestedScore: suggested };
        }
      }
    }

    return {
      name: f.name, key: f.key, scoreVarName: f.scoreVarName,
      currentScore,
      withFeature: { wins: wY, losses: lY, hitRate: rateWith },
      withoutFeature: { wins: wN, losses: lN, hitRate: rateWithout },
      impact, sampleCount,
      significant: Math.abs(impact ?? 0) > 10 && sampleCount >= MIN_SAMPLES,
      recommendation,
    };
  });

  // Concentration veto
  const withConc = calls.filter(c => c.entryTopHolderPct > 0);
  const concVeto = {
    over20: {
      n: withConc.filter(c => c.entryTopHolderPct > 20).length,
      winRate: hr(
        withConc.filter(c => c.entryTopHolderPct > 20 && c.peakMultiple >= WIN).length,
        withConc.filter(c => c.entryTopHolderPct > 20 && c.peakMultiple < WIN).length
      ),
    },
  };

  // Combined high-vol + parabolic hard veto. This is a binary block, not
  // a graduated score nudge, so it needs a much higher evidence bar than
  // MIN_SAMPLES (10) before it's ever turned on — a wrong veto silently
  // costs you real opportunities every week it stays on. Re-evaluated
  // fresh every run: if the data no longer supports it, it turns back off.
  const COMBO_VETO_MIN_SAMPLES = 25;
  const COMBO_VETO_MAX_WINRATE = 5; // percent
  const comboHit = c =>
    c.reason?.includes("could be late") && c.reason?.includes("parabolic — likely late");
  const comboWinners = winners.filter(comboHit).length;
  const comboLosers  = losers.filter(comboHit).length;
  const comboSamples = comboWinners + comboLosers;
  const comboWinRate = hr(comboWinners, comboLosers);
  const comboVetoRecommended =
    comboSamples >= COMBO_VETO_MIN_SAMPLES &&
    comboWinRate !== null &&
    comboWinRate <= COMBO_VETO_MAX_WINRATE;
  const comboVeto = {
    scoreVarName: "HARD_VETO_HIGH_VOL_PARABOLIC",
    sampleCount: comboSamples,
    winRate: comboWinRate,
    minSamplesRequired: COMBO_VETO_MIN_SAMPLES,
    maxWinRateAllowed: COMBO_VETO_MAX_WINRATE,
    currentState: loadCurrentComboVeto(),
    recommendedState: comboVetoRecommended,
  };

  return {
    summary: {
      totalClosed: calls.length,
      winners: winners.length,
      losers: losers.length,
      overallHitRate: hr(winners.length, losers.length),
      avgWinnerPeak: avg(winners, c => c.peakMultiple),
      topCalls: [...winners].sort((a,b)=>b.peakMultiple-a.peakMultiple).slice(0,5)
        .map(c => ({ symbol: c.symbol, peak: c.peakMultiple, confidence: c.confidence, calledMC: c.calledMC })),
    },
    features,
    concentrationVeto: concVeto,
    comboVeto,
    generatedAt: new Date().toISOString(),
  };
}

// ── Auto-apply score changes to src/config/backtest-scores.ts ──
// Only ever writes the small shared config file — never the plugin
// files that import it. aboki-trader.ts and aboki-narrative.ts read
// these constants at import time, so a pm2 restart is required
// afterwards for a new value to take effect (handled by restartAgent()).
function applyScoreChanges(report) {
  const changes = report.features.filter(f => f.recommendation && f.autoApply);
  const comboChanged = report.comboVeto.recommendedState !== report.comboVeto.currentState;

  if (changes.length === 0 && !comboChanged) return [];

  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`${CONFIG_FILE} not found — did the backtest-scores.ts refactor ship?`);
  }

  let code = readFileSync(CONFIG_FILE, "utf8");
  const applied = [];

  if (!code.includes("// BACKTEST_SCORES_START")) {
    throw new Error(`${CONFIG_FILE} is missing the BACKTEST_SCORES_START/END markers — cannot safely auto-apply`);
  }

  const currentScores = loadCurrentScores();
  const allScores = { ...currentScores };

  changes.forEach(f => {
    allScores[f.scoreVarName] = f.recommendation.suggestedScore;
    applied.push({
      name: f.name,
      from: f.currentScore,
      to: f.recommendation.suggestedScore,
      action: f.recommendation.action,
      impact: f.impact,
      samples: f.sampleCount,
    });
  });

  // Only write score vars that are actually meant to live in this file
  // (i.e. the auto-applied ones) — NARRATIVE_BOOST and
  // HIGH_CONCENTRATION_PENALTY never get a line here since nothing
  // reads them as flat constants.
  const scoreLines = FEATURES
    .filter(f => f.autoApply && f.scoreVarName && allScores[f.scoreVarName] !== undefined)
    .map(f => `export const ${f.scoreVarName} = ${allScores[f.scoreVarName]}; // ${f.name}`)
    .join("\n");

  const newBlock =
    `// BACKTEST_SCORES_START — auto-updated by scripts/backtest.mjs\n` +
    `// Last run: ${new Date().toISOString()} | Closed calls: ${report.summary.totalClosed}\n` +
    scoreLines + "\n" +
    `// BACKTEST_SCORES_END`;

  code = code.replace(
    /\/\/ BACKTEST_SCORES_START[\s\S]*?\/\/ BACKTEST_SCORES_END/,
    newBlock
  );

  if (comboChanged) {
    const cv = report.comboVeto;
    const newComboBlock =
      `// BACKTEST_COMBO_VETO_START — auto-updated by scripts/backtest.mjs\n` +
      `// Requires >= ${cv.minSamplesRequired} combo samples and <= ${cv.maxWinRateAllowed}% win rate.\n` +
      `// Last run: ${new Date().toISOString()} | Combo samples: ${cv.sampleCount} | Combo win rate: ${cv.winRate ?? "N/A"}%\n` +
      `export const HARD_VETO_HIGH_VOL_PARABOLIC = ${cv.recommendedState};\n` +
      `// BACKTEST_COMBO_VETO_END`;

    code = code.replace(
      /\/\/ BACKTEST_COMBO_VETO_START[\s\S]*?\/\/ BACKTEST_COMBO_VETO_END/,
      newComboBlock
    );

    applied.push({
      name: "High-vol + parabolic combo veto",
      from: cv.currentState,
      to: cv.recommendedState,
      action: cv.recommendedState ? "ENABLE_VETO" : "DISABLE_VETO",
      impact: cv.winRate,
      samples: cv.sampleCount,
    });
  }

  writeFileSync(CONFIG_FILE, code);
  return applied;
}

// ── Save history ──
function saveHistory(report, applied) {
  let history = [];
  if (existsSync(HISTORY_FILE)) {
    history = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
  }
  history.push({
    date: report.generatedAt,
    closedCalls: report.summary.totalClosed,
    hitRate: report.summary.overallHitRate,
    changesApplied: applied,
  });
  // Keep last 52 entries (1 year of weekly runs)
  if (history.length > 52) history = history.slice(-52);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ── Restart agent ──
function restartAgent() {
  try {
    execSync("pm2 restart aboki", { stdio: "pipe" });
    console.log("✅ Agent restarted via pm2");
    return true;
  } catch (e) {
    console.warn("⚠️ pm2 restart failed:", e.message);
    return false;
  }
}

// ── Send Telegram report ──
async function sendTelegramReport(report, applied, restarted) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const { summary, features, concentrationVeto, comboVeto } = report;
  const sigFeatures = features.filter(f => f.significant);

  let msg =
    `📊 <b>ABOKI WEEKLY BACKTEST REPORT</b>\n\n` +
    `🗓 ${new Date(report.generatedAt).toUTCString()}\n\n` +
    `<b>Performance:</b>\n` +
    `• Closed calls: ${summary.totalClosed}\n` +
    `• Hit rate (≥2x): ${summary.overallHitRate}%\n` +
    `• Avg winner peak: ${summary.avgWinnerPeak}x\n\n` +
    `<b>🏆 Top calls ever:</b>\n` +
    summary.topCalls.map(c => `• $${c.symbol}: ${c.peak}x`).join("\n") + "\n\n";

  if (sigFeatures.length > 0) {
    msg += `<b>⚡ Significant findings:</b>\n`;
    sigFeatures.forEach(f => {
      msg += `• ${f.name}: ${f.impact > 0 ? "+" : ""}${f.impact}% impact\n`;
      msg += `  With: ${f.withFeature.hitRate}% | Without: ${f.withoutFeature.hitRate}%\n`;
    });
    msg += "\n";
  }

  if (applied.length > 0) {
    msg += `<b>🔧 Changes applied (${applied.length}):</b>\n`;
    applied.forEach(a => {
      msg += typeof a.to === "boolean"
        ? `• ${a.name}: ${a.from ? "ON" : "OFF"} → ${a.to ? "ON" : "OFF"} (${a.samples} samples, ${a.impact ?? "N/A"}% win rate)\n`
        : `• ${a.name}: ${a.from}pts → ${a.to}pts\n`;
    });
    msg += `\n${restarted ? "✅ Agent restarted with new scores" : "⚠️ Agent restart failed — restart manually"}\n`;
  } else {
    msg += `✅ No changes needed this week\n`;
  }

  msg += `\n<b>🚫 High-vol + parabolic combo veto:</b> ${comboVeto.currentState ? "ON" : "OFF"}\n` +
    `  ${comboVeto.sampleCount}/${comboVeto.minSamplesRequired} samples needed` +
    (comboVeto.winRate !== null ? `, ${comboVeto.winRate}% win rate so far` : "");

  if (concentrationVeto.over20.winRate === 0 && concentrationVeto.over20.n >= 3) {
    msg += `\n⚠️ Concentration veto still active (0% win rate with top holder >20%)`;
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
  }).catch(e => console.error("Telegram send error:", e.message));
}

// ── Main ──
async function main() {
  const autoApply = !process.argv.includes("--dry-run");
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ABOKI BACKTEST HARNESS${autoApply ? "" : " (dry run)"}`);
  console.log(`  ${new Date().toUTCString()}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const calls = loadCalls();
  console.log(`Loaded ${calls.length} closed calls`);

  if (calls.length < MIN_CLOSED) {
    console.log(`⚠️  Only ${calls.length}/${MIN_CLOSED} closed calls — below minimum for reliable analysis`);
    console.log(`   Running analysis for reference but NOT applying changes\n`);
  }

  const report = analyse(calls);
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

  // Print summary
  const { summary, features, comboVeto } = report;
  console.log(`📊 Hit rate: ${summary.overallHitRate}% (${summary.winners}W/${summary.losers}L)`);
  console.log(`   Avg winner: ${summary.avgWinnerPeak}x | Top: ${summary.topCalls[0]?.symbol} ${summary.topCalls[0]?.peak}x\n`);

  features.forEach(f => {
    if (!f.significant && !f.recommendation) return;
    console.log(`${f.significant ? "⚡" : "  "} ${f.name}`);
    console.log(`   WITH: ${f.withFeature.hitRate ?? "N/A"}% (${f.sampleCount} samples) | WITHOUT: ${f.withoutFeature.hitRate ?? "N/A"}%`);
    console.log(`   Impact: ${f.impact > 0 ? "+" : ""}${f.impact}% | Current score: ${f.currentScore}pts`);
    if (f.recommendation) {
      console.log(`   ⚙️  ${f.recommendation.action}: ${f.currentScore} → ${f.recommendation.suggestedScore}pts`);
    }
    console.log();
  });

  console.log(`🚫 High-vol + parabolic combo veto: ${comboVeto.currentState ? "ON" : "OFF"}`);
  console.log(`   ${comboVeto.sampleCount}/${comboVeto.minSamplesRequired} samples needed` +
    (comboVeto.winRate !== null ? ` | win rate so far: ${comboVeto.winRate}%` : " | no combo calls closed yet"));
  if (comboVeto.recommendedState !== comboVeto.currentState) {
    console.log(`   ⚙️  Recommendation: turn ${comboVeto.recommendedState ? "ON" : "OFF"}`);
  }
  console.log();

  // Apply changes
  let applied = [];
  let restarted = false;

  const comboChanged = comboVeto.recommendedState !== comboVeto.currentState;

  if (autoApply && calls.length >= MIN_CLOSED) {
    const changes = report.features.filter(f => f.recommendation && f.autoApply);
    if (changes.length > 0 || comboChanged) {
      console.log(`Applying ${changes.length + (comboChanged ? 1 : 0)} change(s)...`);
      applied = applyScoreChanges(report);
      applied.forEach(a => {
        console.log(typeof a.to === "boolean"
          ? `  ✅ ${a.name}: ${a.from ? "ON" : "OFF"} → ${a.to ? "ON" : "OFF"}`
          : `  ✅ ${a.name}: ${a.from}pts → ${a.to}pts`);
      });
      restarted = restartAgent();
    } else {
      console.log(`✅ No changes recommended — scores are well-calibrated`);
    }
  } else if (!autoApply) {
    console.log(`Dry run — no changes applied. Remove --dry-run to apply.`);
  }

  saveHistory(report, applied);
  await sendTelegramReport(report, applied, restarted);

  console.log(`\nReport saved: data/aboki-backtest-report.json`);
  console.log(`History:      data/aboki-backtest-history.json\n`);
}

main().catch(e => { console.error("Backtest error:", e.message); process.exit(1); });
