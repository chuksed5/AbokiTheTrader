import fs from "fs";
import path from "path";
import { OVERSATURATED_PENALTY, COMMUNITY_BOOST } from "../config/backtest-scores.ts";

const NARRATIVE_FILE = path.join(process.cwd(), "data", "aboki-narratives.json");

// ── TAVILY KEY ROTATION ──
// Load up to 3 Tavily API keys. When one hits its credit limit (HTTP 429
// or a "credit" error in the response), the pool rotates to the next key
// automatically — no restart needed. With 3 keys × 1,000 free credits
// each = 3,000 credits/month. At a 1-hour refresh interval (1 call/refresh),
// that's ~720 credits/month — well inside the combined pool.
const TAVILY_KEYS: string[] = [
  process.env.TAVILY_API_KEY_1 || process.env.TAVILY_API_KEY || "",
  process.env.TAVILY_API_KEY_2 || "",
  process.env.TAVILY_API_KEY_3 || "",
].filter(k => k.trim() !== "");

// Tracks which keys are exhausted so we don't retry them until next session
const exhaustedKeys = new Set<string>();

// Which key index we're currently using
let activeKeyIndex = 0;

function getActiveKey(): string | null {
  // Cycle through keys starting from activeKeyIndex, skip exhausted ones
  for (let i = 0; i < TAVILY_KEYS.length; i++) {
    const idx = (activeKeyIndex + i) % TAVILY_KEYS.length;
    if (!exhaustedKeys.has(TAVILY_KEYS[idx])) {
      activeKeyIndex = idx;
      return TAVILY_KEYS[idx];
    }
  }
  return null; // all keys exhausted
}

function markKeyExhausted(key: string): void {
  exhaustedKeys.add(key);
  console.warn(`⚠️ Tavily key ...${key.slice(-6)} exhausted — rotating to next key`);
  const remaining = TAVILY_KEYS.length - exhaustedKeys.size;
  console.log(`🔑 Tavily keys remaining: ${remaining}/${TAVILY_KEYS.length}`);
  if (remaining === 0) {
    console.error("🚨 All Tavily API keys exhausted — narrative refresh disabled until next month");
  }
}

function isExhaustedError(status: number, body: any): boolean {
  if (status === 429) return true;
  // Tavily returns 200 with an error field when credits run out
  const msg = (body?.error || body?.message || body?.detail || "").toLowerCase();
  return msg.includes("credit") || msg.includes("quota") || msg.includes("limit");
}

// ── INTERFACES ──
interface Narrative {
  keyword: string;
  category: string;
  strength: number;       // 1–100, how hot is this narrative right now
  source: string;
  detectedAt: string;
  expiresAt: string;      // narratives expire after 2 hours
}

interface NarrativeState {
  lastFetched: string;
  narratives: Narrative[];
}

// ── READ / WRITE ──
function readNarratives(): NarrativeState {
  try {
    return JSON.parse(fs.readFileSync(NARRATIVE_FILE, "utf-8"));
  } catch {
    return { lastFetched: "", narratives: [] };
  }
}

function writeNarratives(state: NarrativeState): void {
  fs.writeFileSync(NARRATIVE_FILE, JSON.stringify(state, null, 2));
}

// ── KEYWORD EXTRACTOR ──
// Takes raw Tavily search text and pulls out crypto narrative keywords
function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();

  // Broad keyword patterns relevant to memecoin narratives
  const patterns = [
    // Animals
    /\b(penguin|duck|frog|pepe|dog|cat|doge|shib|wolf|bear|bull|ape|monkey|fish|shark|whale|rabbit|hamster|turtle|snake|bird|eagle|owl|fox|panda)\b/g,
    // Themes
    /\b(ai agent|artificial intelligence|meme|rwa|real world asset|defi|nft|gaming|metaverse|layer2|layer 2|zk|zero knowledge|restaking|lsd|liquid staking)\b/g,
    // Cultural references
    /\b(trump|elon|musk|white house|military|army|based|chad|sigma|gigachad|wojak|karen|boomer|zoomer)\b/g,
    // Solana specific
    /\b(pump\.fun|solana|sol|jupiter|raydium|bonk|wif|dogwifhat|popcat|bome|book of meme)\b/g,
    // Trending concepts
    /\b(hyperliquid|monad|berachain|movement|sonic|abstract|megaeth|eclipse)\b/g,
  ];

  const keywords = new Set<string>();
  for (const pattern of patterns) {
    const matches = lower.match(pattern) || [];
    for (const match of matches) {
      keywords.add(match.trim());
    }
  }

  return Array.from(keywords);
}

// ── CATEGORIZE KEYWORD ──
function categorizeKeyword(keyword: string): string {
  const animals = ["penguin", "duck", "frog", "pepe", "dog", "cat", "doge", "shib", "wolf", "ape", "monkey", "fish", "shark", "rabbit", "hamster", "turtle", "snake", "bird", "eagle", "owl", "fox", "panda", "bear", "bull", "bonk", "wif", "popcat"];
  const ai = ["ai agent", "artificial intelligence"];
  const defi = ["rwa", "real world asset", "defi", "restaking", "lsd", "liquid staking", "jupiter", "raydium"];
  const culture = ["trump", "elon", "musk", "white house", "military", "army", "based", "chad", "sigma"];
  const tech = ["layer2", "layer 2", "zk", "zero knowledge", "nft", "gaming", "metaverse", "monad", "berachain", "movement", "sonic", "abstract", "megaeth", "eclipse", "hyperliquid"];

  if (animals.some(a => keyword.includes(a))) return "ANIMAL_MEME";
  if (ai.some(a => keyword.includes(a))) return "AI_NARRATIVE";
  if (defi.some(a => keyword.includes(a))) return "DEFI_NARRATIVE";
  if (culture.some(a => keyword.includes(a))) return "CULTURE_NARRATIVE";
  if (tech.some(a => keyword.includes(a))) return "TECH_NARRATIVE";
  return "GENERAL";
}

// ── FETCH NARRATIVES FROM TAVILY ──
async function fetchNarrativesFromTavily(): Promise<Narrative[]> {
  if (TAVILY_KEYS.length === 0) {
    console.log("⚠️ Narrative: No TAVILY_API_KEY set — skipping narrative fetch");
    return [];
  }

  const apiKey = getActiveKey();
  if (!apiKey) {
    console.log("⚠️ Narrative: All Tavily keys exhausted — skipping until next month");
    return [];
  }

  // Single combined query per refresh.
  // 1 call/refresh × 24 refreshes/day (at 1h interval) × 30 days = 720 credits/month
  // 3 keys × 1,000 credits = 3,000 combined — comfortable headroom.
  const query = "trending solana memecoin narrative crypto pump today";

  const allKeywords = new Set<string>();
  const sources: string[] = [];

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 7,
        include_answer: true,
      }),
    });

    const data = await res.json();

    // Check for exhaustion before trying to read results
    if (isExhaustedError(res.status, data)) {
      markKeyExhausted(apiKey);
      // Retry immediately with the next key (one retry — don't recurse infinitely)
      const nextKey = getActiveKey();
      if (!nextKey) return [];
      console.log(`🔄 Retrying with next Tavily key ...${nextKey.slice(-6)}`);
      const retryRes = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: nextKey,
          query,
          search_depth: "basic",
          max_results: 7,
          include_answer: true,
        }),
      });
      const retryData = await retryRes.json();
      if (isExhaustedError(retryRes.status, retryData)) {
        markKeyExhausted(nextKey);
        return [];
      }
      const retryText = [
        retryData.answer || "",
        ...(retryData.results || []).map((r: any) => `${r.title} ${r.content}`),
      ].join(" ");
      extractKeywords(retryText).forEach(k => allKeywords.add(k));
      (retryData.results || []).slice(0, 3).map((r: any) => r.url).forEach((u: string) => sources.push(u));
    } else {
      const combinedText = [
        data.answer || "",
        ...(data.results || []).map((r: any) => `${r.title} ${r.content}`),
      ].join(" ");
      extractKeywords(combinedText).forEach(k => allKeywords.add(k));
      (data.results || []).slice(0, 3).map((r: any) => r.url).forEach((u: string) => sources.push(u));
    }

    console.log(`🧭 Tavily fetch OK (key ...${apiKey.slice(-6)}) — ${allKeywords.size} keywords found`);

  } catch (e) {
    console.error("Tavily fetch error:", e);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours

  // Build narrative objects — strength based on how many queries picked it up
  const keywordCounts = new Map<string, number>();
  for (const keyword of allKeywords) {
    keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
  }

  const narratives: Narrative[] = [];
  for (const [keyword, count] of keywordCounts.entries()) {
    narratives.push({
      keyword,
      category: categorizeKeyword(keyword),
      strength: Math.min(100, count * 30 + 40), // base 40, +30 per extra query hit
      source: sources[0] || "tavily",
      detectedAt: now.toISOString(),
      expiresAt,
    });
  }

  // Sort by strength descending
  return narratives.sort((a, b) => b.strength - a.strength);
}

// ── INITIALIZE ──
export function initializeNarrativeTracker(): void {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(NARRATIVE_FILE)) {
    writeNarratives({ lastFetched: "", narratives: [] });
    console.log("🧭 Narrative tracker initialized");
  }
}

// ── REFRESH NARRATIVES (call every 30 mins) ──
export async function refreshNarratives(): Promise<void> {
  console.log("🧭 Fetching trending narratives via Tavily...");
  const narratives = await fetchNarrativesFromTavily();

  if (narratives.length === 0) {
    console.log("🧭 No narratives found this cycle");
    return;
  }

  writeNarratives({
    lastFetched: new Date().toISOString(),
    narratives,
  });

  const top5 = narratives.slice(0, 5).map(n => `${n.keyword}(${n.strength})`).join(", ");
  console.log(`🧭 Narratives updated — Top: ${top5}`);
}

// ── GET ACTIVE NARRATIVES (non-expired) ──
export function getActiveNarratives(): Narrative[] {
  const state = readNarratives();
  const now = new Date();
  return state.narratives.filter(n => new Date(n.expiresAt) > now);
}

// ── SCORE TOKEN AGAINST NARRATIVES ──
// Returns a boost value (0–25) to add to the token's confidence score
export function getNarrativeBoost(tokenName: string, tokenSymbol: string, tokenDescription: string): {
  boost: number;
  matchedNarratives: string[];
} {
  const narratives = getActiveNarratives();
  if (narratives.length === 0) return { boost: 0, matchedNarratives: [] };

  const searchText = `${tokenName} ${tokenSymbol} ${tokenDescription}`.toLowerCase();
  const matched: Narrative[] = [];

  for (const narrative of narratives) {
    if (searchText.includes(narrative.keyword)) {
      matched.push(narrative);
    }
  }

  if (matched.length === 0) return { boost: 0, matchedNarratives: [] };

  // Boost = average strength of matched narratives, scaled to max 25 points
  const avgStrength = matched.reduce((sum, n) => sum + n.strength, 0) / matched.length;
  const boost = Math.round((avgStrength / 100) * 25);

  return {
    boost,
    matchedNarratives: matched.map(n => `${n.keyword}(${n.category})`),
  };
}

// ── NARRATIVE SUMMARY (for logs/reports) ──
export function getNarrativeSummary(): string {
  const narratives = getActiveNarratives();
  if (narratives.length === 0) return "🧭 No active narratives";

  const top = narratives.slice(0, 5);
  const lines = top.map(n => `  • ${n.keyword} [${n.category}] strength:${n.strength}`);
  return `🧭 ACTIVE NARRATIVES:\n${lines.join("\n")}`;
}

// ══════════════════════════════════════════════════════════════
// COIN-QUALITY HEURISTICS
// Derived from manual trader heuristics (ticker-rerun fatigue,
// community-vs-profile-coin signals). These are proxies computed
// from data already available (DexScreener), NOT a full
// implementation of every manual check — see caveats below each
// function for what still requires data sources not yet wired up
// (notably X/Twitter API access for pinned-thesis and moderation
// quality checks).
// ══════════════════════════════════════════════════════════════

// ── TICKER RERUN / "OG" CHECK ──
// A ticker that's been relaunched many times already is a narrative
// that's likely exhausted — the manual-trader version of this is
// "search the ticker, see how many times it's been tried before."
export interface TickerHistoryResult {
  priorPairCount: number;
  isOversaturated: boolean;
}

export async function checkTickerHistory(
  symbol: string,
  excludeMint?: string
): Promise<TickerHistoryResult> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`
    );
    const data = await res.json();
    const pairs = data?.pairs || [];

    const matches = pairs.filter((p: any) =>
      p.chainId === "solana" &&
      p.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase() &&
      p.baseToken?.address !== excludeMint
    );

    // Dedupe by mint — a token can have multiple pairs (different DEXes)
    const uniqueMints = new Set(matches.map((p: any) => p.baseToken?.address));

    return {
      priorPairCount: uniqueMints.size,
      isOversaturated: uniqueMints.size >= 5,
    };
  } catch (e) {
    console.error("Ticker history check error:", e);
    return { priorPairCount: 0, isOversaturated: false };
  }
}

// ── COMMUNITY SIGNAL CLASSIFICATION ──
// Rough proxy for the transcript's community-coin vs profile-coin
// split. This is NOT a real classification of tweet-coin vs
// community-coin — that requires reading the actual X presence
// (pinned thesis post, CA in bio, moderation activity), which needs
// an X/Twitter API key this codebase doesn't have yet. What this
// CAN check from DexScreener alone: does the token have any social
// presence at all, and does its description read like a written
// thesis rather than filler.
export interface CommunitySignalResult {
  hasSocials: boolean;
  hasWebsite: boolean;
  socialTypes: string[];
  signalScore: number; // 0–100
  label: "LIKELY_COMMUNITY" | "WEAK_SIGNAL" | "NO_SIGNAL";
}

export function classifyCommunitySignals(
  dexData: any,
  description?: string
): CommunitySignalResult {
  const socials: any[] = dexData?.info?.socials || [];
  const websites: any[] = dexData?.info?.websites || [];

  const socialTypes = socials.map((s: any) => s.type).filter(Boolean);
  const hasSocials = socials.length > 0;
  const hasWebsite = websites.length > 0;

  let score = 0;
  if (socialTypes.includes("twitter")) score += 25;
  if (socialTypes.includes("telegram")) score += 15;
  if (hasWebsite) score += 20;
  if ((description || "").trim().length >= 40) score += 20; // reads like an actual thesis, not filler
  if (socials.length >= 2) score += 10; // multiple channels = more than a drive-by

  score = Math.min(100, score);

  const label: CommunitySignalResult["label"] =
    score >= 60 ? "LIKELY_COMMUNITY" : score >= 20 ? "WEAK_SIGNAL" : "NO_SIGNAL";

  return { hasSocials, hasWebsite, socialTypes, signalScore: score, label };
}

// ── COMBINED COIN-QUALITY ADJUSTMENT ──
// Rolls the above into a single confidence adjustment (-15 to +15),
// same shape as getNarrativeBoost, so it plugs into the existing
// scoring pipeline the same way.
export async function getCoinQualityAdjustment(
  mint: string,
  symbol: string,
  dexData: any,
  description?: string
): Promise<{ adjustment: number; reasons: string[] }> {
  const reasons: string[] = [];
  let adjustment = 0;

  const tickerHistory = await checkTickerHistory(symbol, mint);
  if (tickerHistory.isOversaturated) {
    adjustment += OVERSATURATED_PENALTY;
    reasons.push(`Ticker "$${symbol}" already has ${tickerHistory.priorPairCount} prior Solana pairs — likely an oversaturated rerun`);
  } else if (tickerHistory.priorPairCount > 0) {
    reasons.push(`${tickerHistory.priorPairCount} prior pair(s) found for "$${symbol}" — not yet oversaturated`);
  }

  const community = classifyCommunitySignals(dexData, description);
  if (community.label === "LIKELY_COMMUNITY") {
    adjustment += COMMUNITY_BOOST;
    reasons.push(`Has community signals (${community.socialTypes.join(", ") || "socials"}${community.hasWebsite ? ", website" : ""})`);
  } else if (community.label === "NO_SIGNAL") {
    adjustment -= 5;
    reasons.push("No socials, website, or written description found — thin identity");
  }

  return { adjustment: Math.max(-15, Math.min(15, adjustment)), reasons };
}
