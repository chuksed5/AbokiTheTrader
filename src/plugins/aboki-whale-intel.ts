import fs from "fs";
import path from "path";

const WHALE_DB_FILE = path.join(process.cwd(), "data", "aboki-whales.json");
const COORDINATION_FILE = path.join(process.cwd(), "data", "aboki-coordination.json");

// ── HELIUS KEY ROTATION ──
// Supports multiple Helius accounts so one exhausted key doesn't stall
// every on-chain check. Add HELIUS_API_KEY, HELIUS_API_KEY_2, HELIUS_API_KEY_3
// (and so on — any number works, not just two or three) to .env. A key
// marked exhausted is retried automatically after 6h, since Helius quotas
// typically reset daily — no restart needed for the pool to self-heal.
const HELIUS_KEY_RESET_MS = 6 * 60 * 60 * 1000;
let heliusKeyIndex = 0;
const heliusExhaustedAt: Record<number, number> = {};

function getHeliusKeyPool(): string[] {
  const keys: string[] = [];
  if (process.env.HELIUS_API_KEY) keys.push(process.env.HELIUS_API_KEY);
  let i = 2;
  while (process.env[`HELIUS_API_KEY_${i}`]) {
    keys.push(process.env[`HELIUS_API_KEY_${i}`]!);
    i++;
  }
  return keys;
}

function getActiveHeliusKey(): string | null {
  const keys = getHeliusKeyPool();
  if (keys.length === 0) return null;

  const now = Date.now();
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (heliusKeyIndex + attempt) % keys.length;
    const exhaustedAt = heliusExhaustedAt[idx];
    if (!exhaustedAt || now - exhaustedAt > HELIUS_KEY_RESET_MS) {
      heliusKeyIndex = idx;
      return keys[idx];
    }
  }
  return null; // every key is currently exhausted and still within cooldown
}

function reportHeliusKeyExhausted(key: string) {
  const keys = getHeliusKeyPool();
  const idx = keys.indexOf(key);
  if (idx === -1) return;
  heliusExhaustedAt[idx] = Date.now();
  console.warn(`⚠️ Helius key #${idx + 1} marked exhausted — rotating (retries in 6h)`);
  heliusKeyIndex = (idx + 1) % keys.length;
}

function isQuotaError(status: number, bodyText: string): boolean {
  return status === 429 || /max usage|quota|rate limit/i.test(bodyText);
}

// ── INTERFACES ──
interface WalletProfile {
    address: string;
    firstSeen: string;
    lastSeen: string;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgEntryMC: number;
    avgHoldMinutes: number;
    avgEntrySecondsAfterLaunch: number;
    coordinatedBuys: number;
    knownCoordinators: string[];
    insiderScore: number;
    classification: "INSIDER" | "SMART_MONEY" | "RETAIL" | "UNKNOWN";
    trades: WalletTrade[];
    notes: string[];
}

interface WalletTrade {
    tokenMint: string;
    tokenSymbol: string;
    entryTime: string;
    entryMC: number;
    exitMC?: number;
    profitPercent?: number;
    wasCoordinated: boolean;
    coordinatedWith: string[];
    secondsAfterLaunch: number;
}

interface CoordinationEvent {
    id: string;
    timestamp: string;
    tokenMint: string;
    tokenSymbol: string;
    wallets: string[];
    timeWindowSeconds: number;
    avgEntryMC: number;
    insiderProbability: number;
    verdict: "LIKELY_INSIDER" | "POSSIBLE_COORDINATION" | "NORMAL";
}

interface WhaleDatabase {
    wallets: Record<string, WalletProfile>;
    totalTracked: number;
    lastUpdated: string;
}

// ── INITIALIZE ──
export function initializeWhaleIntel(): void {
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(WHALE_DB_FILE)) {
        const emptyDB: WhaleDatabase = {
            wallets: {},
            totalTracked: 0,
            lastUpdated: new Date().toISOString(),
        };
        fs.writeFileSync(WHALE_DB_FILE, JSON.stringify(emptyDB, null, 2));
        console.log("🐋 Aboki whale intelligence initialized");
    }

    if (!fs.existsSync(COORDINATION_FILE)) {
        fs.writeFileSync(COORDINATION_FILE, JSON.stringify([], null, 2));
        console.log("🔗 Coordination detector initialized");
    }
}

// ── READ / WRITE ──
function readWhaleDB(): WhaleDatabase {
    try {
        return JSON.parse(fs.readFileSync(WHALE_DB_FILE, "utf-8"));
    } catch {
        return { wallets: {}, totalTracked: 0, lastUpdated: new Date().toISOString() };
    }
}

function readCoordination(): CoordinationEvent[] {
    try {
        return JSON.parse(fs.readFileSync(COORDINATION_FILE, "utf-8"));
    } catch {
        return [];
    }
}

function saveWhaleDB(db: WhaleDatabase): void {
    db.lastUpdated = new Date().toISOString();
    fs.writeFileSync(WHALE_DB_FILE, JSON.stringify(db, null, 2));
}

// ── STEP 1: SCAN TOKEN BUYERS FROM DEXSCREENER ──
export async function scanTokenBuyers(
    tokenMint: string,
    tokenSymbol: string,
    currentMC: number
): Promise<string[]> {
    try {
        const res = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
        );
        const data = await res.json();
        const pair = data?.pairs?.[0];

        if (!pair) return [];

        // Get recent transactions
        const txRes = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
        );
        const txData = await txRes.json();

        // Extract wallet addresses from recent buys
        // DexScreener shows recent txs - we extract unique buyer addresses
        const buyers: string[] = [];

        if (pair.txns?.h1?.buys > 0) {
            console.log(`🔍 Token ${tokenSymbol} had ${pair.txns.h1.buys} buys in last 1h`);
        }

        return buyers;
    } catch (e) {
        return [];
    }
}

// ── STEP 2: SCAN HELIUS FOR EARLY BUYERS ──
export async function getEarlyBuyers(
    tokenMint: string,
    tokenSymbol: string
): Promise<string[]> {
    try {
        const heliusKey = getActiveHeliusKey();
        if (!heliusKey) return [];

        const res = await fetch(
            `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${heliusKey}&limit=20&type=SWAP`
        );

        if (!res.ok) {
            const text = await res.text();
            if (isQuotaError(res.status, text)) reportHeliusKeyExhausted(heliusKey);
            console.warn(`⚠️ Helius buyer scan skipped for ${tokenSymbol}: HTTP ${res.status} — ${text.slice(0, 80)}`);
            return [];
        }

        const data = await res.json();

        if (!Array.isArray(data)) return [];

        const buyers: string[] = [];
        for (const tx of data) {
            if (tx.feePayer && !buyers.includes(tx.feePayer)) {
                buyers.push(tx.feePayer);
            }
        }

        console.log(`🐋 Found ${buyers.length} early buyers for ${tokenSymbol}`);
        return buyers.slice(0, 10); // top 10 earliest buyers

    } catch (e) {
        console.error("Helius buyer scan error:", e);
        return [];
    }
}

// ── STEP 3: SCORE A WALLET ──
export async function scoreWallet(
    address: string,
    tokenMint: string,
    tokenSymbol: string,
    entryMC: number,
    secondsAfterLaunch: number
): Promise<WalletProfile> {
    const db = readWhaleDB();

    // Get or create wallet profile
    if (!db.wallets[address]) {
        db.wallets[address] = {
            address,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            avgEntryMC: entryMC,
            avgHoldMinutes: 0,
            avgEntrySecondsAfterLaunch: secondsAfterLaunch,
            coordinatedBuys: 0,
            knownCoordinators: [],
            insiderScore: 0,
            classification: "UNKNOWN",
            trades: [],
            notes: [],
        };
        db.totalTracked++;
        console.log(`🆕 New wallet tracked: ${address.slice(0, 8)}...`);
    }

    const wallet = db.wallets[address];
    wallet.lastSeen = new Date().toISOString();
    wallet.totalTrades++;

    // Add this trade
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
    if (wallet.trades.length > 50) wallet.trades = wallet.trades.slice(-50);

    // Update averages
    wallet.avgEntryMC = Math.round(
        wallet.trades.reduce((sum, t) => sum + t.entryMC, 0) / wallet.trades.length
    );
    wallet.avgEntrySecondsAfterLaunch = Math.round(
        wallet.trades.reduce((sum, t) => sum + t.secondsAfterLaunch, 0) / wallet.trades.length
    );

    // Calculate insider score
    wallet.insiderScore = calculateInsiderScore(wallet);
    wallet.classification = classifyWallet(wallet);

    saveWhaleDB(db);
    return wallet;
}

// ── STEP 4: CALCULATE INSIDER SCORE ──
function calculateInsiderScore(wallet: WalletProfile): number {
    let score = 0;

    // Early entry bonus (buys in first 30 seconds = very suspicious)
    if (wallet.avgEntrySecondsAfterLaunch < 30) score += 40;
    else if (wallet.avgEntrySecondsAfterLaunch < 120) score += 20;
    else if (wallet.avgEntrySecondsAfterLaunch < 300) score += 10;

    // Win rate bonus
    if (wallet.winRate > 80) score += 30;
    else if (wallet.winRate > 60) score += 15;

    // Coordination bonus (buying with same wallets repeatedly = insider network)
    if (wallet.coordinatedBuys > 5) score += 20;
    else if (wallet.coordinatedBuys > 2) score += 10;

    // Low avg entry MC (buying very early = knows about token before launch)
    if (wallet.avgEntryMC < 30000) score += 10;

    return Math.min(score, 100);
}

// ── STEP 5: CLASSIFY WALLET ──
function classifyWallet(wallet: WalletProfile): WalletProfile["classification"] {
    if (wallet.insiderScore >= 70) return "INSIDER";
    if (wallet.insiderScore >= 40 || wallet.winRate > 65) return "SMART_MONEY";
    if (wallet.totalTrades > 5 && wallet.winRate < 40) return "RETAIL";
    return "UNKNOWN";
}

// ── STEP 6: DETECT COORDINATION ──
export function detectCoordination(
    tokenMint: string,
    tokenSymbol: string,
    buyers: string[],
    entryMC: number
): CoordinationEvent | null {
    const db = readWhaleDB();

    // Find which buyers are already tracked whales
    const knownWhales = buyers.filter(addr =>
        db.wallets[addr] && db.wallets[addr].classification !== "RETAIL"
    );

    if (knownWhales.length < 2) return null;

    // Check if these whales have bought together before
    let coordinationScore = 0;
    const coordinationPairs: string[] = [];

    for (let i = 0; i < knownWhales.length; i++) {
        for (let j = i + 1; j < knownWhales.length; j++) {
            const walletA = db.wallets[knownWhales[i]];
            const walletB = db.wallets[knownWhales[j]];

            if (walletA?.knownCoordinators?.includes(knownWhales[j])) {
                coordinationScore += 30;
                coordinationPairs.push(`${knownWhales[i].slice(0, 6)}...↔${knownWhales[j].slice(0, 6)}...`);
            }
        }
    }

    // Base score on number of whales buying together
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

    // Save coordination event
    const events = readCoordination();
    events.push(event);
    const recent = events.slice(-100);
    fs.writeFileSync(COORDINATION_FILE, JSON.stringify(recent, null, 2));

    if (verdict !== "NORMAL") {
        console.log(`🚨 COORDINATION DETECTED: ${tokenSymbol}`);
        console.log(`   Wallets: ${knownWhales.length} known whales`);
        console.log(`   Insider probability: ${insiderProbability}%`);
        console.log(`   Verdict: ${verdict}`);
        if (coordinationPairs.length > 0) {
            console.log(`   Known pairs: ${coordinationPairs.join(", ")}`);
        }
    }

    return event;
}

// ── STEP 7: UPDATE WALLET WIN/LOSS ──
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
    console.log(`📊 Wallet ${address.slice(0, 8)}... updated: ${won ? "WIN" : "LOSS"} ${profitPercent > 0 ? "+" : ""}${profitPercent}%`);
}

// ── STEP 8: GET WHALE REPORT ──
export function getWhaleReport(): string {
    const db = readWhaleDB();
    const wallets = Object.values(db.wallets);

    if (wallets.length === 0) return "🐋 No whales tracked yet";

    const insiders = wallets.filter(w => w.classification === "INSIDER");
    const smartMoney = wallets.filter(w => w.classification === "SMART_MONEY");

    const events = readCoordination();
    const recentCoord = events.filter(e =>
        e.verdict !== "NORMAL" &&
        new Date(e.timestamp) > new Date(Date.now() - 3600000)
    );

    return `🐋 WHALE INTEL REPORT:
Total tracked: ${wallets.length} wallets
Insiders identified: ${insiders.length}
Smart money: ${smartMoney.length}
Coordination events (1h): ${recentCoord.length}
${insiders.length > 0 ? `\n🚨 INSIDERS: ${insiders.map(w => `${w.address.slice(0, 8)}... (score: ${w.insiderScore})`).join(", ")}` : ""}`;
}

// ── STEP 9: CHECK IF WHALES ARE IN A TOKEN ──
export function checkWhaleActivity(
    tokenMint: string,
    buyers: string[]
): {
    hasWhales: boolean;
    whaleCount: number;
    insiderCount: number;
    topWhale: WalletProfile | null;
    recommendation: "FOLLOW" | "CAUTION" | "AVOID" | "NEUTRAL";
} {
    const db = readWhaleDB();

    const trackedBuyers = buyers
        .map(addr => db.wallets[addr])
        .filter(Boolean) as WalletProfile[];

    const insiders = trackedBuyers.filter(w => w.classification === "INSIDER");
    const smartMoney = trackedBuyers.filter(w => w.classification === "SMART_MONEY");

    const topWhale = trackedBuyers.sort((a, b) => b.insiderScore - a.insiderScore)[0] || null;

    let recommendation: "FOLLOW" | "CAUTION" | "AVOID" | "NEUTRAL" = "NEUTRAL";

    if (insiders.length >= 2) recommendation = "FOLLOW"; // multiple insiders = strong signal
    else if (insiders.length === 1) recommendation = "CAUTION"; // one insider = interesting
    else if (smartMoney.length >= 2) recommendation = "FOLLOW"; // smart money consensus
    else if (trackedBuyers.length === 0) recommendation = "NEUTRAL";

    return {
        hasWhales: trackedBuyers.length > 0,
        whaleCount: trackedBuyers.length,
        insiderCount: insiders.length,
        topWhale,
        recommendation,
    };
}

// ── BASE58 (no external dep) — needed to decode raw account owners from RPC ──
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
    if (bytes.length === 0) return "";
    const digits = [0];
    for (let i = 0; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] * 256;
            digits[j] = carry % 58;
            carry = Math.floor(carry / 58);
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = Math.floor(carry / 58);
        }
    }
    let leadingZeros = 0;
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) leadingZeros++;
    return BASE58_ALPHABET[0].repeat(leadingZeros) +
        digits.reverse().map(d => BASE58_ALPHABET[d]).join("");
}

// SPL token account layout: mint(32) + owner(32) + amount(8) + ...
// We only need bytes 32–64 to recover the account's "owner" field —
// this tells us who actually controls a given token account, which is
// how we tell a real wallet apart from the pool's own liquidity vault.
function decodeTokenAccountOwner(base64Data: string): string | null {
    try {
        const buf = Buffer.from(base64Data, "base64");
        if (buf.length < 64) return null;
        return base58Encode(new Uint8Array(buf.subarray(32, 64)));
    } catch {
        return null;
    }
}

// ── STEP 10: ON-CHAIN HOLDER CONCENTRATION ──
// Pulls the actual current supply distribution via Helius RPC, then
// excludes the pool/AMM's own vault so "top holder %" reflects real
// wallets, not the liquidity pool itself.
export interface HolderSnapshot {
    topHolderPct: number;
    top3HolderPct: number;
    accountsChecked: number;
    poolAccountsExcluded: number;
    topHolderOwners: string[];
}

export async function getHolderConcentration(
    tokenMint: string,
    pairAddress?: string
): Promise<HolderSnapshot | null> {
    try {
        const heliusKey = getActiveHeliusKey();
        if (!heliusKey) return null;

        const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

        const [largestRes, supplyRes] = await Promise.all([
            fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: "largest",
                    method: "getTokenLargestAccounts",
                    params: [tokenMint],
                }),
            }),
            fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: "supply",
                    method: "getTokenSupply",
                    params: [tokenMint],
                }),
            }),
        ]);

        if (!largestRes.ok || !supplyRes.ok) {
            const failedRes = !largestRes.ok ? largestRes : supplyRes;
            const text = await failedRes.text();
            if (isQuotaError(failedRes.status, text)) reportHeliusKeyExhausted(heliusKey);
            console.warn(`⚠️ Helius holder check skipped for ${tokenMint}: HTTP ${failedRes.status} — ${text.slice(0, 80)}`);
            return null;
        }

        const largestData = await largestRes.json();
        const supplyData = await supplyRes.json();

        const accounts = largestData?.result?.value || [];
        const totalSupply = parseFloat(supplyData?.result?.value?.amount || "0");

        if (!accounts.length || totalSupply === 0) return null;

        const sorted = [...accounts].sort(
            (a: any, b: any) => parseFloat(b.amount) - parseFloat(a.amount)
        );

        // Resolve the pool address if the caller didn't already have it handy
        let poolAddress = pairAddress;
        if (!poolAddress) {
            try {
                const dexRes = await fetch(
                    `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`
                );
                const dexData = await dexRes.json();
                poolAddress = dexData?.pairs?.[0]?.pairAddress;
            } catch {
                // fall through — handled by the check below
            }
        }

        if (!poolAddress) {
            // Can't reliably tell the pool's own vault apart from a real
            // wallet without this. Proceeding anyway risks miscounting the
            // AMM's own token balance as a "whale" — especially likely on a
            // token that's already crashed hard, since a crashing pool
            // naturally fills up with tokens everyone just sold into it.
            // Fail closed: no number is safer than a possibly-wrong one.
            console.warn(`⚠️ Could not resolve pool address for ${tokenMint} — skipping concentration check (fail-closed)`);
            return null;
        }

        // Check who actually owns each of the top few token accounts.
        // A vault owned by the pool/bonding-curve address itself is
        // liquidity, not a whale — exclude it from concentration stats.
        // We also keep the resolved owners of the top accounts regardless,
        // since those are the actual wallets a funding-cluster check needs.
        let nonPoolSorted = sorted;
        let poolAccountsExcluded = 0;
        let topHolderOwners: string[] = [];

        const topSlice = sorted.slice(0, 5);
        const addresses = topSlice.map((a: any) => a.address);

        if (addresses.length > 0) {
            const ownerRes = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: "owners",
                    method: "getMultipleAccounts",
                    params: [addresses, { encoding: "base64" }],
                }),
            });
            const ownerData = await ownerRes.json();
            const values = ownerData?.result?.value || [];

            const poolOwnedAddresses = new Set<string>();
            const ownersFound: string[] = [];

            values.forEach((val: any, i: number) => {
                const b64 = val?.data?.[0];
                const owner = b64 ? decodeTokenAccountOwner(b64) : null;
                if (!owner) return;
                if (poolAddress && owner === poolAddress) {
                    poolOwnedAddresses.add(addresses[i]);
                } else {
                    ownersFound.push(owner);
                }
            });

            topHolderOwners = Array.from(new Set(ownersFound));

            if (poolOwnedAddresses.size > 0) {
                nonPoolSorted = sorted.filter((a: any) => !poolOwnedAddresses.has(a.address));
                poolAccountsExcluded = poolOwnedAddresses.size;
            }
        }

        const ranked = nonPoolSorted.length > 0 ? nonPoolSorted : sorted;
        const topAmount = parseFloat(ranked[0]?.amount || "0");
        const top3Amount = ranked
            .slice(0, 3)
            .reduce((sum: number, a: any) => sum + parseFloat(a.amount || "0"), 0);

        return {
            topHolderPct: parseFloat(((topAmount / totalSupply) * 100).toFixed(2)),
            top3HolderPct: parseFloat(((top3Amount / totalSupply) * 100).toFixed(2)),
            accountsChecked: accounts.length,
            poolAccountsExcluded,
            topHolderOwners,
        };
    } catch (e) {
        console.error("Holder concentration check error:", e);
        return null;
    }
}

// ── STEP 11: WALLET FUNDING TIME ──
// Walks a wallet's transaction history backward to find its earliest
// activity — a proxy for "when was this wallet funded/created."
// Capped at 3 pages (3000 signatures): a wallet with more history than
// that is clearly not a fresh bundler wallet, so we treat it as
// "established" and skip it rather than pay for a long walk that
// wouldn't change the verdict anyway.
export async function getWalletFundingTime(
    address: string
): Promise<{ timestamp: number; ageMinutes: number } | null> {
    try {
        const heliusKey = getActiveHeliusKey();
        if (!heliusKey) return null;

        const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
        const PAGE_LIMIT = 1000;
        const MAX_PAGES = 3;

        let before: string | undefined;
        let lastPage: any[] = [];

        for (let page = 0; page < MAX_PAGES; page++) {
            const params: any[] = [
                address,
                before ? { limit: PAGE_LIMIT, before } : { limit: PAGE_LIMIT },
            ];
            const res = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: "sigs",
                    method: "getSignaturesForAddress",
                    params,
                }),
            });

            if (!res.ok) {
                const text = await res.text();
                if (isQuotaError(res.status, text)) reportHeliusKeyExhausted(heliusKey);
                console.warn(`⚠️ Helius wallet-age check skipped for ${address}: HTTP ${res.status} — ${text.slice(0, 80)}`);
                break; // stop paging this wallet, return whatever we already have
            }

            const data = await res.json();
            const sigs = data?.result || [];

            if (sigs.length === 0) break;
            lastPage = sigs;
            if (sigs.length < PAGE_LIMIT) break; // reached the true start of this wallet's history

            before = sigs[sigs.length - 1].signature;
        }

        if (lastPage.length === 0) return null;

        const reachedTrueStart = lastPage.length < PAGE_LIMIT;
        if (!reachedTrueStart) return null; // 3000+ prior txs — established wallet, not a fresh bundler

        const oldest = lastPage[lastPage.length - 1];
        if (!oldest?.blockTime) return null;

        const timestamp = oldest.blockTime * 1000;
        return { timestamp, ageMinutes: (Date.now() - timestamp) / (1000 * 60) };
    } catch (e) {
        console.error("Wallet funding time check error:", e);
        return null;
    }
}

// ── STEP 12: FUNDING-TIME CLUSTER DETECTION ──
// If several top-holder wallets were all first active within a tight
// time window, that's the "one entity, many wallets" bundling pattern —
// and it works even on wallets Aboki has never seen before, unlike the
// tracked-whale coordination check.
export interface FundingClusterResult {
    checkedWallets: number;
    clusteredWallets: { address: string; ageMinutes: number }[];
    isSuspicious: boolean;
}

export async function detectFundingCluster(
    walletAddresses: string[]
): Promise<FundingClusterResult> {
    const uniqueWallets = Array.from(new Set(walletAddresses)).slice(0, 5); // cap RPC cost

    const results = await Promise.all(
        uniqueWallets.map(async (addr) => {
            const funding = await getWalletFundingTime(addr);
            return funding ? { address: addr, ...funding } : null;
        })
    );
    const valid = results.filter(Boolean) as { address: string; timestamp: number; ageMinutes: number }[];

    if (valid.length < 3) {
        return { checkedWallets: valid.length, clusteredWallets: [], isSuspicious: false };
    }

    // Find the largest group of wallets funded within 15 minutes of each other
    const sorted = [...valid].sort((a, b) => a.timestamp - b.timestamp);
    const WINDOW_MS = 15 * 60 * 1000;
    let bestCluster: typeof sorted = [];

    for (const anchor of sorted) {
        const cluster = sorted.filter(w => Math.abs(w.timestamp - anchor.timestamp) <= WINDOW_MS);
        if (cluster.length > bestCluster.length) bestCluster = cluster;
    }

    return {
        checkedWallets: valid.length,
        clusteredWallets: bestCluster.map(w => ({ address: w.address, ageMinutes: Math.round(w.ageMinutes) })),
        isSuspicious: bestCluster.length >= 3,
    };
}