# Code Reference: Functions That Execute Each Flow Stage

## Stage 1: Scanning
**File**: `src/plugins/aboki-trader.ts`

```javascript
// Line 154: Main loop starts here
async function tradingLoop(runtime: IAgentRuntime): Promise<void> {
  console.log("🟢 Aboki trading loop started...");
  
  setInterval(async () => {
    // Every 30 seconds:
```

**Function**: `scanPumpFun()`  
**Location**: Line 28  
**What it does**: Fetches latest Solana tokens from DexScreener
```javascript
async function scanPumpFun(): Promise<any[]> {
  const res = await fetch(
    "https://api.dexscreener.com/token-profiles/latest/v1"
  );
  const data = await res.json();
  const solTokens = Array.isArray(data)
    ? data.filter((t: any) => t.chainId === "solana").slice(0, 10)
    : [];
  // Returns: [{mint, symbol, name, usd_market_cap, created_timestamp}]
}
```

**Function**: `getTokenData(mintAddress: string)`  
**Location**: Line 45  
**What it does**: Gets token data from DexScreener (price, volume, liquidity, MC)
```javascript
async function getTokenData(mintAddress: string): Promise<any> {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
  );
  return data?.pairs?.[0] || null;
  // Returns: {priceUsd, volume, priceChange, liquidity, marketCap}
}
```

---

## Stage 2: Market Cap Filter
**File**: `src/plugins/aboki-trader.ts`  
**Location**: Line 200-210

```javascript
for (const token of tokens.slice(0, 5)) {
  const dexData = await getTokenData(token.mint);
  const mc = parseFloat(dexData?.marketCap || dexData?.fdv || "0");
  
  if (mc > 0 && mc < 30000) {
    // Add to watchlist if between 10-30K
    if (mc > 10000) {
      addToWatchlist(token, dexData, 
        `MC $${mc.toFixed(0)} — growing, below threshold`);
    }
    continue; // Skip to next token
  }
  
  if (mc > 500000) {
    console.log(`⏭️ Skipping ${token.symbol} — MC too large`);
    continue;
  }
  
  // ✅ Continues to whale analysis if 30K ≤ MC ≤ 500K
}
```

---

## Stage 3: Whale Analysis

### Sub-Stage 3a: Get Early Buyers
**File**: `src/plugins/aboki-whale-intel.ts`  
**Function**: `getEarlyBuyers(tokenMint, tokenSymbol)`  
**Location**: Line 113

```javascript
export async function getEarlyBuyers(
  tokenMint: string,
  tokenSymbol: string
): Promise<string[]> {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) return [];
  
  const res = await fetch(
    `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${heliusKey}&limit=20&type=SWAP`
  );
  const data = await res.json();
  
  const buyers: string[] = [];
  for (const tx of data) {
    if (tx.feePayer && !buyers.includes(tx.feePayer)) {
      buyers.push(tx.feePayer);
    }
  }
  
  return buyers.slice(0, 10); // Top 10 earliest buyers
}
```

**Called from**: `aboki-trader.ts` Line 218
```javascript
const earlyBuyers = await getEarlyBuyers(token.mint, token.symbol);
```

### Sub-Stage 3b: Score Wallets
**File**: `src/plugins/aboki-whale-intel.ts`  
**Function**: `scoreWallet(address, tokenMint, tokenSymbol, entryMC, secondsAfterLaunch)`  
**Location**: Line 164

```javascript
export async function scoreWallet(
  address: string,
  tokenMint: string,
  tokenSymbol: string,
  entryMC: number,
  secondsAfterLaunch: number
): Promise<WalletProfile> {
  const db = readWhaleDB();
  
  // Create or update wallet profile
  const wallet = db.wallets[address] || {
    address,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgEntryMC: entryMC,
    avgEntrySecondsAfterLaunch: secondsAfterLaunch,
    coordinatedBuys: 0,
    knownCoordinators: [],
    insiderScore: 0,
    classification: "UNKNOWN",
    trades: [],
    notes: [],
  };
  
  // Add trade to wallet history
  const trade: WalletTrade = {
    tokenMint,
    tokenSymbol,
    entryTime: new Date().toISOString(),
    entryMC,
    wasCoordinated: false,
    coordinatedWith: [],
    secondsAfterLaunch,
  };
  wallet.trades.push(trade);
  
  // Calculate insider score
  wallet.insiderScore = calculateInsiderScore(wallet);
  wallet.classification = classifyWallet(wallet);
  
  saveWhaleDB(db);
  return wallet;
}
```

**Called from**: `aboki-trader.ts` Line 223-224
```javascript
for (const buyer of earlyBuyers.slice(0, 5)) {
  await scoreWallet(buyer, token.mint, token.symbol, mc, 60);
}
```

### Sub-Stage 3c: Calculate Insider Score
**File**: `src/plugins/aboki-whale-intel.ts`  
**Function**: `calculateInsiderScore(wallet)`  
**Location**: Line 222

```javascript
function calculateInsiderScore(wallet: WalletProfile): number {
  let score = 0;
  
  // Entry timing (most important)
  if (wallet.avgEntrySecondsAfterLaunch < 30) score += 40;
  else if (wallet.avgEntrySecondsAfterLaunch < 120) score += 20;
  else if (wallet.avgEntrySecondsAfterLaunch < 300) score += 10;
  
  // Win rate
  if (wallet.winRate > 80) score += 30;
  else if (wallet.winRate > 60) score += 15;
  
  // Coordination
  if (wallet.coordinatedBuys > 5) score += 20;
  else if (wallet.coordinatedBuys > 2) score += 10;
  
  // Low avg entry MC
  if (wallet.avgEntryMC < 30000) score += 10;
  
  return Math.min(score, 100);
}
```

### Sub-Stage 3d: Detect Coordination
**File**: `src/plugins/aboki-whale-intel.ts`  
**Function**: `detectCoordination(tokenMint, tokenSymbol, buyers[], entryMC)`  
**Location**: Line 256

```javascript
export function detectCoordination(
  tokenMint: string,
  tokenSymbol: string,
  buyers: string[],
  entryMC: number
): CoordinationEvent | null {
  const db = readWhaleDB();
  
  // Find known whales
  const knownWhales = buyers.filter(addr =>
    db.wallets[addr] && db.wallets[addr].classification !== "RETAIL"
  );
  
  if (knownWhales.length < 2) return null;
  
  // Calculate coordination score
  let coordinationScore = 0;
  for (let i = 0; i < knownWhales.length; i++) {
    for (let j = i + 1; j < knownWhales.length; j++) {
      const walletA = db.wallets[knownWhales[i]];
      const walletB = db.wallets[knownWhales[j]];
      
      if (walletA?.knownCoordinators?.includes(knownWhales[j])) {
        coordinationScore += 30;
      }
    }
  }
  
  coordinationScore += knownWhales.length * 15;
  
  const insiderProbability = Math.min(coordinationScore, 100);
  
  const verdict: CoordinationEvent["verdict"] =
    insiderProbability >= 70 ? "LIKELY_INSIDER" :
    insiderProbability >= 40 ? "POSSIBLE_COORDINATION" :
    "NORMAL";
  
  const event: CoordinationEvent = {
    id: `coord_${Date.now()}`,
    timestamp: new Date().toISOString(),
    tokenMint,
    tokenSymbol,
    wallets: knownWhales,
    timeWindowSeconds: 60,
    avgEntryMC: entryMC,
    insiderProbability,
    verdict,
  };
  
  // Save event
  const events = readCoordination();
  events.push(event);
  fs.writeFileSync(COORDINATION_FILE, JSON.stringify(events.slice(-100), null, 2));
  
  return event;
}
```

**Called from**: `aboki-trader.ts` Line 227
```javascript
detectCoordination(token.mint, token.symbol, earlyBuyers, mc);
```

---

## Stage 4: AI Scoring (Groq LLM)

**File**: `src/plugins/aboki-trader.ts`  
**Function**: `scoreToken(token, dexData, runtime, rules[])`  
**Location**: Line 60

```javascript
async function scoreToken(
  token: any,
  dexData: any,
  runtime: IAgentRuntime,
  rules: string[] = []
): Promise<any> {
  const prompt = `You are Aboki, an autonomous Solana memecoin trading agent.
Analyze this token and decide if it is worth buying.

TOKEN DATA:
- Name: ${token.name} (${token.symbol})
- Market Cap: $${token.usd_market_cap}
- Created: ${new Date(token.created_timestamp).toISOString()}
- Description: ${token.description?.slice(0, 100)}

DEX DATA:
- Price USD: ${dexData?.priceUsd}
- 5min volume: $${dexData?.volume?.m5}
- 1h volume: $${dexData?.volume?.h1}
- Price change 5m: ${dexData?.priceChange?.m5}%
- Price change 1h: ${dexData?.priceChange?.h1}%
- Liquidity: $${dexData?.liquidity?.usd}
- Market Cap: $${dexData?.marketCap}

ABOKI CURRENT RULES:
${rules.length > 0 ? rules.join("\n") : "Use default safe trading rules"}

RESPOND IN JSON:
{
  "shouldBuy": true,
  "confidence": 75,
  "reason": "...",
  "risk": "LOW",
  "entryAmount": 0.1
}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_TRADING_API_KEY || process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 300,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}
```

**Called from**: `aboki-trader.ts` Line 237
```javascript
const score = await scoreToken(token, dexData, runtime, memory.rules);
```

**Rules come from**: `src/plugins/aboki-memory.ts` Line 48
```javascript
export function readMemory(): AbokiMemory {
  // Returns memory.rules array
}

// Called in trading loop (line 172):
const memory = readMemory();
console.log(`🧠 Rules: ${memory.rules.length}`);
```

---

## Stage 5: Decision Checkpoint

**File**: `src/plugins/aboki-trader.ts`  
**Location**: Line 238-256

```javascript
// Get current risk profile for threshold
const riskProfile = getRiskProfile();
const threshold = riskProfile.confidenceThreshold;

// Check conditions
if (score.shouldBuy && score.confidence >= threshold && !onCooldown) {
  signalCooldown.set(token.mint, Date.now());
  // ✅ Generate buy signal (see Stage 6)
}
```

---

## Stage 6: Logging Phase

### Sub-Stage 6a: Journal Entry
**File**: `src/plugins/aboki-intelligence.ts`  
**Function**: `generateJournalEntry(token, dexData, score)`  
**Location**: Line 92

```javascript
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
```

**Called from**: `aboki-trader.ts` Line 240
```javascript
await generateJournalEntry(token, dexData, score);
```

### Sub-Stage 6b: Trade Log
**File**: `src/plugins/aboki-memory.ts`  
**Function**: `logTrade(trade)`  
**Location**: Line 66

```javascript
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
  console.log(`📝 Logged trade decision: ${trade.decision} ${trade.symbol}`);
}
```

**Called from**: `aboki-trader.ts` Line 242-250
```javascript
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
```

---

## Stage 7: Alert

**File**: `src/plugins/aboki-trader.ts`  
**Function**: `sendTelegramAlert(message, token)`  
**Location**: Line 127

```javascript
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
```

**Called from**: `aboki-trader.ts` Line 258-266
```javascript
if (score.shouldBuy && score.confidence >= threshold && !onCooldown) {
  signalCooldown.set(token.mint, Date.now());
  const alert = `🟢 TRADE SIGNAL — ABOKI\n\nToken: ${token.name} ($${token.symbol})\n...`;
  console.log("🚨 HIGH CONFIDENCE SIGNAL:");
  console.log(alert);
  await sendTelegramAlert(alert, process.env.TELEGRAM_BOT_TOKEN || "");
}
```

---

## Stage 8: Watchlist Update

**File**: `src/plugins/aboki-intelligence.ts`  
**Function**: `updateWatchlist(tokens, dexDataMap)`  
**Location**: Line 141

```javascript
export function updateWatchlist(tokens: any[], dexDataMap: Map<string, any>): void {
  const watchlist = readWatchlist();
  if (watchlist.length === 0) return;
  
  for (const watch of watchlist) {
    if (watch.status === "DEAD" || watch.status === "PROMOTED") continue;
    
    const token = tokens.find(t => t.mint === watch.mint);
    const dexData = dexDataMap.get(watch.mint);
    
    if (!dexData) {
      watch.scansObserved++;
      if (watch.scansObserved > 20) {
        watch.status = "DEAD";
        watch.notes.push(`Died after ${watch.scansObserved} scans`);
      }
      continue;
    }
    
    const currentMC = parseFloat(dexData?.marketCap || "0");
    watch.currentMC = currentMC;
    watch.scansObserved++;
    watch.mcHistory.push(currentMC);
    
    // Check if ready to trade
    if (currentMC >= 30000 && currentMC <= 500000) {
      if (watch.status === "WATCHING") {
        watch.status = "READY";
        watch.notes.push(`READY TO TRADE at MC $${currentMC.toFixed(0)}`);
        console.log(`🚀 ${watch.symbol} is NOW READY TO TRADE!`);
      }
    }
    
    // Mark dead if crashed
    if (currentMC < 5000 && watch.scansObserved > 5) {
      watch.status = "DEAD";
      watch.notes.push(`MC crashed to $${currentMC.toFixed(0)}`);
    }
  }
  
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));
}
```

**Called from**: `aboki-trader.ts` Line 268
```javascript
updateWatchlist(tokens, dexDataMap);
```

---

## Stage 9: Self-Review

**File**: `src/plugins/aboki-memory.ts`  
**Function**: `selfReview()`  
**Location**: Line 78

```javascript
export async function selfReview(): Promise<void> {
  const trades = readTrades();
  const memory = readMemory();
  
  if (trades.length < 5) {
    console.log("🧠 Not enough trades to review yet. Need at least 5.");
    return;
  }
  
  console.log(`🧠 Aboki is reviewing his last ${trades.length} decisions...`);
  
  const recentTrades = trades.slice(-20);
  const tradesSummary = recentTrades.map(t =>
    `${t.timestamp}: ${t.decision} ${t.symbol} | MC: $${t.marketCap} | Confidence: ${t.confidence}% | Reason: ${t.reason} | Outcome: ${t.outcome}`
  ).join("\n");
  
  const currentRules = memory.rules.join("\n");
  
  const prompt = `
You are Aboki reviewing your own performance.

YOUR CURRENT RULES:
${currentRules}

YOUR RECENT TRADE DECISIONS:
${tradesSummary}

YOUR STATS:
- Total trades: ${memory.totalTrades}
- Wins: ${memory.wins}
- Losses: ${memory.losses}

TASK:
1. Analyze wins vs losses
2. Suggest updated/new rules
3. Keep working rules, remove/modify failing ones

RESPOND IN JSON:
{
  "analysis": "...",
  "updatedRules": ["rule1", "rule2"],
  "newPatternsFound": ["pattern1"],
  "lessonLearned": "..."
}`;

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
  
  // Update memory with new rules
  const updatedMemory: AbokiMemory = {
    ...memory,
    rules: result.updatedRules || memory.rules,
    learnedPatterns: [...memory.learnedPatterns, ...(result.newPatternsFound || [])].slice(-20),
    lastReviewAt: new Date().toISOString(),
  };
  
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(updatedMemory, null, 2));
  
  console.log("🧠 ABOKI SELF-REVIEW COMPLETE:");
  console.log(`📊 Analysis: ${result.analysis}`);
  console.log(`✅ Rules updated: ${result.updatedRules?.length || 0} rules`);
}
```

**Called from**: `aboki-trader.ts` Line 280
```javascript
if (scanCount % 5 === 0) {
  console.log("🧠 Running self-review...");
  await selfReview();
}
```

---

## Stage 10: Risk Adjustment

**File**: `src/plugins/aboki-intelligence.ts`  
**Function**: `adjustRisk()`  
**Location**: Line 307

```javascript
export function adjustRisk(): RiskProfile {
  const data = readStrategy();
  const trades = readTrades();
  const riskProfile: RiskProfile = data.riskProfile;
  
  if (trades.length < 5) return riskProfile;
  
  const recent = trades.slice(-10);
  const wins = recent.filter(t => t.outcome === "WIN").length;
  const losses = recent.filter(t => t.outcome === "LOSS").length;
  const winRate = recent.length > 0 ? Math.round((wins / recent.length) * 100) : 0;
  
  let consecutiveLosses = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].outcome === "LOSS") consecutiveLosses++;
    else break;
  }
  
  let newLevel = riskProfile.currentLevel;
  let newThreshold = riskProfile.confidenceThreshold;
  let reason = "";
  
  if (consecutiveLosses >= 3) {
    newLevel = "CONSERVATIVE";
    newThreshold = 80;
    reason = `${consecutiveLosses} consecutive losses`;
  } else if (winRate >= 70 && recent.length >= 5) {
    newLevel = "AGGRESSIVE";
    newThreshold = 65;
    reason = `${winRate}% win rate`;
  } else {
    newLevel = "NORMAL";
    newThreshold = 72;
    reason = "Normal conditions";
  }
  
  const updated: RiskProfile = {
    currentLevel: newLevel,
    confidenceThreshold: newThreshold,
    recentWinRate: winRate,
    consecutiveLosses,
    lastAdjusted: new Date().toISOString(),
    reason,
  };
  
  data.riskProfile = updated;
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));
  
  if (newLevel !== riskProfile.currentLevel) {
    console.log(`⚡ RISK ADJUSTED: ${riskProfile.currentLevel} → ${newLevel}`);
    console.log(`   New threshold: ${newThreshold}%`);
  }
  
  return updated;
}
```

**Called from**: `aboki-trader.ts` Line 282
```javascript
const risk = adjustRisk();
console.log(`⚡ Risk profile: ${risk.currentLevel}`);
```

---

## Stage 11: Manual Trade Outcome

**File**: `src/plugins/aboki-memory.ts`  
**Function**: `updateTradeOutcome(symbol, outcome, profitLoss, lessonLearned)`  
**Location**: Line 175

```javascript
export function updateTradeOutcome(
  symbol: string,
  outcome: "WIN" | "LOSS",
  profitLoss: number,
  lessonLearned?: string
): void {
  const trades = readTrades();
  const memory = readMemory();
  
  // Find most recent trade with this symbol
  const tradeIndex = trades.map(t => t.symbol).lastIndexOf(symbol);
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
  console.log(`📊 Trade outcome updated: ${symbol} → ${outcome}`);
}
```

---

## Stage 12: Whale Outcome Tracking

**File**: `src/plugins/aboki-whale-intel.ts`  
**Function**: `updateWalletOutcome(address, tokenMint, won, profitPercent)`  
**Location**: Line 296

```javascript
export function updateWalletOutcome(
  address: string,
  tokenMint: string,
  won: boolean,
  profitPercent: number
): void {
  const db = readWhaleDB();
  const wallet = db.wallets[address];
  if (!wallet) return;
  
  if (won) wallet.wins++;
  else wallet.losses++;
  
  wallet.winRate = wallet.totalTrades > 0
    ? Math.round((wallet.wins / wallet.totalTrades) * 100)
    : 0;
  
  // Update the specific trade
  const trade = wallet.trades.find(t => t.tokenMint === tokenMint);
  if (trade) {
    trade.profitPercent = profitPercent;
    trade.exitMC = trade.entryMC * (1 + profitPercent / 100);
  }
  
  wallet.insiderScore = calculateInsiderScore(wallet);
  wallet.classification = classifyWallet(wallet);
  
  saveWhaleDB(db);
  console.log(`📊 Wallet ${address.slice(0, 8)}... updated: ${won ? "WIN" : "LOSS"}`);
}
```

---

## Summary: Function Call Chain

```
Trading Loop Starts (30s interval)
    │
    ├─→ scanPumpFun() → Get top 10 tokens
    │       │
    │       ├─→ getTokenData() for each token (first 5)
    │       │
    │       └─→ Market Cap Filter:
    │               ├─ < 30K → addToWatchlist()
    │               ├─ > 500K → SKIP
    │               └─ 30-500K → Continue to whale analysis
    │
    ├─→ getEarlyBuyers() → Get first 10 buyers from Helius
    │       │
    │       ├─→ scoreWallet() for each buyer
    │       │       │
    │       │       └─→ calculateInsiderScore()
    │       │       └─→ classifyWallet()
    │       │
    │       └─→ detectCoordination() → Check if 2+ whales coordinated
    │
    ├─→ scoreToken() → Call Groq LLM with token data + RULES
    │       │
    │       └─→ Parse JSON response
    │
    ├─→ Decision Checkpoint:
    │   confidence >= threshold?
    │   && not on cooldown?
    │
    ├─→ ALWAYS: generateJournalEntry() → journal.json
    │
    ├─→ ALWAYS: logTrade() → trades.json (outcome: PENDING)
    │
    ├─→ IF BUY SIGNAL:
    │   └─→ sendTelegramAlert() → User gets notified
    │
    ├─→ updateWatchlist() → Check watched tokens' growth
    │
    └─→ Every 5 scans:
        ├─→ selfReview() → LLM analyzes trades, updates rules
        │       │
        │       └─→ Write NEW RULES to memory.json
        │
        ├─→ adjustRisk() → Calculate win rate, adjust threshold
        │       │
        │       └─→ Write NEW THRESHOLD to strategy.json
        │
        └─→ Generate reports (strategy, whales, watchlist)

Manual:
    User executes trade
    User reports result: updateTradeOutcome(symbol, WIN/LOSS, %)
        │
        ├─→ Updates trades.json (outcome: WIN/LOSS)
        │
        ├─→ Updates memory.json stats (wins++, losses++)
        │
        └─→ (Optional) updateWalletOutcome() → Track whale performance
```
