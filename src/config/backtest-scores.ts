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
// Last run: never (defaults match the original hardcoded values)
export const HIGH_VOL_PENALTY = 5;          // 5m vol >= $30k ("could be late")
export const PARABOLIC_PENALTY = -5;        // 5m change >= 50% ("parabolic")
export const DUMPING_PENALTY = -12;         // 5m change < -10% ("dumping")
export const OVERSATURATED_PENALTY = -10;   // ticker has many prior Solana pairs
export const COMMUNITY_BOOST = 10;          // has socials/website (LIKELY_COMMUNITY)
// BACKTEST_SCORES_END

// BACKTEST_COMBO_VETO_START — auto-updated by scripts/backtest.mjs
// A hard veto (blocks the buy outright) is only ever turned on here once
// there are at least 25 closed calls that hit BOTH conditions together
// AND the combined win rate is <=5%. Below that bar this stays false —
// see analyseComboVeto() in backtest.mjs for the exact check re-run
// every week against current data. This is not a one-way ratchet: if
// later data no longer supports it, the next run turns it back off.
// Last run: never (no combo data evaluated yet)
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
