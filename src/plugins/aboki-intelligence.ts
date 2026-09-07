import fs from "fs";
import path from "path";
import { readMemory, readTrades } from "./aboki-memory.ts";

const JOURNAL_FILE = path.join(process.cwd(), "data", "aboki-journal.json");
const WATCHLIST_FILE = path.join(process.cwd(), "data", "aboki-watchlist.json");
const STRATEGY_FILE = path.join(process.cwd(), "data", "aboki-strategy.json");

// ── INTERFACES ──
interface JournalEntry {
  id: string;
  timestamp: string;
  type: "SIGNAL" | "WATCHLIST_UPDATE" | "STRATEGY_REVIEW" | "RISK_ADJUSTMENT";
  token: string;
  symbol: string;
  marketCap: number;
  decision: string;
  confidence: number;
  reasoning: string;
  lesson?: string;
  mood: "BULLISH" | "BEARISH" | "NEUTRAL";
}

interface WatchlistToken {
  mint: string;
  symbol: string;
  addedAt: string;
  reason: string;
  initialMC: number;
  currentMC: number;
  scansObserved: number;
  mcHistory: number[];
  status: "WATCHING" | "READY" | "DEAD" | "PROMOTED";
  notes: string[];
}

interface StrategyScore {
  name: string;
  totalSignals: number;
  correctPredictions: number;
  accuracy: number;
  lastUpdated: string;
}

interface RiskProfile {
  currentLevel: "CONSERVATIVE" | "NORMAL" | "AGGRESSIVE";
  confidenceThreshold: number;
  recentWinRate: number;
  consecutiveLosses: number;
  lastAdjusted: string;
  reason: string;
}

// ── INITIALIZE ──
export function initializeIntelligence(): void {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(JOURNAL_FILE)) {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify([], null, 2));
    console.log("📔 Aboki journal initialized");
  }

  if (!fs.existsSync(WATCHLIST_FILE)) {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify([], null, 2));
    console.log("👁️ Aboki watchlist initialized");
  }

  if (!fs.existsSync(STRATEGY_FILE)) {
    const defaultStrategy = {
      strategies: [
        { name: "News Match", totalSignals: 0, correctPredictions: 0, accuracy: 0, lastUpdated: new Date().toISOString() },
        { name: "Whale Follow", totalSignals: 0, correctPredictions: 0, accuracy: 0, lastUpdated: new Date().toISOString() },
        { name: "MC Momentum", totalSignals: 0, correctPredictions: 0, accuracy: 0, lastUpdated: new Date().toISOString() },
        { name: "Volume Spike", totalSignals: 0, correctPredictions: 0, accuracy: 0, lastUpdated: new Date().toISOString() },
      ],
      riskProfile: {
        currentLevel: "NORMAL",
        confidenceThreshold: 72,
        recentWinRate: 0,
        consecutiveLosses: 0,
        lastAdjusted: new Date().toISOString(),
        reason: "Default starting profile",
      } as RiskProfile,
    };
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify(defaultStrategy, null, 2));
    console.log("📊 Aboki strategy scorer initialized");
  }
}

// ── READ / WRITE HELPERS ──
function readJournal(): JournalEntry[] {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf-8")); }
  catch { return []; }
}

function readWatchlist(): WatchlistToken[] {
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf-8")); }
  catch { return []; }
}

function readStrategy(): any {
  try { return JSON.parse(fs.readFileSync(STRATEGY_FILE, "utf-8")); }
  catch { return { strategies: [], riskProfile: {} }; }
}

// ── 1. TRADE JOURNAL ──
export function writeJournalEntry(entry: Omit<JournalEntry, "id" | "timestamp">): void {
  const journal = readJournal();
  const newEntry: JournalEntry = {
    id: `journal_${Date.now()}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  journal.push(newEntry);
  const recent = journal.slice(-200);
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(recent, null, 2));
  console.log(`📔 Journal: [${entry.type}] ${entry.symbol} — ${entry.decision} — ${entry.mood}`);
}

export async function generateJournalEntry(
  token: any,
  dexData: any,
  score: any
): Promise<void> {
  const mood = score.confidence >= 72 ? "BULLISH" :
    score.confidence >= 50 ? "NEUTRAL" : "BEARISH";

  const mc = parseFloat(dexData?.marketCap || "0");
  const vol5m = parseFloat(dexData?.volume?.m5 || "0");
  const priceChange5m = parseFloat(dexData?.priceChange?.m5 || "0");

  let reasoning = `Scanned ${token.symbol} at MC $${mc.toFixed(0)}. `;
  reasoning += `Confidence: ${score.confidence}%. `;
  reasoning += `5m volume: $${vol5m.toFixed(0)}, price change: ${priceChange5m}%. `;
  reasoning += `Decision: ${score.decision || "SKIP"}. `;
  reasoning += `Reason: ${score.reason}`;

  writeJournalEntry({
    type: "SIGNAL",
    token: token.mint,
    symbol: token.symbol,
    marketCap: mc,
    decision: score.shouldBuy && score.confidence >= 72 ? "BUY SIGNAL" : "SKIP",
    confidence: score.confidence,
    reasoning,
    mood,
  });
}

// ── 2. WATCHLIST OBSERVER ──
export function addToWatchlist(token: any, dexData: any, reason: string): void {
  const watchlist = readWatchlist();
  const existing = watchlist.find(w => w.mint === token.mint);
  if (existing) return; // already watching

  const mc = parseFloat(dexData?.marketCap || "0");
  const newWatch: WatchlistToken = {
    mint: token.mint,
    symbol: token.symbol,
    addedAt: new Date().toISOString(),
    reason,
    initialMC: mc,
    currentMC: mc,
    scansObserved: 1,
    mcHistory: [mc],
    status: "WATCHING",
    notes: [`Added: ${reason}`],
  };

  watchlist.push(newWatch);
  const recent = watchlist.slice(-50); // keep 50 max
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(recent, null, 2));
  console.log(`👁️ Watchlist: Added ${token.symbol} — ${reason}`);
}

export function updateWatchlist(tokens: any[], dexDataMap: Map<string, any>): void {
  const watchlist = readWatchlist();
  if (watchlist.length === 0) return;

  let updated = false;

  for (const watch of watchlist) {
    if (watch.status === "DEAD" || watch.status === "PROMOTED") continue;

    const token = tokens.find(t => t.mint === watch.mint);
    const dexData = dexDataMap.get(watch.mint);

    if (!dexData) {
      watch.scansObserved++;
      if (watch.scansObserved > 20) {
        watch.status = "DEAD";
        watch.notes.push(`Died after ${watch.scansObserved} scans with no data`);
        console.log(`💀 Watchlist: ${watch.symbol} marked DEAD`);
      }
      updated = true;
      continue;
    }

    const currentMC = parseFloat(dexData?.marketCap || "0");
    const mcGrowth = watch.initialMC > 0
      ? ((currentMC - watch.initialMC) / watch.initialMC * 100).toFixed(1)
      : "0";

    watch.currentMC = currentMC;
    watch.scansObserved++;
    watch.mcHistory.push(currentMC);
    if (watch.mcHistory.length > 20) watch.mcHistory = watch.mcHistory.slice(-20);

    // Check if token is now ready to trade
    if (currentMC >= 30000 && currentMC <= 500000) {
      if (watch.status === "WATCHING") {
        watch.status = "READY";
        watch.notes.push(`READY TO TRADE at MC $${currentMC.toFixed(0)} — growth: ${mcGrowth}%`);
        console.log(`🚀 Watchlist: ${watch.symbol} is NOW READY TO TRADE! MC $${currentMC.toFixed(0)} (${mcGrowth}% growth)`);
      }
    }

    // Mark dead if MC crashed
    if (currentMC < 5000 && watch.scansObserved > 5) {
      watch.status = "DEAD";
      watch.notes.push(`MC crashed to $${currentMC.toFixed(0)}`);
      console.log(`💀 Watchlist: ${watch.symbol} died — MC crashed to $${currentMC.toFixed(0)}`);
    }

    updated = true;
  }

  if (updated) {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));
  }
}

export function getWatchlistSummary(): string {
  const watchlist = readWatchlist();
  const watching = watchlist.filter(w => w.status === "WATCHING").length;
  const ready = watchlist.filter(w => w.status === "READY");
  const dead = watchlist.filter(w => w.status === "DEAD").length;

  let summary = `👁️ Watchlist: ${watching} watching, ${ready.length} ready, ${dead} dead`;
  if (ready.length > 0) {
    summary += `\n🚀 READY: ${ready.map(r => `${r.symbol} MC $${r.currentMC.toFixed(0)}`).join(", ")}`;
  }
  return summary;
}

// ── 3. STRATEGY SCORER ──

// Minimum closed (non-PENDING) outcomes before a strategy's accuracy
// number means anything. Below this, we track the count but don't
// surface the accuracy as a ranking signal — it's noise.
const MIN_STRATEGY_SAMPLES = 20;

export function scoreStrategy(strategyName: string, wasCorrect: boolean): void {
  const data = readStrategy();
  const strategy = data.strategies.find((s: StrategyScore) => s.name === strategyName);
  if (!strategy) return;

  strategy.totalSignals++;
  if (wasCorrect) strategy.correctPredictions++;
  strategy.accuracy = strategy.totalSignals > 0
    ? Math.round((strategy.correctPredictions / strategy.totalSignals) * 100)
    : 0;
  strategy.lastUpdated = new Date().toISOString();

  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));

  const reliable = strategy.totalSignals >= MIN_STRATEGY_SAMPLES;
  console.log(
    `📊 Strategy "${strategyName}": ${strategy.accuracy}% accuracy (${strategy.totalSignals} signals)` +
    (reliable ? "" : ` ⚠️ below ${MIN_STRATEGY_SAMPLES}-sample minimum — not yet statistically reliable`)
  );
}

export function getStrategyReport(): string {
  const data = readStrategy();
  if (!data.strategies || data.strategies.length === 0) return "No strategy data yet";

  const lines = data.strategies.map((s: StrategyScore) => {
    const reliable = s.totalSignals >= MIN_STRATEGY_SAMPLES;
    return (
      `${s.name}: ${reliable ? `${s.accuracy}% accuracy` : `${s.accuracy}% (⚠️ only ${s.totalSignals}/${MIN_STRATEGY_SAMPLES} samples — hold)`} (${s.totalSignals} signals)`
    );
  });
  return `📊 STRATEGY REPORT:\n${lines.join("\n")}`;
}

// ── 4. ADAPTIVE RISK ADJUSTMENT ──

// How many CLOSED (non-PENDING) trades we require before the risk
// profile is allowed to move at all.
const MIN_CLOSED_FOR_RISK_CHANGE = 30;

export function adjustRisk(): RiskProfile {
  const data = readStrategy();
  const trades = readTrades();
  const riskProfile: RiskProfile = data.riskProfile;

  // Only count trades that have actually resolved — PENDING outcomes
  // are not real feedback and skew win rate calculations badly.
  const closedTrades = trades.filter(t => t.outcome === "WIN" || t.outcome === "LOSS");

  // ── FROZEN BASELINE: log what the threshold WOULD be under the current
  // inputs even when we don't actually apply a change. This is how you
  // tell, after 100 calls, whether the adaptation was helping or not.
  const recent = closedTrades.slice(-20);
  const recentWins   = recent.filter(t => t.outcome === "WIN").length;
  const recentWinRate = recent.length > 0 ? Math.round((recentWins / recent.length) * 100) : 0;

  let consecutiveLosses = 0;
  for (let i = closedTrades.length - 1; i >= 0; i--) {
    if (closedTrades[i].outcome === "LOSS") consecutiveLosses++;
    else break;
  }

  // What adjustment would fire if we had enough data?
  let wouldBeLevel = riskProfile.currentLevel;
  let wouldBeThreshold = riskProfile.confidenceThreshold;
  if (consecutiveLosses >= 3) {
    wouldBeLevel = "CONSERVATIVE"; wouldBeThreshold = 80;
  } else if (recentWinRate >= 70) {
    wouldBeLevel = "AGGRESSIVE"; wouldBeThreshold = 65;
  } else {
    wouldBeLevel = "NORMAL"; wouldBeThreshold = 72;
  }

  // Hard gate: don't change anything until we have enough real outcomes.
  if (closedTrades.length < MIN_CLOSED_FOR_RISK_CHANGE) {
    console.log(
      `🔒 Risk profile FROZEN — only ${closedTrades.length}/${MIN_CLOSED_FOR_RISK_CHANGE} closed trades. ` +
      `Would be: ${wouldBeLevel} (threshold ${wouldBeThreshold}%) if gate were open. ` +
      `Current: ${riskProfile.currentLevel} (${riskProfile.confidenceThreshold}%)`
    );
    return riskProfile;
  }

  let reason = "";
  if (consecutiveLosses >= 3) {
    reason = `${consecutiveLosses} consecutive losses — tightening rules`;
  } else if (recentWinRate >= 70) {
    reason = `${recentWinRate}% win rate over ${recent.length} closed trades — loosening slightly`;
  } else {
    reason = `Normal conditions (${recentWinRate}% win rate, ${consecutiveLosses} consecutive losses)`;
  }

  const updated: RiskProfile = {
    currentLevel: wouldBeLevel,
    confidenceThreshold: wouldBeThreshold,
    recentWinRate: recentWinRate,
    consecutiveLosses,
    lastAdjusted: new Date().toISOString(),
    reason,
  };

  data.riskProfile = updated;
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));

  if (wouldBeLevel !== riskProfile.currentLevel) {
    console.log(`⚡ RISK ADJUSTED: ${riskProfile.currentLevel} → ${wouldBeLevel}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   New threshold: ${wouldBeThreshold}% (was ${riskProfile.confidenceThreshold}%)`);
    console.log(`   Based on ${closedTrades.length} closed trades total, ${recent.length} in recent window`);

    writeJournalEntry({
      type: "RISK_ADJUSTMENT",
      token: "SYSTEM",
      symbol: "SYSTEM",
      marketCap: 0,
      decision: `${riskProfile.currentLevel} → ${wouldBeLevel}`,
      confidence: wouldBeThreshold,
      reasoning: `${reason} | Closed trades: ${closedTrades.length} | Recent window: ${recent.length}`,
      mood: wouldBeLevel === "CONSERVATIVE" ? "BEARISH" : wouldBeLevel === "AGGRESSIVE" ? "BULLISH" : "NEUTRAL",
    });
  } else {
    console.log(`📊 Risk profile unchanged: ${wouldBeLevel} (${wouldBeThreshold}%) — ${reason}`);
  }

  return updated;
}

export function getRiskProfile(): RiskProfile {
  const data = readStrategy();
  return data.riskProfile;
}