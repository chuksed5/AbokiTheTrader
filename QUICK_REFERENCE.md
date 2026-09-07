# Quick Reference: Token Flow After Passing Criteria

## STAGE 1: Market Cap Filter ✓
```
Token arrives from pump.fun scan
         ↓
    What's the MC?
         ↓
    ┌────┴────┬─────────┐
    ↓         ↓         ↓
  < 30K    30-500K    > 500K
    ↓         ↓         ↓
  WATCH     SCORE     ❌ SKIP
    ↓         
    Add to                
  watchlist
  Watch MC growth
  until 30K-500K
  reached
```

## STAGE 2: Whale Analysis ✓
```
Token in 30K-500K range
         ↓
Get early buyers (Helius API)
         ↓
For each buyer:
  • When did they enter? (seconds after launch)
  • How many wins? (historical track record)
  • Do they coordinate with others?
         ↓
Calculate Insider Score:
  < 30 sec entry     → +40 pts
  Win rate > 80%     → +30 pts
  Coordinated buys   → +10-20 pts
  Early MC entry     → +10 pts
         ↓
Classify Wallet:
  Score >= 70        → INSIDER 🚨
  Score >= 40        → SMART_MONEY
  Else               → RETAIL / UNKNOWN
         ↓
Detect Coordination:
  Are 2+ known whales buying SAME token?
  Calculate insider probability
  Verdict: LIKELY_INSIDER / POSSIBLE_COORD / NORMAL
         ↓
Log all to: aboki-whales.json
Track wallet stats for future trades
```

## STAGE 3: AI Scoring ✓
```
All token data fed to Groq LLM
         ↓
Include in prompt:
  • Token metadata (name, symbol, MC, description)
  • Price action (5m volume, 1h volume, % change)
  • Liquidity amount
  • ⭐ CURRENT ADAPTIVE RULES from memory
  • (Optional) Whale analysis results
         ↓
LLM evaluates against rules:
  ✓ MC 30K-500K?
  ✓ Liquidity >= $5K?
  ✓ 5m price change >= 0%?
  ✓ Top 3 wallets <= 40%?
  ✓ No honeypot?
  ✓ Confidence >= threshold?
         ↓
LLM Returns:
  {
    shouldBuy: true/false,
    confidence: 0-100%,
    reason: "...",
    risk: "LOW" | "MEDIUM" | "HIGH",
    entryAmount: SOL
  }
```

## STAGE 4: Decision Checkpoint ✓
```
Does shouldBuy = true AND confidence >= threshold?
         ↓
    ┌────NO────┬────YES────┐
    ↓          ↓
  SKIP      Is token on
    ↓      1-hour cooldown?
  Log        ↓
  SKIP    ┌──NO──┬──YES──┐
    →     ↓      ↓
  Journal SIGNAL SKIP
  Entry  Create  →
         BUY     Journal
         SIGNAL  Entry
            ↓
```

## STAGE 5: Logging (ALWAYS Happens) ✓
```
Every analyzed token:
         ↓
Write to journal.json:
  {
    type: "SIGNAL",
    token: mint,
    symbol: "TOKEN",
    decision: "BUY SIGNAL" or "SKIP",
    confidence: 75,
    reasoning: "...",
    mood: "BULLISH" | "NEUTRAL"
  }
         ↓
Write to trades.json:
  {
    id: "trade_${timestamp}",
    token: mint,
    symbol: "TOKEN",
    marketCap: 45000,
    confidence: 75,
    decision: "BUY" | "SKIP",
    outcome: "PENDING",  ← Stays pending until manually updated!
    profitLoss: null,
    lessonLearned: null
  }
         ↓
Keep last 200 journal entries
Keep last 100 trade entries
```

## STAGE 6: Alert (If BUY Signal) ✓
```
IF decision = BUY SIGNAL:
         ↓
Send Telegram message:
  ┌────────────────────────────┐
  │ 🟢 TRADE SIGNAL — ABOKI    │
  │ Token: NAME ($SYMBOL)      │
  │ CA: mint...                │
  │ MC: $45,000                │
  │ Confidence: 75%            │
  │ Risk: LOW                  │
  │ Reason: [AI reasoning]     │
  │ ⚠️ Always DYOR             │
  └────────────────────────────┘
         ↓
⚠️ USER RECEIVES ALERT
   User must execute trade manually
   (No auto-execution in this agent)
         ↓
User opens wallet (Phantom, Magic Eden, etc)
User buys token with SOL
User confirms transaction
```

## STAGE 7: Watchlist Update ✓
```
Every scan: update all watched tokens
         ↓
For each token in watchlist:
         ↓
Get current MC from DexScreener
         ↓
Update:
  • currentMC
  • mcHistory (rolling history)
  • scansObserved++
         ↓
    Is MC in 30K-500K range?
         ↓
    ┌──YES──┬────NO────┐
    ↓       ↓          ↓
  READY  Still < 30K  MC < 5K?
    ↓      ↓           ↓
  Promote Monitor   DEAD
  status  (more     (mark
  to READY scans)   dead)
         ↓
    No data for 20 scans?
         ↓
      MARK DEAD
      (token disappeared)
```

## STAGE 8: Periodic Review (Every 5 Scans ≈ 2.5 min) ✓
```
Enough trades to review? (>= 5)
         ↓
    YES ↓
       selfReview()
         ↓
LLM analyzes LAST 20 TRADES:
  • What led to WINS?
  • What led to LOSSES?
  • Any patterns?
         ↓
LLM generates/updates RULES:
  New rule examples:
    • "Skip if top 3 wallets > 45% (was >40%)"
    • "Only buy if whale holds > 5 min"
    • "Check volume/price for rug signs"
         ↓
Update: aboki-memory.json
  {
    rules: [old_rules..., new_rules...],
    learnedPatterns: [...],
    lastReviewAt: timestamp
  }
         ↓
Next score() call will use NEW RULES! ⭐
This is how agent adapts!
```

## STAGE 9: Risk Adjustment (Every 5 Scans) ✓
```
Calculate from LAST 10 TRADES:
         ↓
    ┌─────────────────────┐
    │ Win Rate Calc       │
    │ Wins / Total = %    │
    └─────────────────────┘
         ↓
    ┌─────────────────────┐
    │ Consecutive Losses? │
    │ Count from end...   │
    └─────────────────────┘
         ↓
    Adjust Threshold:
    ┌─────────────────────┐
    │ >= 3 consecutive L  │
    │ → CONSERVATIVE      │
    │ → threshold = 80%   │
    │ → Need more conf!   │
    └─────────────────────┘
         ↓
    ┌─────────────────────┐
    │ >= 70% win rate     │
    │ → AGGRESSIVE        │
    │ → threshold = 65%   │
    │ → Can trade lower   │
    └─────────────────────┘
         ↓
    ┌─────────────────────┐
    │ Else                │
    │ → NORMAL            │
    │ → threshold = 72%   │
    │ → Default           │
    └─────────────────────┘
         ↓
Update: aboki-strategy.json
  {
    riskProfile: {
      currentLevel: "CONSERVATIVE|NORMAL|AGGRESSIVE",
      confidenceThreshold: 65|72|80,
      recentWinRate: %,
      consecutiveLosses: #,
      reason: "..."
    }
  }
         ↓
NEXT LOOP uses NEW THRESHOLD! ⭐
```

## STAGE 10: Manual Trade Outcome (User Input) ✓
```
User executed trade from Telegram alert
User sees result (win or loss)
         ↓
User calls: updateTradeOutcome(symbol, "WIN"/"LOSS", profitLoss%)
         ↓
Updates trades.json:
  {
    ...previous_data...,
    outcome: "WIN",        ← Was PENDING!
    profitLoss: 45.5,      ← e.g., +45.5%
    lessonLearned: "Strong whale entry, good liquidity"
  }
         ↓
Updates memory.json stats:
  {
    totalTrades: incremented,
    wins: incremented (if WIN),
    losses: incremented (if LOSS)
  }
         ↓
(Optional) updateWalletOutcome():
  Update the whale that was followed:
  {
    address: "...",
    wins: incremented,
    winRate: recalculated,
    insiderScore: recalculated
  }
         ↓
NEXT selfReview() (in ~2 scans):
  • Factors this trade into analysis
  • May generate new rules based on outcome
  • Example: "If whale from early_wallet, ALWAYS follow"
```

## Data Flow Summary

```
┌────────────────────────┐
│ Raw Token from Scan    │
└──────────┬─────────────┘
           ↓
    ┌──────────────┐
    │ Market Cap   │
    │ Filter       │
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │ Whale        │
    │ Analysis     │
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │ AI Score     │
    │ (LLM)        │
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │ Decision     │
    │ Check        │
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │ LOGGING      │ ← Always happens
    │ + ALERT      │ ← If qualified
    └──────┬───────┘
           ↓
┌──────────────────────┐
│ aboki-journal.json   │ ← All events
│ aboki-trades.json    │ ← All decisions
│ aboki-whales.json    │ ← Wallet profiles
│ aboki-watchlist.json │ ← Growing tokens
│ aboki-memory.json    │ ← Rules + stats
│ aboki-strategy.json  │ ← Risk profile
└──────────────────────┘
           ↓
    ┌──────────────┐
    │ Periodic     │
    │ Reviews      │ ← Every 5 scans
    │ (LLM)        │
    └──────┬───────┘
           ↓
    ┌──────────────┐
    │ Rule         │
    │ Updates      │ ← Agent learns!
    └──────┬───────┘
           ↓
    (Rules feed back into AI Scoring)
```

---

## Key Rules That Get Updated

### Default Rules (Start):
```
1. Never buy if market cap is below $30,000
2. Never buy if market cap is above $500,000
3. Never buy if liquidity is below $5,000
4. Never buy if price change in last 5 minutes is negative
5. Never buy if top 3 wallets hold more than 40% of supply
6. Always check for honeypot before buying
7. Only buy if confidence score is 72% or above
8. Stop loss is always set at -50%
```

### Example Rule Evolution:
```
After first loss (e.g., -50% rug):
  Analysis: "Bought token with 61% held by top 3 wallets"
  New Rule: "Skip if top 3 wallets > 40% of supply" ← Added!
  
After second loss (e.g., weak liquidity):
  Analysis: "Token had only $2K liquidity, wide spreads"
  Updated Rule: "Never buy if liquidity < $10,000" ← Stricter!
  
After winning streak (3 wins):
  Analysis: "Whale-following strategy working"
  New Rule: "Prioritize tokens where insiders buying"
  Confidence Threshold: 65% (more aggressive) ← Lowered!
```

---

## What Happens AFTER Token Qualifies

```
QUALIFIED TOKEN
      ↓
  ┌─────────────────────────────────────┐
  │ ✅ PASSES ALL CRITERIA              │
  │ - MC in range                       │
  │ - Whale analysis done               │
  │ - AI scored high confidence         │
  └─────────────────────────────────────┘
      ↓
      ├─→ Logged to journal.json
      │
      ├─→ Logged to trades.json
      │   outcome: PENDING (not executed yet!)
      │
      ├─→ Telegram alert sent to user
      │   "🟢 TRADE SIGNAL — ABOKI"
      │
      ├─→ Added to cooldown (1 hour)
      │   Won't get alerted again for this token
      │
      └─→ Awaits user action
          User receives message
          User manually buys on wallet
          User reports result: WIN/LOSS
          Rule updates happen next review cycle
```

---

## Critical: NO AUTOMATIC EXECUTION

```
❌ Agent does NOT:
   - Connect to wallet
   - Submit transactions
   - Execute swaps automatically
   - Exit positions automatically
   - Manage stop losses automatically

✅ Agent DOES:
   - Scan for tokens
   - Analyze & score
   - Send Telegram alerts
   - Log all decisions
   - Learn from outcomes
   - Update rules dynamically

🧑‍💼 User DOES:
   - Receive Telegram alert
   - Execute trade manually
   - Report result (WIN/LOSS)
   - Get benefit of agent's learning
```

To add auto-execution would require:
- Solana RPC connection
- Wallet keypair management
- Jupiter/Raydium swap integration
- Transaction confirmation handling
- Stop-loss monitoring
- Take-profit targets
