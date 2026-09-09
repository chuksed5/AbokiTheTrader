// ─────────────────────────────────────────────────────────────
// Backtest-tunable score constants.
//
// This file is the ONLY thing scripts/backtest.mjs ever patches.
// It is imported by both aboki-trader.ts (for the vol/parabolic/
// dumping penalties, applied inside scoreTokenDeterministic) and
// aboki-narrative.ts (for the oversaturated/community adjustment,
// applied inside getCoinQualityAdjustment).
//
// Do not hand-edit the values inside the START/END markers while
// the backtest cron is active — it will overwrite them on the
// next run. Edit MAX_ADJ_STEP/SCORE_MIN/SCORE_MAX in backtest.mjs
// instead if you want to change how aggressively it tunes.
//
// Two features from the backtest analysis are intentionally NOT
// wired in below — see NOTE at the bottom.
// ─────────────────────────────────────────────────────────────

// BACKTEST_SCORES_START — auto-updated by scripts/backtest.mjs
// Last run: 2026-09-08 (server) | Closed calls: 389 | Hit rate: 26% (103W/286L)
export const HIGH_VOL_PENALTY = 0;          // 5m vol >= $30k ("could be late") — tuned from 5, -11% impact on 166 samples
export const PARABOLIC_PENALTY = -5;        // 5m change >= 50% ("parabolic")
export const DUMPING_PENALTY = -12;         // 5m change < -10% ("dumping")
export const OVERSATURATED_PENALTY = -10;   // ticker has many prior Solana pairs
export const COMMUNITY_BOOST = 10;          // has socials/website (LIKELY_COMMUNITY)
// BACKTEST_SCORES_END

// Raw supply-concentration hard vetoes — not yet backtest-tuned (need real
// veto/no-veto outcome data first), but grounded in the 20-25% single-wallet
// risk threshold widely used for pump.fun dev/bundle-dump detection.
export const TOP_HOLDER_VETO_PCT = 25;   // any single wallet owning >= this % blocks the buy
export const TOP3_HOLDER_VETO_PCT = 35;  // top 3 combined owning >= this % blocks the buy

// BACKTEST_CONFIDENCE_FLOOR_START — auto-updated by scripts/backtest.mjs
// Hard floor on the confidence threshold, sourced from cumulative real
// win-rate data (not the live risk-profile system's short-window reaction).
// Can only ever raise the effective bar, never lower it below what the
// live system already wants — see analyseConfidenceFloor() in backtest.mjs.
// Last run: never (default matches the original NORMAL threshold)
export const MIN_CONFIDENCE_FLOOR = 72;
// BACKTEST_CONFIDENCE_FLOOR_END

// BACKTEST_COMBO_VETO_START — auto-updated by scripts/backtest.mjs
// Last run: 2026-09-08 (server) | Combo samples: 35 | Combo win rate: 14%
// Still OFF — 14% is well above the 5% max win-rate bar required to veto.
export const HARD_VETO_HIGH_VOL_PARABOLIC = false;
// BACKTEST_COMBO_VETO_END

// NOTE — not auto-applied by the backtest harness:
//
// NARRATIVE_BOOST: narrative boost isn't a flat number in the code —
// it's a formula (round(avgStrength/100 * 25), capped at 25) inside
// getNarrativeBoost(). The backtest still reports win-rate impact for
// narrative matches, it just can't auto-tune a single constant here
// without fighting that formula.
//
// HIGH_CONCENTRATION_PENALTY: entry top-holder % is currently only
// fetched AFTER a token already clears the buy threshold, to avoid
// extra RPC calls on every candidate. There's nothing to subtract
// from yet. The backtest still reports the win-rate impact of high
// concentration (as a veto signal) so you can see it, but applying
// it for real means checking concentration earlier for every
// candidate — a deliberate cost/latency tradeoff, not a small patch.
