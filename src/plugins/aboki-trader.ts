import {
  initializeNarrativeTracker,
  refreshNarratives,
  getNarrativeBoost,
  getNarrativeSummary,
  getCoinQualityAdjustment,
} from "./aboki-narrative.ts";

import {
  initializeCallTracker,
  recordCall,
  refreshAllCalls,
  getDailySummary,
  getCallsSummary,
} from "./aboki-calltracker.ts";

import { initializeMemory, readMemory, logTrade, selfReview } from "./aboki-memory.ts";
import {
  HIGH_VOL_PENALTY,
  PARABOLIC_PENALTY,
  DUMPING_PENALTY,
  HARD_VETO_HIGH_VOL_PARABOLIC,
  TOP_HOLDER_VETO_PCT,
  TOP3_HOLDER_VETO_PCT,
  MIN_CONFIDENCE_FLOOR,
} from "../config/backtest-scores.ts";
import { Plugin, IAgentRuntime } from "@elizaos/core";
import {
  initializeIntelligence,
  generateJournalEntry,
  addToWatchlist,
  updateWatchlist,
  getWatchlistSummary,
  adjustRisk,
  getRiskProfile,
  getStrategyReport,
} from "./aboki-intelligence.ts";

import {
  initializeWhaleIntel,
  getEarlyBuyers,
  scoreWallet,
  detectCoordination,
  checkWhaleActivity,
  getWhaleReport,
  getHolderConcentration,
  detectFundingCluster,
} from "./aboki-whale-intel.ts";


// Cooldown tracker — token mint → last signal timestamp
const signalCooldown = new Map<string, number>();
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Daily summary tracker
let lastDailySummary = 0;
const DAILY_SUMMARY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── STEP 1: Scan DexScreener for new Solana tokens ──
async function scanPumpFun(): Promise<any[]> {
  try {
    const res = await fetch(
      "https://api.dexscreener.com/token-profiles/latest/v1",
      { headers: { "Accept": "application/json" } }
    );
    const data = await res.json();
    const solTokens = Array.isArray(data)
      ? data.filter((t: any) => t.chainId === "solana").slice(0, 10)
      : [];
    return solTokens.map((t: any) => ({
      mint: t.tokenAddress,
      symbol: "UNKNOWN",
      name: "UNKNOWN",
      usd_market_cap: 0,
      created_timestamp: Date.now(),
      description: t.description || "",
    }));
  } catch (e) {
    console.error("DexScreener scan error:", e);
    return [];
  }
}

// ── STEP 2: Get token data from DexScreener ──
async function getTokenData(mintAddress: string): Promise<any> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
    );
    const data = await res.json();
    return data?.pairs?.[0] || null;
  } catch (e) {
    console.error("DexScreener error:", e);
    return null;
  }
}

// ── STEP 3: Score token deterministically ──
// The LLM was previously doing arithmetic (MC range checks, volume
// thresholds, liquidity floors) inconsistently on every run. Those
// are now hard deterministic rules that produce the same score for
// the same inputs every time. The LLM is still called — but only to
// produce a short reason string where it actually adds value:
// reading the token name/description for narrative/community signals.

interface TokenScore {
  shouldBuy: boolean;
  confidence: number;
  reason: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
}

function scoreTokenDeterministic(token: any, dexData: any, rules: string[] = []): TokenScore {
  const mc          = parseFloat(dexData?.marketCap || dexData?.fdv || "0");
  const vol5m       = parseFloat(dexData?.volume?.m5 || "0");
  const vol1h       = parseFloat(dexData?.volume?.h1 || "0");
  const liquidity   = parseFloat(dexData?.liquidity?.usd || "0");
  const change5m    = parseFloat(dexData?.priceChange?.m5 || "0");
  const change1h    = parseFloat(dexData?.priceChange?.h1 || "0");
  const txns5mBuys  = dexData?.txns?.m5?.buys || 0;

  let score = 50; // neutral baseline
  const factors: string[] = [];

  // ── MC range (sweet spot for early memecoin entries) ──
  if (mc >= 10_000 && mc < 50_000) {
    score += 15; factors.push(`MC $${(mc/1000).toFixed(0)}k (early sweet spot)`);
  } else if (mc >= 50_000 && mc < 200_000) {
    score += 8;  factors.push(`MC $${(mc/1000).toFixed(0)}k (mid range)`);
  } else if (mc >= 200_000 && mc < 500_000) {
    score += 3;  factors.push(`MC $${(mc/1000).toFixed(0)}k (getting heavy)`);
  } else if (mc < 10_000) {
    score -= 15; factors.push(`MC $${mc.toFixed(0)} (too small — likely pre-liquidity)`);
  } else {
    score -= 10; factors.push(`MC $${(mc/1000).toFixed(0)}k (too heavy for early entry)`);
  }

  // ── Volume 5m (real buying activity) ──
  if (vol5m >= 5_000 && vol5m < 30_000) {
    score += 10; factors.push(`5m vol $${(vol5m/1000).toFixed(1)}k (healthy)`);
  } else if (vol5m >= 30_000) {
    score += HIGH_VOL_PENALTY;  factors.push(`5m vol $${(vol5m/1000).toFixed(1)}k (high — could be late)`);
  } else if (vol5m < 1_000) {
    score -= 10; factors.push(`5m vol $${vol5m.toFixed(0)} (barely any activity)`);
  }

  // ── Liquidity floor (no liquidity = no exit) ──
  if (liquidity >= 10_000) {
    score += 8;  factors.push(`liquidity $${(liquidity/1000).toFixed(1)}k (safe)`);
  } else if (liquidity >= 3_000) {
    score += 3;  factors.push(`liquidity $${(liquidity/1000).toFixed(1)}k (thin)`);
  } else {
    score -= 15; factors.push(`liquidity $${liquidity.toFixed(0)} (too low — exit risk)`);
  }

  // ── Price momentum ──
  if (change5m > 5 && change5m < 50) {
    score += 8;  factors.push(`+${change5m}% in 5m (clean upward momentum)`);
  } else if (change5m >= 50) {
    score += PARABOLIC_PENALTY;  factors.push(`+${change5m}% in 5m (parabolic — likely late)`);
  } else if (change5m < -10) {
    score += DUMPING_PENALTY; factors.push(`${change5m}% in 5m (dumping)`);
  }

  if (change1h > 20 && change1h < 200) {
    score += 5;  factors.push(`+${change1h}% 1h trend`);
  } else if (change1h >= 200) {
    score -= 8;  factors.push(`+${change1h}% 1h (already pumped hard)`);
  }

  // ── Buy-side tx count (organic vs thin) ──
  if (txns5mBuys >= 10 && txns5mBuys < 50) {
    score += 5;  factors.push(`${txns5mBuys} buys/5m (organic spread)`);
  } else if (txns5mBuys >= 50) {
    score += 2;  factors.push(`${txns5mBuys} buys/5m (very active)`);
  } else if (txns5mBuys < 3) {
    score -= 5;  factors.push(`only ${txns5mBuys} buys/5m (thin organic activity)`);
  }

  // ── Risk classification ──
  let risk: "LOW" | "MEDIUM" | "HIGH" = "HIGH";
  if (mc >= 20_000 && mc < 300_000 && liquidity >= 8_000 && vol5m >= 3_000) {
    risk = liquidity >= 20_000 ? "LOW" : "MEDIUM";
  }

  // ── Hard caps for critical dangers ──
  // A token can have great MC and volume but still be a trap.
  // These set an upper bound on score so that no combination of
  // other good signals can push it past the 60 BUY threshold.
  if (liquidity < 3_000) score = Math.min(score, 40);   // no safe exit exists
  if (change5m < -15)   score = Math.min(score, 45);    // actively dumping

  score = Math.max(0, Math.min(99, score));
  const shouldBuy = score >= 60;

  return {
    shouldBuy,
    confidence: score,
    reason: factors.join(" | ") || "No strong signal",
    risk,
  };
}

// Calls Groq only for a narrative/community reason string — not for scoring.
// If the API is slow or fails, the deterministic score stands on its own.
async function enrichWithNarrativeReason(
  token: any,
  deterministicScore: TokenScore
): Promise<string> {
  try {
    const prompt =
      `You are Aboki, a Solana memecoin scout. In ONE sentence (max 20 words), ` +
      `describe what the narrative or community angle of this token is, if any. ` +
      `If there's no clear narrative, say so plainly. Do not invent one.\n\n` +
      `Token: ${token.name} (${token.symbol})\n` +
      `Description: ${(token.description || "none").slice(0, 120)}\n\n` +
      `Reply with ONLY the sentence. No JSON, no preamble.`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_TRADING_API_KEY || process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 60,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    const narrativeReason = data.choices?.[0]?.message?.content?.trim() || "";
    return narrativeReason ? `${deterministicScore.reason} | 🧠 Narrative: ${narrativeReason}` : deterministicScore.reason;
  } catch {
    return deterministicScore.reason; // deterministic score stands alone on API failure
  }
}

async function scoreToken(
  token: any,
  dexData: any,
  runtime: IAgentRuntime,
  rules: string[] = []
): Promise<TokenScore> {
  const score = scoreTokenDeterministic(token, dexData, rules);
  score.reason = await enrichWithNarrativeReason(token, score);
  return score;
}

// ── STEP 4: Send Telegram alert ──
async function sendTelegramAlert(message: string, token: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    console.error("Telegram alert error:", e);
  }
}

// ── MAIN TRADING LOOP ──
async function tradingLoop(runtime: IAgentRuntime): Promise<void> {
  console.log("🟢 Aboki trading loop started...");

  initializeMemory();
  initializeIntelligence();
  initializeWhaleIntel();
  initializeNarrativeTracker();
  initializeCallTracker();

  await refreshNarratives(); // fetch narratives immediately on startup

  let scanCount = 0;

  setInterval(async () => {
    try {
      scanCount++;

      const riskProfile = getRiskProfile();
      // The live risk-profile system reacts fast to recent trades (good for
      // catching a bad streak quickly) but only looks at a short window.
      // MIN_CONFIDENCE_FLOOR is the backtest harness's slower, much
      // larger-sample verdict on what confidence level actually wins —
      // it can only push the bar UP, never below what the risk profile
      // already wants, so the two systems complement rather than fight.
      const threshold = Math.max(riskProfile.confidenceThreshold, MIN_CONFIDENCE_FLOOR);

      console.log(`🔍 Scanning... (scan #${scanCount}) | Risk: ${riskProfile.currentLevel} | Threshold: ${threshold}%`);

      const memory = readMemory();
      console.log(`🧠 Rules: ${memory.rules.length} | Trades: ${memory.totalTrades} | ${memory.wins}W/${memory.losses}L`);

      // Print watchlist summary every 3 scans
      if (scanCount % 3 === 0) {
        console.log(getWatchlistSummary());
      }

      // Print calls summary every 5 scans
      if (scanCount % 5 === 0) {
        console.log(getCallsSummary());
      }

      // Refresh narratives every 120 scans (1 hour at 30s/scan)
      // 3 Tavily keys × 1,000 credits = 3,000/month combined
      // 1 call/refresh × 24 refreshes/day × 30 days = 720 credits/month — plenty of headroom
      if (scanCount % 120 === 0) {
        await refreshNarratives();
        console.log(getNarrativeSummary());
      }

      // Refresh all tracked calls every 10 scans (5 mins)
      if (scanCount % 10 === 0) {
        console.log("📋 Refreshing tracked calls...");
        const callAlerts = await refreshAllCalls();
        for (const alert of callAlerts) {
          console.log(alert);
          await sendTelegramAlert(alert, process.env.TELEGRAM_BOT_TOKEN || "");
        }
      }

      // Send daily summary once every 24 hours
      const now = Date.now();
      if (now - lastDailySummary >= DAILY_SUMMARY_MS) {
        lastDailySummary = now;
        const summary = getDailySummary();
        console.log(summary);
        await sendTelegramAlert(summary, process.env.TELEGRAM_BOT_TOKEN || "");
      }

      // ── SCAN NEW TOKENS ──
      const tokens = await scanPumpFun();

      if (tokens.length === 0) {
        console.log("⚠️ No tokens found this scan");
        return;
      }

      console.log(`📊 Found ${tokens.length} tokens`);

      const dexDataMap = new Map<string, any>();

      for (const token of tokens.slice(0, 5)) {
        const dexData = await getTokenData(token.mint);
        const mc = parseFloat(dexData?.marketCap || dexData?.fdv || "0");

        // Populate real symbol and name
        if (dexData?.baseToken) {
          token.symbol = dexData.baseToken.symbol || token.mint.slice(0, 8);
          token.name = dexData.baseToken.name || token.symbol;
        } else {
          token.symbol = token.mint.slice(0, 8);
          token.name = token.mint.slice(0, 8);
        }

        if (dexData) dexDataMap.set(token.mint, dexData);

        // Too small — watchlist
        if (mc > 0 && mc < 30000) {
          if (mc > 10000) {
            addToWatchlist(token, dexData, `MC $${mc.toFixed(0)} — growing, below threshold`);
          }
          continue;
        }

        // Too large — skip
        if (mc > 500000) {
          console.log(`⏭️ Skipping ${token.symbol} — MC $${mc.toFixed(0)} too large`);
          continue;
        }

        console.log(`📊 Analyzing ${token.symbol} MC:$${mc.toFixed(0)}...`);

        // Whale analysis
        const earlyBuyers = await getEarlyBuyers(token.mint, token.symbol);
        const whaleActivity = checkWhaleActivity(token.mint, earlyBuyers);

        if (earlyBuyers.length > 0) {
          for (const buyer of earlyBuyers.slice(0, 5)) {
            await scoreWallet(buyer, token.mint, token.symbol, mc, 60);
          }
          detectCoordination(token.mint, token.symbol, earlyBuyers, mc);
        }

        if (whaleActivity.hasWhales) {
          console.log(`🐋 ${token.symbol}: ${whaleActivity.whaleCount} whales | ${whaleActivity.insiderCount} insiders | Recommendation: ${whaleActivity.recommendation}`);
        }

        // AI scoring
        const score = await scoreToken(token, dexData, runtime, memory.rules);

        // Narrative boost
        const narrativeResult = getNarrativeBoost(token.name, token.symbol, token.description || "");
        if (narrativeResult.boost > 0) {
          score.confidence = Math.min(99, score.confidence + narrativeResult.boost);
          score.reason += ` | 🧭 Narrative match: ${narrativeResult.matchedNarratives.join(", ")} (+${narrativeResult.boost}pts)`;
          console.log(`🧭 ${token.symbol}: Narrative boost +${narrativeResult.boost} → confidence now ${score.confidence}%`);
        }

        // Coin-quality adjustment — ticker rerun/OG check + community signal strength
        const qualityResult = await getCoinQualityAdjustment(token.mint, token.symbol, dexData, token.description || "");
        if (qualityResult.adjustment !== 0) {
          score.confidence = Math.max(0, Math.min(99, score.confidence + qualityResult.adjustment));
          score.reason += ` | 🔍 Quality: ${qualityResult.reasons.join("; ")} (${qualityResult.adjustment > 0 ? "+" : ""}${qualityResult.adjustment}pts)`;
          console.log(`🔍 ${token.symbol}: Quality adjustment ${qualityResult.adjustment > 0 ? "+" : ""}${qualityResult.adjustment} → confidence now ${score.confidence}%`);
        }

        // Combined high-vol + parabolic veto — only active once the backtest
        // harness has confirmed it on enough real data (see backtest-scores.ts).
        // Off by default; turns itself on/off weekly based on current evidence.
        if (HARD_VETO_HIGH_VOL_PARABOLIC && score.shouldBuy) {
          const vol5m    = parseFloat(dexData?.volume?.m5 || "0");
          const change5m = parseFloat(dexData?.priceChange?.m5 || "0");
          if (vol5m >= 30_000 && change5m >= 50) {
            score.shouldBuy = false; // hard veto, backtest-confirmed combo
            score.reason += ` | 🚫 Vetoed — high vol + parabolic combo (backtest-confirmed low win rate)`;
            console.log(`🚫 ${token.symbol}: Hard veto — high vol + parabolic combo`);
          }
        }

        // Funding-time cluster check — were the top holder wallets all
        // funded around the same time? That's the bot/bundle red flag
        // from the transcript, and it works even on wallets Aboki has
        // never seen before. Only run when this token would otherwise
        // signal, since it costs several extra RPC calls per wallet.
        // A confirmed cluster is a hard veto, computed BEFORE the trade
        // log below so the log reflects the real final decision.
        let holderSnapshot: Awaited<ReturnType<typeof getHolderConcentration>> = null;

        if (score.shouldBuy && score.confidence >= threshold) {
          holderSnapshot = await getHolderConcentration(token.mint, dexData?.pairAddress);

          if (!holderSnapshot) {
            // Fail CLOSED, not open — if we can't verify holder distribution
            // at all (RPC down, no API key, no data), don't send an
            // unverified signal. This was previously a silent gap: no
            // snapshot meant no check ran, and the buy went through anyway.
            score.shouldBuy = false;
            score.reason += ` | 🚫 Vetoed — holder concentration data unavailable, skipping for safety`;
            console.log(`🚫 ${token.symbol}: Hard veto — no holder data (fail-closed)`);
          } else {
            // Raw supply concentration — catches a single large holder or
            // a tight top-3 dumping together, independent of whether they
            // were funded in a cluster. Complements the funding-cluster
            // check below, which only catches coordinated *bundle* setups.
            if (holderSnapshot.topHolderPct >= TOP_HOLDER_VETO_PCT) {
              score.shouldBuy = false;
              score.reason += ` | 🚫 Vetoed — top holder owns ${holderSnapshot.topHolderPct}% of supply (>= ${TOP_HOLDER_VETO_PCT}% cap)`;
              console.log(`🚫 ${token.symbol}: Hard veto — top holder ${holderSnapshot.topHolderPct}%`);
            } else if (holderSnapshot.top3HolderPct >= TOP3_HOLDER_VETO_PCT) {
              score.shouldBuy = false;
              score.reason += ` | 🚫 Vetoed — top 3 holders own ${holderSnapshot.top3HolderPct}% combined (>= ${TOP3_HOLDER_VETO_PCT}% cap)`;
              console.log(`🚫 ${token.symbol}: Hard veto — top 3 holders ${holderSnapshot.top3HolderPct}%`);
            }
          }

          if (score.shouldBuy && holderSnapshot?.topHolderOwners?.length) {
            const fundingCluster = await detectFundingCluster(holderSnapshot.topHolderOwners);
            if (fundingCluster.isSuspicious) {
              const ages = fundingCluster.clusteredWallets.map(w => `${w.ageMinutes}m`).join(", ");
              const vetoReason = `Vetoed — ${fundingCluster.clusteredWallets.length} top-holder wallets funded within the same 15min window (ages: ${ages}) — likely bundled/bot volume`;
              score.shouldBuy = false; // hard veto, matches "stay away from those charts"
              score.reason += ` | 🚫 ${vetoReason}`;
              console.log(`🚫 ${token.symbol}: ${vetoReason}`);
            }
          }
        }

        console.log(`🤖 ${token.symbol}: ${score.confidence}% — ${score.shouldBuy ? "BUY" : "SKIP"} — ${score.reason}`);

        await generateJournalEntry(token, dexData, score);

        logTrade({
          token: token.mint,
          symbol: token.symbol,
          marketCap: mc,
          confidence: score.confidence,
          risk: score.risk,
          reason: score.reason,
          decision: score.shouldBuy && score.confidence >= threshold ? "BUY" : "SKIP",
          outcome: "PENDING",
        });

        // ── SIGNAL + RECORD CALL ──
        const lastSignal = signalCooldown.get(token.mint) || 0;
        const onCooldown = Date.now() - lastSignal < COOLDOWN_MS;

        if (score.shouldBuy && score.confidence >= threshold && !onCooldown) {
          signalCooldown.set(token.mint, Date.now());

          // Record the call for 3-day tracking
          recordCall(
            token.mint,
            token.symbol,
            token.name,
            mc,
            dexData?.priceUsd || "0",
            score.confidence,
            score.reason,
            holderSnapshot
              ? {
                  topHolderPct: holderSnapshot.topHolderPct,
                  top3HolderPct: holderSnapshot.top3HolderPct,
                  whaleCount: whaleActivity.whaleCount,
                }
              : undefined
          );

          const alert =
            `🟢 <b>TRADE SIGNAL — ABOKI</b>\n\n` +
            `Token: ${token.name} ($${token.symbol})\n` +
            `CA: <code>${token.mint}</code>\n` +
            `MC: $${mc.toFixed(0)}\n` +
            `Confidence: ${score.confidence}%\n` +
            `Risk: ${score.risk}\n` +
            `Risk Mode: ${riskProfile.currentLevel}\n` +
            (holderSnapshot ? `Top holder: ${holderSnapshot.topHolderPct}% | Top 3: ${holderSnapshot.top3HolderPct}%\n` : "") +
            `\nReason: ${score.reason}\n\n` +
            `📋 <i>Aboki will track this call and re-check on-chain data on every revisit, not just price.</i>\n\n` +
            `⚠️ Always DYOR.`;

          console.log("🚨 HIGH CONFIDENCE SIGNAL:");
          console.log(alert);
          await sendTelegramAlert(alert, process.env.TELEGRAM_BOT_TOKEN || "");
        }
      }

      updateWatchlist(tokens, dexDataMap);

      // Every 5 scans — self review + risk adjustment
      if (scanCount % 5 === 0) {
        console.log("🧠 Running self-review...");
        await selfReview();
        const risk = adjustRisk();
        console.log(`⚡ Risk profile: ${risk.currentLevel} (threshold: ${risk.confidenceThreshold}%)`);
        console.log(getStrategyReport());
        console.log(getWhaleReport());
      }

    } catch (e) {
      console.error("Trading loop error:", e);
    }
  }, 30000);
}

// ── PLUGIN EXPORT ──
export const abokiTraderPlugin: Plugin = {
  name: "aboki-trader",
  description: "Aboki autonomous Solana memecoin trading scanner",
  actions: [],
  evaluators: [],
  providers: [],
  services: [],
};

export { tradingLoop };