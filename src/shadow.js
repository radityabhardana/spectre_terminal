import { listTopMarkets, getMarketById, getOrderBook, pickYesNoTokens } from "./polymarket.js";
import { askQwen, askQwenShadow, askQwenBtcShortTerm } from "./qwen.js";
import { buildResearchContext } from "./research.js";
import { isBtcShortTermMarket } from "./btc-short-term.js";
import { scoreMarket } from "./scoring.js";
import { getShadowBalance, updateShadowBalance, addShadowBet, getShadowBets, getShadowStats, resolveShadowBet } from "./storage.js";

let isRunning = false;
let shouldStop = false;
let config = {
  durationMs: 7200000, // 2 hours
  targetBets: 20,
  capital: 10000,
  moneyManagement: "fixed", // or "percentage"
  betSize: 100, // fixed amount or percentage
  mode: "ending"
};

let currentBets = 0;
let logs = [];
let loopId = 0; // Prevent overlapping loops
let startedAt = null; // Track when bot was started

// Track market IDs already analyzed in this session to avoid re-processing
let scannedIds = new Set();

const STALE_BET_DAYS = 7; // Auto-expire bets older than 7 days

// Market fetch limit — large enough to always have fresh candidates
const MARKET_FETCH_LIMIT = 40;

// Verdicts from Qwen that qualify for placing a bet
const ENTRY_VERDICTS = new Set(["VALUE CANDIDATE", "HIGH RISK UNDERDOG"]);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logs.unshift(line);
  if (logs.length > 100) logs.length = 100;
  console.log(`[ShadowBot] ${msg}`);
}

export function getShadowState() {
  return {
    isRunning,
    startedAt,
    config,
    currentBets,
    balance: getShadowBalance(),
    logs: logs.slice(0, 30),
    activeBets: getShadowBets('open'),
    resolvedBets: getShadowBets('resolved', 20),
    stats: getShadowStats()
  };
}

export function configureShadow(newConfig) {
  if (isRunning) return false;
  
  // Only set capital if there are NO existing bets (fresh start)
  const hasExistingBets = getShadowBets('all', 1).length > 0;
  if (newConfig.capital && !hasExistingBets) {
    updateShadowBalance(newConfig.capital);
  }
  
  // Don't pass capital to config to avoid confusion
  const { capital, ...rest } = newConfig;
  config = { ...config, ...rest };
  if (!hasExistingBets && capital) {
    config.capital = capital;
  }
  
  return true;
}

export function resetShadowBalance(amount = 10000) {
  updateShadowBalance(amount);
  log(`Balance manually reset to $${amount.toFixed(2)}`);
}

export function startShadow() {
  if (isRunning) return false;
  isRunning = true;
  shouldStop = false;
  currentBets = 0;
  startedAt = Date.now();
  loopId++;
  scannedIds.clear();
  const myLoopId = loopId;
  
  log(`Bot started — Target: ${config.targetBets} bets over ${Math.round(config.durationMs/3600000)}h, MM: ${config.moneyManagement} (${config.betSize}${config.moneyManagement === 'percentage' ? '%' : '$'})`);
  
  setTimeout(() => shadowLoop(myLoopId), 2000);
  return true;
}

export function stopShadow() {
  shouldStop = true;
  isRunning = false;
  startedAt = null;
  loopId++; // Invalidate any running loop
  log("Stop signal received. Bot stopped.");
  return true;
}

/**
 * Direct analysis pipeline — bypasses rate-limiter and handleCommand entirely.
 * This calls the same Qwen pipeline as /analyze but without the guard.
 */
async function analyzeMarketDirect(market) {
  try {
    const tokens = pickYesNoTokens(market);
    if (!tokens.yesTokenId) return null;

    const yesBook = await getOrderBook(tokens.yesTokenId);
    const score = scoreMarket({ market, yesBook });

    // PRE-FILTER: Skip calling Qwen if mechanics already say SKIP
    if (score.verdict === "SKIP") {
      return { market, score, qwenResult: null, tokens, preFiltered: true };
    }

    const researchContext = await buildResearchContext({ market });

    // Route ke pipeline yang sesuai
    let qwenResult;
    const marketText = `${market.question || ""} ${market.eventTitle || ""}`;
    if (isBtcShortTermMarket(marketText)) {
      log(`🔬 BTC short-term market detected — using derivatives analysis`);
      qwenResult = await askQwenBtcShortTerm({
        market,
        score,
        orderBook: yesBook,
        researchContext,
      });
    } else {
      qwenResult = await askQwenShadow({
        market,
        score,
        orderBook: yesBook,
        researchContext,
      });
    }

    return { market, score, qwenResult, tokens, preFiltered: false };
  } catch (err) {
    // Jangan crash server — log saja dan lanjut ke market berikutnya
    log(`⚠️ analyzeMarketDirect error: ${err.message || err}`);
    return null;
  }
}

/**
 * Read the verdict and determine bet side directly from the structured Qwen result.
 * FIX #1: Reads analysis.verdict (not "ENTRY"/"UNDERDOG" which never appear in AI output).
 * FIX #2: Determines YES/NO side from market probability and AI analysis.
 */
function readVerdictFromResult(result) {
  const { score, qwenResult, tokens } = result;
  
  // If pre-filtered by mechanics, use mechanical verdict
  const mechanicalVerdict = score?.verdict || "SKIP";
  
  // Read structured verdict from Qwen's JSON response
  const aiVerdict = qwenResult?.analysis?.verdict?.toUpperCase() || null;
  
  // Use AI verdict if it qualifies, fallback to mechanical
  const effectiveVerdict = aiVerdict || mechanicalVerdict;

  // Determine side: if YES probability < 50%, the market favors NO, so buying YES is contrarian
  // If YES probability >= 50%, YES is already the "expected" side — we buy NO for potential value
  // But for HIGH RISK UNDERDOG: always go with the underdog (the cheaper side)
  let side = "YES";
  const yesProb = score?.marketProbability; // 0–100 scale

  if (effectiveVerdict === "HIGH RISK UNDERDOG") {
    // Underdog = the side with lower probability
    side = (yesProb != null && yesProb <= 50) ? "YES" : "NO";
  } else if (effectiveVerdict === "VALUE CANDIDATE") {
    // Value: prefer the side the AI seems to be recommending
    // Use YES if probability is low (undervalued), NO if probability is high (overvalued)
    side = (yesProb != null && yesProb < 50) ? "YES" : "NO";
  } else {
    // Default: pick the majority side
    side = (yesProb != null && yesProb >= 50) ? "YES" : "NO";
  }

  // Entry price from live token prices
  let entryPrice = side === "YES"
    ? (Number(tokens?.yesPrice) || 0.5)
    : (Number(tokens?.noPrice) || 0.5);
  entryPrice = Math.max(0.01, Math.min(0.99, entryPrice));

  return { verdict: effectiveVerdict, side, entryPrice };
}

async function shadowLoop(myLoopId) {
  if (myLoopId !== loopId) return; // Stale loop, kill it

  if (shouldStop || currentBets >= config.targetBets) {
    isRunning = false;
    if (currentBets >= config.targetBets) log(`Target reached: ${currentBets}/${config.targetBets} bets.`);
    return;
  }

  // Check if balance is sufficient before scanning
  const currentBalance = getShadowBalance();
  let minBetNeeded = config.betSize;
  if (config.moneyManagement === "percentage") {
    minBetNeeded = currentBalance * (config.betSize / 100);
  }
  minBetNeeded = Math.max(1, Math.round(minBetNeeded * 100) / 100);

  if (currentBalance < minBetNeeded) {
    log(`⚠️ Insufficient balance ($${currentBalance.toFixed(2)}) for min bet ($${minBetNeeded.toFixed(2)}). Bot stopping.`);
    isRunning = false;
    return;
  }

  let placedBet = false;
  
  try {
    log(`Scanning markets (mode: ${config.mode})...`);
    const { markets } = await listTopMarkets({ mode: config.mode, limit: MARKET_FETCH_LIMIT });
    
    // Filter markets we haven't bet on yet and haven't scanned in this session
    const existingIds = new Set(getShadowBets('all', 200).map(b => b.market_id));
    let candidates = markets.filter(m => !existingIds.has(m.id) && !scannedIds.has(m.id));
    
    if (candidates.length === 0) {
      // All fetched markets have been scanned — reset and let the API bring fresh ones
      log(`All ${scannedIds.size} scanned markets exhausted. Clearing scan cache and retrying in 60s...`);
      scannedIds.clear();
      if (!shouldStop && myLoopId === loopId) setTimeout(() => shadowLoop(myLoopId), 60000);
      return;
    }
    
    const target = candidates[0];
    scannedIds.add(target.id);
    log(`Analyzing [${scannedIds.size}/${MARKET_FETCH_LIMIT}]: "${target.question.slice(0, 60)}..."`);
    
    // Direct Qwen analysis — no rate-limiter!
    const result = await analyzeMarketDirect(target);
    if (myLoopId !== loopId) return; // User stopped during analysis
    
    if (!result) {
      log(`Skipped ${target.id} — no valid token.`);
    } else if (result.preFiltered) {
      // Mechanical SKIP — very fast, no Qwen cost
      log(`Pre-filter SKIP: "${target.question.slice(0, 50)}..." (blockers: ${result.score.blockers?.join(', ') || 'none'})`);
    } else {
      const { verdict, side, entryPrice } = readVerdictFromResult(result);
      
      log(`Verdict: ${verdict} | Side: ${side} | Price: ${(entryPrice * 100).toFixed(1)}c`);
      
      if (ENTRY_VERDICTS.has(verdict)) {
        let balance = getShadowBalance();
        let amount = config.betSize;
        
        if (config.moneyManagement === "percentage") {
          amount = balance * (config.betSize / 100);
        }
        
        // Minimum bet $1
        amount = Math.max(1, Math.round(amount * 100) / 100);
        
        if (balance >= amount) {
          balance -= amount;
          updateShadowBalance(balance);
          
          const shares = amount / entryPrice;
          const potentialPayout = shares * 1; // $1 per share if win
          
          addShadowBet({
            market_id: target.id,
            market_url: target.url,
            question: target.question,
            amount,
            side,
            entry_price: entryPrice
          });
          
          currentBets++;
          placedBet = true;
          log(`✅ BET PLACED: ${side} $${amount.toFixed(2)} @ ${(entryPrice*100).toFixed(1)}c → ${shares.toFixed(1)} shares (potential: $${potentialPayout.toFixed(2)}) | Balance: $${balance.toFixed(2)}`);
          notifyNewBet();
        } else {
          log(`💰 Insufficient balance ($${balance.toFixed(2)}) for $${amount.toFixed(2)} bet. Skipping.`);
        }
      } else {
        log(`Verdict ${verdict} — no bet placed, moving to next candidate.`);
      }
    }
    
  } catch (error) {
    log(`Loop error: ${error.message}`);
  }
  
  if (myLoopId !== loopId) return;
  
  // Timing strategy:
  // - After a bet: pace ourselves evenly to spread bets across the full duration
  // - After a non-bet (SKIP / WATCHLIST / pre-filter): scan next candidate ASAP (15s)
  // - After pre-filter (fast, no Qwen): scan immediately (5s)
  let waitMs;
  if (placedBet) {
    waitMs = Math.max(10000, Math.floor(config.durationMs / config.targetBets));
  } else {
    waitMs = 15000;
  }
    
  log(`Next scan in ${Math.floor(waitMs/1000)}s... (${candidates ? candidates.length - 1 : 0} remaining candidates)`);
  
  if (!shouldStop && myLoopId === loopId) {
    setTimeout(() => shadowLoop(myLoopId), waitMs);
  }
}

// ─── Background Resolver ────────────────────────────────────

let resolverInterval = null;

function startResolverIfNeeded() {
  if (resolverInterval) return;
  const openBets = getShadowBets('open');
  if (openBets.length === 0) return;
  
  log(`Resolver started — tracking ${openBets.length} open bet(s)`);
  resolverInterval = setInterval(async () => {
    await shadowResolverLoop();
    // Stop resolver if no more open bets
    if (getShadowBets('open').length === 0 && resolverInterval) {
      clearInterval(resolverInterval);
      resolverInterval = null;
      log("Resolver stopped — no open bets.");
    }
  }, 120000); // Every 2 minutes
}

// Check on startup after a short delay
setTimeout(() => {
  startResolverIfNeeded();
}, 8000);

// Also start resolver whenever a new bet is placed
export function notifyNewBet() {
  startResolverIfNeeded();
}

async function shadowResolverLoop() {
  try {
    const openBets = getShadowBets('open');
    if (!openBets.length) return;
    
    const now = Date.now();
    
    for (const bet of openBets) {
      // Auto-expire stale bets
      const betAge = now - new Date(bet.created_at).getTime();
      if (betAge > STALE_BET_DAYS * 24 * 60 * 60 * 1000) {
        log(`Bet expired (>${STALE_BET_DAYS}d): ${bet.market_id}`);
        // Return the original stake
        resolveShadowBet(bet.id, 0, bet.amount);
        continue;
      }
      
      try {
        const market = await getMarketById(bet.market_id);
        if (!market) continue;
        
        // Check if market is fully resolved
        if (market.closed && !market.active) {
          const tokens = pickYesNoTokens(market);
          const yesPrice = tokens.yesPrice;
          const noPrice = tokens.noPrice;
          
          // Wait until prices are settled (one should be ~1, the other ~0)
          if (yesPrice < 0.85 && noPrice < 0.85) continue;
          
          let won = false;
          if (bet.side === "YES" && yesPrice > noPrice) won = true;
          if (bet.side === "NO" && noPrice > yesPrice) won = true;
          
          const shares = bet.amount / Math.max(0.01, bet.entry_price);
          
          if (won) {
            const payout = shares * 1; // $1 per share
            const pnl = payout - bet.amount;
            log(`✅ WON: "${bet.question.slice(0,40)}..." → PnL: +$${pnl.toFixed(2)}`);
            resolveShadowBet(bet.id, pnl, payout);
          } else {
            const pnl = -bet.amount;
            log(`❌ LOST: "${bet.question.slice(0,40)}..." → PnL: -$${bet.amount.toFixed(2)}`);
            resolveShadowBet(bet.id, pnl, 0);
          }
        }
      } catch (err) {
        // Individual bet check failure shouldn't stop the loop
        log(`Resolver skip ${bet.market_id}: ${err.message}`);
      }
    }
  } catch (error) {
    log(`Resolver error: ${error.message}`);
  }
}
