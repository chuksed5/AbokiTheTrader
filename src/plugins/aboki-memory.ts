import fs from "fs";
import path from "path";

const MEMORY_FILE = path.join(process.cwd(), "data", "aboki-memory.json");
const TRADES_FILE = path.join(process.cwd(), "data", "aboki-trades.json");

// ── MEMORY STRUCTURE ──
interface TradeLog {
  id: string;
  timestamp: string;
  token: string;
  symbol: string;
  marketCap: number;
  confidence: number;
  risk: string;
  reason: string;
  decision: "BUY" | "SKIP";
  outcome?: "WIN" | "LOSS" | "PENDING";
  profitLoss?: number;
  lessonLearned?: string;
}
interface AbokiMemory {
  rules: string[];
  totalTrades: number;
  wins: number;
  losses: number;
  lastReviewAt: string;
  learnedPatterns: string[];
}

// ── DEFAULT RULES ──
const DEFAULT_RULES: string[] = [
  "Never buy if market cap is below $30,000",
  "Never buy if market cap is above $500,000",
  "Never buy if liquidity is below $5,000",
  "Never buy if price change in last 5 minutes is negative",
  "Never buy if top 3 wallets hold more than 40% of supply",
  "Always check for honeypot before buying",
  "Only buy if confidence score is 72% or above",
  "Stop loss is always set at -50%",
];

// ── INITIALIZE MEMORY ──
export function initializeMemory(): void {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(MEMORY_FILE)) {
    const initialMemory: AbokiMemory = {
      rules: DEFAULT_RULES,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      lastReviewAt: new Date().toISOString(),
      learnedPatterns: [],
    };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(initialMemory, null, 2));
    console.log("易 Aboki memory initialized");
  }

  if (!fs.existsSync(TRADES_FILE)) {
    fs.writeFileSync(TRADES_FILE, JSON.stringify([], null, 2));
    console.log("📝 Aboki trade log initialized");
  }
}

// ── READ MEMORY ──
export function readMemory(): AbokiMemory {
  try {
    const data = fs.readFileSync(MEMORY_FILE, "utf-8");
    return JSON.parse(data);
  } catch (e) {
    return {
      rules: DEFAULT_RULES,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      lastReviewAt: new Date().toISOString(),
      learnedPatterns: [],
    };
  }
}

// ── READ TRADES ──
export function readTrades(): TradeLog[] {

  try {

    const data = fs.readFileSync(TRADES_FILE, "utf-8");

    const parsed = JSON.parse(data);

    return Array.isArray(parsed) ? parsed : [];

  } catch (e) {

    return [];

  }

}

// ── LOG A TRADE DECISION ──
export function logTrade(trade: Omit<TradeLog, "id" | "timestamp">): void {
  const trades = readTrades();
  const newTrade: TradeLog = {
    id: `trade_${Date.now()}`,
    timestamp: new Date().toISOString(),
    ...trade,
  };
  trades.push(newTrade);
  // Keep only last 100 trades
  const recent = trades.slice(-100);
  fs.writeFileSync(TRADES_FILE, JSON.stringify(recent, null, 2));
  console.log(`📝 Logged trade decision: ${trade.decision} ${trade.symbol} (${trade.confidence}% confidence)`);
}

// ── SELF REVIEW — THE LEARNING ENGINE ──
export async function selfReview(): Promise<void> {
  const trades = readTrades();
  const memory = readMemory();

  // Only review if we have at least 5 trades
  if (trades.length < 5) {
    console.log("易 Not enough trades to review yet. Need at least 5.");
    return;
  }

  console.log(`易 Aboki is reviewing his last ${trades.length} decisions...`);

  const recentTrades = trades.slice(-20);
  const tradesSummary = recentTrades.map(t =>
    `${t.timestamp}: ${t.decision} ${t.symbol} | MC: $${t.marketCap} | Confidence: ${t.confidence}% | Risk: ${t.risk} | Reason: ${t.reason} | Outcome: ${t.outcome || "PENDING"}`
  ).join("\n");

  const currentRules = memory.rules.join("\n");

  const prompt = `
You are Aboki, an autonomous Solana memecoin trading agent reviewing your own performance.

YOUR CURRENT RULES:
${currentRules}

YOUR RECENT TRADE DECISIONS:
${tradesSummary}

YOUR STATS:
- Total trades: ${memory.totalTrades}
- Wins: ${memory.wins}
- Losses: ${memory.losses}
- Learned patterns so far: ${memory.learnedPatterns.join(", ") || "none yet"}

TASK:
1. Analyze your recent decisions carefully
2. Find patterns in what led to good vs bad decisions
3. Suggest updated or new rules based on what you learned
4. Keep rules that are working, remove or modify rules that are causing losses

RESPOND IN THIS EXACT JSON FORMAT ONLY:
{
  "analysis": "2-3 sentence analysis of your performance",
  "updatedRules": ["rule 1", "rule 2", "rule 3"],
  "newPatternsFound": ["pattern 1", "pattern 2"],
  "lessonLearned": "one key lesson from this review"
}
`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 1000,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);

    // Update memory with new rules and patterns
    const updatedMemory: AbokiMemory = {
      ...memory,
      rules: result.updatedRules || memory.rules,
      learnedPatterns: [
        ...memory.learnedPatterns,
        ...(result.newPatternsFound || []),
      ].slice(-20), // keep last 20 patterns
      lastReviewAt: new Date().toISOString(),
    };

    fs.writeFileSync(MEMORY_FILE, JSON.stringify(updatedMemory, null, 2));

    console.log("易 ABOKI SELF-REVIEW COMPLETE:");
    console.log(`📊 Analysis: ${result.analysis}`);
    console.log(`📚 Lesson: ${result.lessonLearned}`);
    console.log(`✅ Rules updated: ${result.updatedRules?.length || 0} rules`);
    console.log(`🔍 New patterns found: ${result.newPatternsFound?.join(", ") || "none"}`);

  } catch (e) {
    console.error("Self-review error:", e);
  }
}

// ── UPDATE TRADE OUTCOME ──
export function updateTradeOutcome(
  tokenMint: string,
  symbol: string,
  outcome: "WIN" | "LOSS",
  profitLoss: number,
  lessonLearned?: string
): void {
  const trades = readTrades();
  const memory = readMemory();

  // Find the most recent PENDING trade for this exact token mint
  // (falls back to symbol match for older logs that predate mint tracking)
  let tradeIndex = trades
    .map(t => (t.token === tokenMint && t.outcome === "PENDING" ? t.token : null))
    .lastIndexOf(tokenMint);
  if (tradeIndex === -1) {
    tradeIndex = trades.map(t => t.symbol).lastIndexOf(symbol);
  }
  if (tradeIndex !== -1) {
    trades[tradeIndex].outcome = outcome;
    trades[tradeIndex].profitLoss = profitLoss;
    trades[tradeIndex].lessonLearned = lessonLearned;
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  }

  // Update stats
  const updatedMemory: AbokiMemory = {
    ...memory,
    totalTrades: memory.totalTrades + 1,
    wins: outcome === "WIN" ? memory.wins + 1 : memory.wins,
    losses: outcome === "LOSS" ? memory.losses + 1 : memory.losses,
  };
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(updatedMemory, null, 2));
console.log(`📊 Trade outcome updated: ${symbol} → ${outcome} (${profitLoss > 0 ? "+" : ""}${profitLoss}%)`);
}