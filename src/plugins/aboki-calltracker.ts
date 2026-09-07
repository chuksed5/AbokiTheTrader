import fs from "fs";
import path from "path";
import { updateTradeOutcome } from "./aboki-memory.ts";
import {
  getHolderConcentration,
  getEarlyBuyers,
  checkWhaleActivity,
} from "./aboki-whale-intel.ts";

const CALLS_FILE = path.join(process.cwd(), "data", "aboki-calls.json");

// ── INTERFACES ──
export type CallStatus = "WATCHING" | "PUMPING" | "MOONED" | "RUGGED" | "DEAD" | "EXPIRED";

export interface TrackedCall {
  id: string;                  // unique id = mint + timestamp
  mint: string;
  symbol: string;
  name: string;
  calledAt: string;            // ISO timestamp of call
  calledMC: number;            // MC at time of call
  calledPrice: string;         // price at time of call
  peakMC: number;              // highest MC seen since call
  currentMC: number;           // latest MC
  currentMultiple: number;     // currentMC / calledMC
  peakMultiple: number;        // peakMC / calledMC
  status: CallStatus;
  milestonesHit: string[];     // ["2x", "5x", "10x"]
  lastChecked: string;         // ISO timestamp of last update
  closedAt?: string;           // ISO timestamp when tracking stopped
  closeReason?: string;        // why tracking stopped
  confidence: number;          // confidence score at call time
  reason: string;              // why Aboki called it
  // On-chain snapshots — captured at call time, then re-checked every revisit
  entryTopHolderPct?: number;
  entryTop3HolderPct?: number;
  entryWhaleCount?: number;
  lastTopHolderPct?: number;
  lastTop3HolderPct?: number;
  lastWhaleCount?: number;
  lastInsiderCount?: number;
}

interface CallsState {
  calls: TrackedCall[];
}

// ── READ / WRITE ──
function readCalls(): CallsState {
  try {
    return JSON.parse(fs.readFileSync(CALLS_FILE, "utf-8"));
  } catch {
    return { calls: [] };
  }
}

function writeCalls(state: CallsState): void {
  fs.writeFileSync(CALLS_FILE, JSON.stringify(state, null, 2));
}

// ── INITIALIZE ──
export function initializeCallTracker(): void {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(CALLS_FILE)) {
    writeCalls({ calls: [] });
    console.log(" Call tracker initialized");
  }
}

// ── RECORD A NEW CALL ──
export function recordCall(
  mint: string,
  symbol: string,
  name: string,
  mc: number,
  price: string,
  confidence: number,
  reason: string,
  onChainEntry?: { topHolderPct: number; top3HolderPct: number; whaleCount: number }
): void {
  const state = readCalls();

  // Don't duplicate — if already tracking this mint and it's still open, skip
  const existing = state.calls.find(
    c => c.mint === mint && !["RUGGED", "DEAD", "EXPIRED", "MOONED"].includes(c.status)
  );
  if (existing) return;

  const call: TrackedCall = {
    id: `${mint}-${Date.now()}`,
    mint,
    symbol,
    name,
    calledAt: new Date().toISOString(),
    calledMC: mc,
    calledPrice: price,
    peakMC: mc,
    currentMC: mc,
    currentMultiple: 1,
    peakMultiple: 1,
    status: "WATCHING",
    milestonesHit: [],
    lastChecked: new Date().toISOString(),
    confidence,
    reason,
    entryTopHolderPct: onChainEntry?.topHolderPct,
    entryTop3HolderPct: onChainEntry?.top3HolderPct,
    entryWhaleCount: onChainEntry?.whaleCount,
  };

  state.calls.push(call);
  writeCalls(state);
  console.log(` Call recorded: ${symbol} at MC $${mc.toFixed(0)}`);
}

// ── GET ACTIVE CALLS (not closed) ──
export function getActiveCalls(): TrackedCall[] {
  const state = readCalls();
  return state.calls.filter(
    c => c.id && typeof c.calledMC === "number" && c.calledMC > 0 &&
    (!["RUGGED", "DEAD", "EXPIRED"].includes(c.status) ||
    (c.status === "MOONED" && !c.closedAt))
  );
}

// ── HELPER: on-chain context line for alerts ──
function onChainLine(call: TrackedCall): string {
  if (call.lastTopHolderPct === undefined) return "";
  const entry = call.entryTopHolderPct ?? call.lastTopHolderPct;
  const delta = call.lastTopHolderPct - entry;
  const trend =
    delta >= 1 ? `⬆ +${delta.toFixed(1)}pp since call` :
    delta <= -1 ? `⬇ ${delta.toFixed(1)}pp since call` :
    "→ stable since call";
  return (
    `\n Top holder: ${call.lastTopHolderPct}% (${trend})` +
    `\n   Tracked whales in: ${call.lastWhaleCount ?? 0}${call.lastInsiderCount ? ` (${call.lastInsiderCount} insider-flagged)` : ""}`
  );
}

// ── UPDATE A SINGLE CALL with latest market data ──
// Returns alerts to send (if any)
export function updateCall(
  mint: string,
  currentMC: number,
  currentPrice: string,
  liquidityUsd: number,
  volume5m: number,
  onChain?: { topHolderPct: number; top3HolderPct: number; whaleCount: number; insiderCount: number }
): string[] {
  const state = readCalls();
  const alerts: string[] = [];
  const now = new Date();

  const idx = state.calls.findIndex(
    c => c.mint === mint && !c.closedAt
  );
  if (idx === -1) return alerts;

  const call = state.calls[idx];
  const multiple = currentMC / call.calledMC;
  const hoursSincCall = (now.getTime() - new Date(call.calledAt).getTime()) / (1000 * 60 * 60);
  const maxHours = call.status === "MOONED" ? 168 : 72; // 7 days if mooned, else 3 days

  // Update basic fields
  call.currentMC = currentMC;
  call.currentMultiple = parseFloat(multiple.toFixed(2));
  call.lastChecked = now.toISOString();

  if (currentMC > call.peakMC) {
    call.peakMC = currentMC;
    call.peakMultiple = parseFloat(multiple.toFixed(2));
  }

  // ── ON-CHAIN CONCENTRATION RE-CHECK ──
  // This runs every revisit, independent of price — a token can be
  // green on the chart while a wallet quietly accumulates supply.
  if (onChain) {
    if (call.entryTopHolderPct === undefined) {
      // Backfill entry baseline if this call predates on-chain tracking
      call.entryTopHolderPct = onChain.topHolderPct;
      call.entryTop3HolderPct = onChain.top3HolderPct;
      call.entryWhaleCount = onChain.whaleCount;
    }

    const entryTopHolderPct = call.entryTopHolderPct ?? onChain.topHolderPct;
    const deltaSinceEntry = onChain.topHolderPct - entryTopHolderPct;

    call.lastTopHolderPct = onChain.topHolderPct;
    call.lastTop3HolderPct = onChain.top3HolderPct;
    call.lastWhaleCount = onChain.whaleCount;
    call.lastInsiderCount = onChain.insiderCount;

    // Fire a standalone warning if supply is concentrating meaningfully,
    // even if price hasn't hit a milestone or a closure condition.
    if (deltaSinceEntry >= 8 && onChain.topHolderPct >= 12) {
      alerts.push(
        `⚠ <b>CONCENTRATION RISING</b> — $${call.symbol}\n\n` +
        `Top holder: ${onChain.topHolderPct}% (was ${entryTopHolderPct}% at call, +${deltaSinceEntry.toFixed(1)}pp)\n` +
        `Top 3 holders: ${onChain.top3HolderPct}%\n` +
        `Price: ${multiple.toFixed(2)}x since call\n\n` +
        `Supply is concentrating — dump risk building even though price may still look fine.`
      );
    }
  }

  // ── CHECK: EXPIRED (3 days passed, not mooned) ──
  if (hoursSincCall >= maxHours) {
    call.status = "EXPIRED";
    call.closedAt = now.toISOString();
    call.closeReason = `Tracking window closed after ${Math.round(hoursSincCall)}h`;
    alerts.push(
      `⏰ <b>CALL EXPIRED</b> — $${call.symbol}\n\n` +
      `Called at: $${formatMC(call.calledMC)} MC\n` +
      `Final MC: $${formatMC(currentMC)}\n` +
      `Peak: $${formatMC(call.peakMC)} (${call.peakMultiple}x)\n` +
      `Result: ${multiple >= 2 ? "✅ Profitable" : multiple >= 1 ? "➖ Break even" : "❌ Loss"}\n` +
      `Duration: ${Math.round(hoursSincCall)}h` +
      onChainLine(call)
    );
    state.calls[idx] = call;
    writeCalls(state);

    updateTradeOutcome(
      call.mint,
      call.symbol,
      multiple >= 1 ? "WIN" : "LOSS",
      parseFloat(((multiple - 1) * 100).toFixed(1)),
      `Expired after ${Math.round(hoursSincCall)}h at ${multiple.toFixed(2)}x (peak ${call.peakMultiple}x). Confidence was ${call.confidence}%.` +
      (call.lastTopHolderPct !== undefined ? ` Top holder ended at ${call.lastTopHolderPct}% (was ${call.entryTopHolderPct}% at call).` : "")
    );

    return alerts;
  }

  // ── CHECK: RUGGED (liquidity dropped >80%) ──
  const initialLiquidity = call.calledMC * 0.05; // estimate ~5% of MC was liquidity
  if (liquidityUsd > 0 && liquidityUsd < initialLiquidity * 0.2) {
    call.status = "RUGGED";
    call.closedAt = now.toISOString();
    call.closeReason = "Liquidity collapsed";
    alerts.push(
      ` <b>RUGGED</b> — $${call.symbol}\n\n` +
      `Called at: $${formatMC(call.calledMC)} MC\n` +
      `Rugged at: $${formatMC(currentMC)} MC\n` +
      `Liquidity remaining: $${liquidityUsd.toFixed(0)}\n` +
      `Called ${Math.round(hoursSincCall)}h ago\n\n` +
      `Aboki called this at ${call.confidence}% confidence.\n` +
      `Reason: ${call.reason}` +
      onChainLine(call)
    );
    state.calls[idx] = call;
    writeCalls(state);

    // Rugged is always a loss regardless of the surface multiple —
    // liquidity collapse means the exit was never really available.
    updateTradeOutcome(
      call.mint,
      call.symbol,
      "LOSS",
      parseFloat(((multiple - 1) * 100).toFixed(1)),
      `Rugged ${Math.round(hoursSincCall)}h after call — liquidity collapsed to $${liquidityUsd.toFixed(0)}. Confidence was ${call.confidence}%. Reason given: ${call.reason}` +
      (call.lastTopHolderPct !== undefined ? ` Top holder was ${call.lastTopHolderPct}% (entry ${call.entryTopHolderPct}%).` : "")
    );

    return alerts;
  }

  // ── CHECK: DEAD (no volume for extended period) ──
  if (volume5m === 0 && hoursSincCall > 6) {
    call.status = "DEAD";
    call.closedAt = now.toISOString();
    call.closeReason = "No volume — token went cold";
    alerts.push(
      `⚰ <b>DEAD</b> — $${call.symbol}\n\n` +
      `Called at: $${formatMC(call.calledMC)} MC\n` +
      `Died at: $${formatMC(currentMC)} MC\n` +
      `Peak reached: $${formatMC(call.peakMC)} (${call.peakMultiple}x)\n` +
      `No volume detected after ${Math.round(hoursSincCall)}h` +
      onChainLine(call)
    );
    state.calls[idx] = call;
    writeCalls(state);

    updateTradeOutcome(
      call.mint,
      call.symbol,
      multiple >= 1 ? "WIN" : "LOSS",
      parseFloat(((multiple - 1) * 100).toFixed(1)),
      `Went cold ${Math.round(hoursSincCall)}h after call at ${multiple.toFixed(2)}x (peak ${call.peakMultiple}x) — no volume. Confidence was ${call.confidence}%.`
    );

    return alerts;
  }

  // ── CHECK: MILESTONES ──
  const milestones = [
    { label: "2x",  threshold: 2,   emoji: "" },
    { label: "3x",  threshold: 3,   emoji: "" },
    { label: "5x",  threshold: 5,   emoji: "" },
    { label: "10x", threshold: 10,  emoji: "" },
    { label: "20x", threshold: 20,  emoji: "" },
    { label: "50x", threshold: 50,  emoji: "" },
    { label: "100x",threshold: 100, emoji: "" },
  ];

  for (const milestone of milestones) {
    if (multiple >= milestone.threshold && !call.milestonesHit.includes(milestone.label)) {
      call.milestonesHit.push(milestone.label);
      call.status = multiple >= 10 ? "MOONED" : "PUMPING";
      alerts.push(
        `${milestone.emoji} <b>${milestone.label} MILESTONE</b> — $${call.symbol}\n\n` +
        `Called at: $${formatMC(call.calledMC)} MC\n` +
        `Now at: $${formatMC(currentMC)} MC\n` +
        `That's <b>${multiple.toFixed(1)}x</b> from Aboki's call!\n` +
        `Called ${Math.round(hoursSincCall)}h ago at ${call.confidence}% confidence\n\n` +
        `Reason for call: ${call.reason}` +
        onChainLine(call)
      );
    }
  }

  // Update status if pumping but not yet milestone
  if (multiple >= 2 && call.status === "WATCHING") {
    call.status = "PUMPING";
  }

  state.calls[idx] = call;
  writeCalls(state);
  return alerts;
}

// ── REFRESH ALL ACTIVE CALLS ──
// Call this every few scans to check on all tracked tokens
export async function refreshAllCalls(): Promise<string[]> {
  const activeCalls = getActiveCalls();
  if (activeCalls.length === 0) return [];

  const allAlerts: string[] = [];

  for (const call of activeCalls) {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${call.mint}`
      );
      const data = await res.json();
      const pair = data?.pairs?.[0];
      if (!pair) continue;

      const currentMC = parseFloat(pair.marketCap || pair.fdv || "0");
      const currentPrice = pair.priceUsd || "0";
      const liquidityUsd = parseFloat(pair.liquidity?.usd || "0");
      const volume5m = parseFloat(pair.volume?.m5 || "0");

      if (currentMC === 0) continue;

      // Re-check on-chain data on every revisit — not just price.
      // A token can look green while a wallet is quietly accumulating.
      let onChain:
        | { topHolderPct: number; top3HolderPct: number; whaleCount: number; insiderCount: number }
        | undefined;

      const holderSnapshot = await getHolderConcentration(call.mint, pair.pairAddress);
      if (holderSnapshot && holderSnapshot.poolAccountsExcluded > 0) {
        console.log(`粒 ${call.symbol}: excluded ${holderSnapshot.poolAccountsExcluded} pool-owned account(s) from holder stats`);
      }
      if (holderSnapshot) {
        const recentBuyers = await getEarlyBuyers(call.mint, call.symbol);
        const whaleActivity = checkWhaleActivity(call.mint, recentBuyers);
        onChain = {
          topHolderPct: holderSnapshot.topHolderPct,
          top3HolderPct: holderSnapshot.top3HolderPct,
          whaleCount: whaleActivity.whaleCount,
          insiderCount: whaleActivity.insiderCount,
        };
      }

      const alerts = updateCall(call.mint, currentMC, currentPrice, liquidityUsd, volume5m, onChain);
      allAlerts.push(...alerts);
    } catch (e) {
      console.error(`Call tracker error for ${call.symbol}:`, e);
    }
  }

  return allAlerts;
}

// ── DAILY SUMMARY ──
export function getDailySummary(): string {
  const state = readCalls();
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Guard against malformed/legacy stub rows (e.g. seed entries with no
  // id/calledMC/peakMultiple) so they can't render as "undefinedx" or
  // "$N/A" in the report, or sneak into "best calls ever" via a NaN
  // comparison in the sort below.
  const valid = state.calls.filter(
    c => c.id && typeof c.calledMC === "number" && c.calledMC > 0
  );

  const recent = valid.filter(c => new Date(c.calledAt) > last24h);
  const active = valid.filter(c => !c.closedAt);
  const mooned = valid.filter(c => c.status === "MOONED");
  const rugged = valid.filter(c => c.status === "RUGGED" && new Date(c.calledAt) > last24h);
  const dead = valid.filter(c => c.status === "DEAD" && new Date(c.calledAt) > last24h);

  let summary = ` <b>ABOKI DAILY REPORT</b>\n`;
  summary += `━━━━━━━━━━━━━━━━━━\n`;
  summary += ` ${now.toUTCString()}\n\n`;
  summary += ` Calls last 24h: ${recent.length}\n`;
  summary += ` Currently tracking: ${active.length}\n`;
  summary += ` Mooned: ${mooned.length}\n`;
  summary += ` Rugged: ${rugged.length}\n`;
  summary += `⚰ Dead: ${dead.length}\n\n`;

  if (active.length > 0) {
    summary += `<b>ACTIVE CALLS:</b>\n`;
    for (const call of active.slice(0, 10)) {
      const icon = call.currentMultiple >= 10 ? "" :
                   call.currentMultiple >= 5  ? "" :
                   call.currentMultiple >= 2  ? "" :
                   call.currentMultiple >= 1  ? "➖" : "";
      summary += `${icon} $${call.symbol}: ${call.currentMultiple}x (Peak: ${call.peakMultiple}x) | MC: $${formatMC(call.currentMC)}\n`;
    }
  }

  if (mooned.length > 0) {
    summary += `\n<b> BEST CALLS EVER:</b>\n`;
    const top = [...valid]
      .sort((a, b) => b.peakMultiple - a.peakMultiple)
      .slice(0, 5);
        for (const call of top) {

      summary += ` $${call.symbol}: ${call.peakMultiple}x (Called at $${formatMC(call.calledMC)})\n`;

    }

  }



  return summary;

}



// ── HELPER: format MC nicely ──

function formatMC(mc: number | undefined | null): string {

  if (mc == null || isNaN(mc)) return "N/A";

  if (mc >= 1_000_000) return `${(mc / 1_000_000).toFixed(1)}M`;

  if (mc >= 1_000) return `${(mc / 1_000).toFixed(1)}K`;

  return mc.toFixed(0);

}

// ── GET ALL CALLS SUMMARY (for console logs) ──
export function getCallsSummary(): string {
  const active = getActiveCalls();
  if (active.length === 0) return " No active calls being tracked";
  const lines = active.map(c =>
    `  • $${c.symbol}: ${c.currentMultiple}x | Peak: ${c.peakMultiple}x | Status: ${c.status}`
  );
  return ` TRACKING ${active.length} CALLS:\n${lines.join("\n")}`;
;