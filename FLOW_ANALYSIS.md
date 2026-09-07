# Aboki Trading Agent - Complete Flow Analysis

## Critical Insight ⚠️
**This agent is a SCANNER + DECISION MAKER, NOT a transaction executor.** 
- It analyzes tokens and sends Telegram alerts  
- **Actual trades are executed manually by the user** or would require external integration
- The `solanaPlugin = null` in src/index.ts confirms no on-chain execution
- Trades are logged with `outcome: PENDING` and manually updated

---

## 1. TOKEN SCANNING (Every 30 Seconds)

### Entry Point: `tradingLoop()` in src/plugins/aboki-trader.ts:154

```
START: Trading Loop Interval (30 seconds)
│
├─ STEP 1: scanPumpFun()
│  ├─ Fetch: https://api.dexscreener.com/token-profiles/latest/v1
│  ├─ Filter: chainId === "solana"
│  ├─ Take: Top 10 tokens
│  └─ Output: Array of {mint, symbol, name, usd_market_cap, created_timestamp}
│
└─ STEP 2: Loop through tokens (first 5)
```

### Filtering Criteria - Phase 1: Market Cap Range

**Criteria Check:**
```javascript
const mc = parseFloat(dexData?.marketCap || dexData?.fdv || "0");

if (mc > 0 && mc < 30000) {
  // TOO SMALL - Add to watchlist instead
  if (mc > 10000) {
    addToWatchlist(token, dexData, `MC $${mc.toFixed(0)} — growing, below threshold`);
  }
  return; // Skip scoring
}

if (mc > 500000) {
  // TOO LARGE - Reject
  console.log(`⏭️ Skipping ${token.symbol} — MC too large`);
  return;
}

// ✅ PASSES: 30K ≤ MC ≤ 500K → Continue to scoring
```

**What Gets Added to Watchlist:**
- Tokens with MC 10K-30K that show growth potential
- Status: "WATCHING" (will be promoted to "READY" when MC reaches 30K)
- Tracked in: `data/aboki-watchlist.json`

**Watchlist Status Transitions:**
```
WATCHING → READY (when MC 30K-500K reached)
       → DEAD (after 20 scans with no data OR MC crashes to <5K)
       → PROMOTED (becomes tradeable)
```

---

## 2. WHALE ANALYSIS (After Market Cap Filter Passes)

### Function: `getEarlyBuyers()` → `scoreWallet()` → `detectCoordination()`

### Step 2a: Identify Early Buyers

```javascript
// From src/plugins/aboki-whale-intel.ts:113
async function getEarlyBuyers(tokenMint: string, tokenSymbol: string): Promise<string[]> {
  // Fetch from Helius API (needs HELIUS_API_KEY)
  const res = await fetch(
    `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?...`
  );
  // Extract unique wallet addresses from first 20 SWAP transactions
  return buyers.slice(0, 10); // Top 10 earliest buyers
}
```

### Step 2b: Score Each Wallet

```javascript
// For each early buyer: scoreWallet(address, tokenMint, tokenSymbol, entryMC, secondsAfterLaunch)

// Creates/updates WalletProfile with:
{
  address: string,
  totalTrades: number,
  wins: number,
  losses: number,
  winRate: number,
  avgEntryMC: number,
  avgEntrySecondsAfterLaunch: number,  // ← KEY: How fast they entered
  coordinatedBuys: number,
  knownCoordinators: string[],
  insiderScore: number,  // ← Calculated below
  classification: "INSIDER" | "SMART_MONEY" | "RETAIL" | "UNKNOWN",
  trades: [...],
  notes: [...]
}
```

### Step 2c: Calculate Insider Score

```javascript
function calculateInsiderScore(wallet: WalletProfile): number {
  let score = 0;
  
  // 1. ENTRY TIMING (Most Important)
  if (wallet.avgEntrySecondsAfterLaunch < 30)    score += 40; // Extremely suspicious
  else if (< 120)  score += 20;   // Very fast
  else if (< 300)  score += 10;   // Fast (5 min)
  
  // 2. WIN RATE (Shows if they know what they're doing)
  if (wallet.winRate > 80)   score += 30;
  else if (> 60)  score += 15;
  
  // 3. COORDINATION PATTERN (Multiple buys with same wallets)
  if (wallet.coordinatedBuys > 5)   score += 20;
  else if (> 2)   score += 10;
  
  // 4. EARLY ENTRY MARKET CAP (Entered before MC grew)
  if (wallet.avgEntryMC < 30000)   score += 10;
  
  return Math.min(score, 100);
}

// Classification based on score:
// score >= 70  → INSIDER
// score >= 40 OR winRate > 65  → SMART_MONEY
// totalTrades > 5 AND winRate < 40  → RETAIL
// else  → UNKNOWN
```

### Step 2d: Detect Coordination

```javascript
// detectCoordination(tokenMint, tokenSymbol, buyers[], entryMC)

// Check if 2+ known whales bought SAME token in same time window
// Calculate coordination score:
// - If whales have coordinated before: +30 per pair
// - Base: +15 per whale (2+ whales)

if (coordinationScore >= 70)   verdict = "LIKELY_INSIDER"
else if (>= 40)  verdict = "POSSIBLE_COORDINATION"
else  verdict = "NORMAL"

// Log all coordination events to: data/aboki-coordination.json
```

### Step 2e: Log Whale Activity

```javascript
if (whaleActivity.hasWhales) {
  console.log(`🐋 ${token.symbol}: ${whaleActivity.whaleCount} whales | 
    ${whaleActivity.insiderCount} insiders | Recommendation: ${whaleActivity.recommendation}`);
}
```

---

## 3. AI SCORING (Groq LLM Evaluation)

### Function: `scoreToken()` in aboki-trader.ts:60

```javascript
const prompt = `
You are Aboki, an autonomous Solana memecoin trading agent.
Analyze this token and decide if it is worth buying.

TOKEN DATA:
- Name: ${token.name} (${token.symbol})
- Market Cap: $${token.usd_market_cap}
- Created: ${new Date(token.created_timestamp).toISOString()}
- Description: ${token.description}

DEX DATA:
- Price USD: $${dexData?.priceUsd}
- 5min volume: $${dexData?.volume?.m5}
- 1h volume: $${dexData?.volume?.h1}
- Price change 5m: ${dexData?.priceChange?.m5}%
- Price change 1h: ${dexData?.priceChange?.h1}%
- Liquidity: $${dexData?.liquidity?.usd}

ABOKI CURRENT RULES:  ← ⭐ ADAPTIVE!
${memory.rules.join("\n")}

RESPOND IN JSON:
{
  "shouldBuy": true,
  "confidence": 75,
  "reason": "...",
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "entryAmount": 0.1
}
`;

// API Call:
// POST https://api.groq.com/openai/v1/chat/completions
// Model: "llama-3.3-70b-versatile"
// Temperature: 0.1 (deterministic)
```

### Current Rules (from aboki-memory.json)

```javascript
DEFAULT_RULES = [
  "Never buy if market cap is below $30,000",
  "Never buy if market cap is above $500,000",
  "Never buy if liquidity is below $5,000",
  "Never buy if price change in last 5 minutes is negative",
  "Never buy if top 3 wallets hold more than 40% of supply",
  "Always check for honeypot before buying",
  "Only buy if confidence score is 72% or above",
  "Stop loss is always set at -50%",
]
```

**LLM Returns:**
```javascript
{
  shouldBuy: boolean,
  confidence: 0-100,        // How sure about this decision
  reason: string,           // Explanation
  risk: "LOW" | "MED" | "HIGH",
  entryAmount: number       // SOL amount (unused - no execution)
}
```

---

## 4. DECISION CHECKPOINT

### Conditions for BUY SIGNAL:

```javascript
// Condition 1: AI says buy AND confidence is above threshold
if (score.shouldBuy && score.confidence >= riskProfile.confidenceThreshold) {
  
  // Condition 2: Token not on 1-hour cooldown
  const lastSignal = signalCooldown.get(token.mint) || 0;
  if (Date.now() - lastSignal < COOLDOWN_MS) {
    // Skip - already signaled on this token recently
    return;
  }
  
  // ✅ GENERATE BUY SIGNAL
  signalCooldown.set(token.mint, Date.now());
}
```

### Adaptive Threshold (Risk Profile)

```javascript
// From adjustRisk() in aboki-intelligence.ts:330

const recent = trades.slice(-10);  // Last 10 trades
const winRate = (wins / recent.length) * 100;
const consecutiveLosses = count losses from end of trades array;

if (consecutiveLosses >= 3) {
  riskProfile.currentLevel = "CONSERVATIVE";
  riskProfile.confidenceThreshold = 80;  // ↑ Raise bar
}
else if (winRate >= 70 && recent.length >= 5) {
  riskProfile.currentLevel = "AGGRESSIVE";
  riskProfile.confidenceThreshold = 65;  // ↓ Lower bar
}
else {
  riskProfile.currentLevel = "NORMAL";
  riskProfile.confidenceThreshold = 72;  // Default
}
```

---

## 5. LOGGING PHASE (For ALL Analyzed Tokens)

### 5a: Journal Entry

```javascript
// Every token gets logged regardless of decision
await generateJournalEntry(token, dexData, score);

// → Writes to: data/aboki-journal.json
{
  id: `journal_${Date.now()}`,
  timestamp: new Date().toISOString(),
  type: "SIGNAL" | "WATCHLIST_UPDATE" | "STRATEGY_REVIEW" | "RISK_ADJUSTMENT",
  token: token.mint,
  symbol: token.symbol,
  marketCap: mc,
  decision: "BUY SIGNAL" | "SKIP",
  confidence: score.confidence,
  reasoning: "Scanned ${token.symbol} at MC $${mc}. Confidence: ${score.confidence}%. Decision: ${score.shouldBuy ? 'BUY' : 'SKIP'}. Reason: ${score.reason}",
  mood: "BULLISH" | "NEUTRAL" | "BEARISH",
}
```

Keep: Last 200 entries

### 5b: Trade Log

```javascript
logTrade({
  token: token.mint,
  symbol: token.symbol,
  marketCap: mc,
  confidence: score.confidence,
  risk: score.risk,
  reason: score.reason,
  decision: score.shouldBuy && score.confidence >= threshold ? "BUY" : "SKIP",
  outcome: "PENDING",  // ← Not executed yet!
});

// → Writes to: data/aboki-trades.json
{
  id: `trade_${Date.now()}`,
  timestamp: new Date().toISOString(),
  token: string,
  symbol: string,
  marketCap: number,
  confidence: number,
  risk: string,
  reason: string,
  decision: "BUY" | "SKIP",
  outcome?: "WIN" | "LOSS" | "PENDING",
  profitLoss?: number,
  lessonLearned?: string,
}
```

Keep: Last 100 entries

---

## 6. ALERT PHASE (If Confidence Meets Threshold)

### Function: `sendTelegramAlert()` in aboki-trader.ts:131

```javascript
if (score.shouldBuy && score.confidence >= threshold && !onCooldown) {
  const alert = `
🟢 TRADE SIGNAL — ABOKI

Token: ${token.name} ($${token.symbol})
CA: ${token.mint}
MC: $${mc.toFixed(0)}
Confidence: ${score.confidence}%
Risk: ${score.risk}
Risk Mode: ${riskProfile.currentLevel}

Reason: ${score.reason}

⚠️ Always DYOR.
  `;
  
  // Send to Telegram
  POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage
  {
    chat_id: TELEGRAM_CHAT_ID,
    text: alert,
    parse_mode: "HTML"
  }
}
```

**⚠️ CRITICAL: This is where the user receives the signal. The user must manually execute the trade on their Solana wallet (Phantom, Magic Eden, etc.). The agent does NOT execute transactions.**

---

## 7. WATCHLIST MANAGEMENT

### Function: `updateWatchlist()` in aboki-intelligence.ts:141

```javascript
// Every scan: check status of all watched tokens

for (const watch of watchlist) {
  const dexData = dexDataMap.get(watch.mint);
  const currentMC = parseFloat(dexData?.marketCap);
  
  // Update history
  watch.currentMC = currentMC;
  watch.scansObserved++;
  watch.mcHistory.push(currentMC);
  
  // ✅ Check if ready to trade
  if (currentMC >= 30000 && currentMC <= 500000) {
    if (watch.status === "WATCHING") {
      watch.status = "READY";
      console.log(`🚀 NOW READY TO TRADE! MC $${currentMC} (${mcGrowth}% growth)`);
    }
  }
  
  // ❌ Mark dead if crashed
  if (currentMC < 5000 && watch.scansObserved > 5) {
    watch.status = "DEAD";
  }
  
  // ⏰ Mark dead if no data for 20 scans
  if (!dexData) {
    watch.scansObserved++;
    if (watch.scansObserved > 20) {
      watch.status = "DEAD";
    }
  }
}

// → Writes to: data/aboki-watchlist.json
{
  mint: string,
  symbol: string,
  addedAt: timestamp,
  reason: string,
  initialMC: number,
  currentMC: number,
  scansObserved: number,
  mcHistory: [prev_mc, current_mc, ...],
  status: "WATCHING" | "READY" | "DEAD" | "PROMOTED",
  notes: ["..."],
}
```

---

## 8. PERIODIC SELF-REVIEW (Every 5 Scans ≈ 2.5 Minutes)

### Function: `selfReview()` in aboki-memory.ts:78

```javascript
// Only runs if trades.length >= 5
const recentTrades = trades.slice(-20);

// Build summary:
// `${timestamp}: ${decision} ${symbol} | MC: $${mc} | Confidence: ${confidence}% | Risk: ${risk} | Reason: ${reason} | Outcome: ${outcome}`

// LLM Prompt:
`
You are Aboki reviewing your own performance.

YOUR CURRENT RULES:
${currentRules}

YOUR RECENT TRADE DECISIONS:
${tradesSummary}

YOUR STATS:
- Total trades: ${totalTrades}
- Wins: ${wins}
- Losses: ${losses}
- Patterns: ${learnedPatterns.join(", ")}

TASK:
1. Analyze patterns in wins vs losses
2. Suggest new rules based on what's failing
3. Remove or modify rules that cause losses

RESPOND IN JSON:
{
  "analysis": "2-3 sentence analysis",
  "updatedRules": ["rule 1", "rule 2", ...],
  "newPatternsFound": ["pattern 1", ...],
  "lessonLearned": "key insight"
}
`;

// LLM Response Used To:
// 1. Update: aboki-memory.json with new rules
// 2. Add to learnedPatterns array
// 3. Log review to journal
```

**Example Rule Updates:**
```
OLD: "Only buy if confidence score is 72% or above"
NEW: "Only buy if confidence >= 72% AND liquidity > $10K" (if lost on low liquidity)

OLD: (no rule for whale concentration)
NEW: "Skip if top 3 wallets hold > 40% of supply" (if rugged by holders)
```

---

## 9. RISK ADJUSTMENT (Every 5 Scans)

### Function: `adjustRisk()` in aboki-intelligence.ts:307

```javascript
const recent = trades.slice(-10);  // Last 10 trades
const wins = recent.filter(t => t.outcome === "WIN").length;
const losses = recent.filter(t => t.outcome === "LOSS").length;
const winRate = (wins / recent.length) * 100;

// Count consecutive losses from END of array
let consecutiveLosses = 0;
for (let i = trades.length - 1; i >= 0; i--) {
  if (trades[i].outcome === "LOSS") consecutiveLosses++;
  else break;
}

// ADJUST PROFILE:
if (consecutiveLosses >= 3) {
  newLevel = "CONSERVATIVE";
  newThreshold = 80;  // Need 80% confidence min
  reason = "3+ consecutive losses — tightening rules";
}
else if (winRate >= 70 && recent.length >= 5) {
  newLevel = "AGGRESSIVE";
  newThreshold = 65;  // Need only 65% confidence
  reason = "70% win rate — loosening slightly";
}
else {
  newLevel = "NORMAL";
  newThreshold = 72;
  reason = "Standard conditions";
}

// → Update: data/aboki-strategy.json
{
  riskProfile: {
    currentLevel: "CONSERVATIVE" | "NORMAL" | "AGGRESSIVE",
    confidenceThreshold: number,
    recentWinRate: number,
    consecutiveLosses: number,
    lastAdjusted: timestamp,
    reason: string,
  }
}
```

---

## 10. TRADE OUTCOME TRACKING (Manual)

### Function: `updateTradeOutcome()` in aboki-memory.ts:175

```javascript
// Called AFTER user executes trade and wants to log result
updateTradeOutcome(symbol: string, outcome: "WIN" | "LOSS", profitLoss: number, lessonLearned?: string)

// Updates in trades.json:
{
  ...previous_trade_data...,
  outcome: "WIN" | "LOSS",
  profitLoss: 25.5,  // e.g., +25.5% for win, -50% for loss
  lessonLearned: "Token had weak fundamentals despite whale entry"
}

// Updates memory.json:
{
  totalTrades: memory.totalTrades + 1,
  wins: memory.wins + (outcome === "WIN" ? 1 : 0),
  losses: memory.losses + (outcome === "LOSS" ? 1 : 0),
}

// Next selfReview() will factor this into rule updates!
```

---

## 11. WHALE WIN/LOSS TRACKING

### Function: `updateWalletOutcome()` in aboki-whale-intel.ts:296

```javascript
// When a trade is closed, also update the whale wallet that was followed
updateWalletOutcome(address: string, tokenMint: string, won: boolean, profitPercent: number)

// Updates in whales.json:
{
  address: "...",
  wins: wallet.wins + (won ? 1 : 0),
  losses: wallet.losses + (won ? 0 : 1),
  winRate: (wins / totalTrades) * 100,
  insiderScore: recalculated,
  classification: reclassified,
  trades: [
    {
      tokenMint: "...",
      exitMC: calculated_from_profit,
      profitPercent: profitPercent,
      ...
    }
  ]
}
```

**This enables:**
- Following smart money whales over time
- Identifying truly profitable wallets
- Detecting when insiders stop buying (early exit signal)

---

## COMPLETE FLOW SUMMARY

```
┌─────────────────────────────────────────────────────────────┐
│ EVERY 30 SECONDS                                            │
└─────────────────────────────────────────────────────────────┘
    ↓
1️⃣ SCAN: DexScreener for new Solana tokens (top 10)
    ↓
2️⃣ FILTER: Market Cap 30K-500K range
    ↓
    ├─ MC < 30K? → Add to WATCHLIST
    ├─ MC > 500K? → SKIP
    └─ 30K ≤ MC ≤ 500K? → Continue
    ↓
3️⃣ WHALE ANALYSIS:
    • Get early buyers (Helius API)
    • Score each wallet (insider score, win rate)
    • Detect coordination (known whales buying together)
    ↓
4️⃣ AI SCORING (Groq LLM):
    • Input: Token data + DEX data + CURRENT RULES
    • Output: shouldBuy (bool), confidence (0-100), risk (L/M/H)
    ↓
5️⃣ DECISION CHECK:
    • confidence >= threshold?
    • Token not on 1h cooldown?
    ↓
6️⃣ LOGGING: ALWAYS log (regardless of decision)
    • Write to journal (aboki-journal.json)
    • Write to trades (aboki-trades.json with outcome: PENDING)
    ↓
7️⃣ ALERT: If BUY signal
    • Send Telegram alert with reason
    • ⚠️ USER must execute trade manually
    ↓
8️⃣ WATCHLIST UPDATE:
    • Check all watched tokens for MC growth
    • Promote WATCHING → READY when ready to trade
    • Mark DEAD if crashed or no data
    ↓
┌─────────────────────────────────────────────────────────────┐
│ EVERY 5 SCANS (≈ 2.5 MINUTES)                              │
└─────────────────────────────────────────────────────────────┘
    ↓
9️⃣ SELF-REVIEW:
    • LLM analyzes last 20 trades
    • Identifies winning vs losing patterns
    • Generates new rules or updates existing ones
    • → Updates aboki-memory.json
    ↓
🔟 RISK ADJUSTMENT:
    • Calculate win rate (last 10 trades)
    • Count consecutive losses
    • Adjust threshold: CONSERVATIVE (3+ losses) / NORMAL / AGGRESSIVE (70%+ wins)
    • → Updates aboki-strategy.json
    ↓
┌─────────────────────────────────────────────────────────────┐
│ MANUAL (User Input)                                         │
└─────────────────────────────────────────────────────────────┘
    ↓
USER EXECUTES TRADE (via wallet)
    ↓
USER REPORTS RESULT:
    • updateTradeOutcome(symbol, "WIN"/"LOSS", profitLoss%)
    ↓
WHALE TRACKING UPDATED:
    • updateWalletOutcome(address, mint, won, profitPercent)
    ↓
NEXT SELF-REVIEW FACTORS THIS IN → NEW RULES
    ↓
CYCLE CONTINUES...
```

---

## DATA FILES

| File | Purpose | Structure |
|------|---------|-----------|
| `data/aboki-memory.json` | Rules + stats | {rules[], totalTrades, wins, losses, learnedPatterns[]} |
| `data/aboki-trades.json` | Trade decisions | [{id, timestamp, token, symbol, MC, confidence, decision, outcome, profitLoss}] |
| `data/aboki-journal.json` | Event log | [{id, timestamp, type, token, symbol, decision, reasoning, mood}] |
| `data/aboki-strategy.json` | Strategy scoring | {strategies[], riskProfile} |
| `data/aboki-whales.json` | Wallet profiles | {wallets{address: WalletProfile}} |
| `data/aboki-coordination.json` | Coordination events | [{timestamp, tokenMint, wallets[], verdict}] |
| `data/aboki-watchlist.json` | Tokens being watched | [{mint, symbol, status, MC history}] |

---

## KEY TAKEAWAYS

1. **SCANNING**: Every 30s, checks pump.fun for tokens 30K-500K MC
2. **FILTERING**: Market cap gates, whale analysis, honeypot checks via AI
3. **DECISION**: LLM scores based on rules that evolve after every trade
4. **EXECUTION**: ❌ **NOT automatic** - user gets Telegram alert and executes manually
5. **TRACKING**: Trades logged as PENDING, then manually updated with WIN/LOSS
6. **LEARNING**: Every 5 scans, LLM reviews past trades and updates rules
7. **RISK**: Threshold adapts based on recent win rate (65-80% confidence floor)
8. **WHALE FOLLOWING**: Tracks whale wallets' performance across trades to identify true smart money

---

## Extension Points (What Would Need to be Added for Auto-Execution)

To make this actually execute trades autonomously:

1. **Add Solana Plugin**: `solanaPlugin` currently `null` in src/index.ts
2. **Wallet Integration**: 
   - Load wallet keypair from environment
   - Use @solana/web3.js for RPC calls
3. **Swap Execution**:
   - Use Jupiter or Raydium API to execute swaps
   - Calculate slippage tolerance
   - Handle transaction confirmation
4. **Stop Loss Implementation**:
   - Monitor position continuously
   - Exit at -50% loss threshold
5. **Exit Strategy**:
   - Implement take-profit at certain MC targets
   - Time-based exits (hold max X minutes)
6. **Risk Management**:
   - Position sizing based on wallet balance
   - Max loss per day/week limits
