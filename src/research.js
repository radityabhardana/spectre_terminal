import { config } from "./config.js";
import { getCache, setCache } from "./storage.js";

const COIN_ALIASES = [
  { symbol: "BTC", name: "Bitcoin", pair: "BTCUSDT", aliases: ["bitcoin", "btc", "$btc"] },
  { symbol: "ETH", name: "Ethereum", pair: "ETHUSDT", defillamaChain: "Ethereum", aliases: ["ethereum", "ether", "eth", "$eth"] },
  { symbol: "SOL", name: "Solana", pair: "SOLUSDT", defillamaChain: "Solana", aliases: ["solana", "sol", "$sol"] },
  { symbol: "XRP", name: "XRP", pair: "XRPUSDT", aliases: ["xrp", "ripple", "$xrp"] },
  { symbol: "DOGE", name: "Dogecoin", pair: "DOGEUSDT", aliases: ["dogecoin", "doge", "$doge"] },
  { symbol: "ADA", name: "Cardano", pair: "ADAUSDT", defillamaChain: "Cardano", aliases: ["cardano", "ada", "$ada"] },
  { symbol: "BNB", name: "BNB", pair: "BNBUSDT", defillamaChain: "BSC", aliases: ["bnb", "binance coin", "$bnb"] },
  { symbol: "AVAX", name: "Avalanche", pair: "AVAXUSDT", defillamaChain: "Avalanche", aliases: ["avalanche", "avax", "$avax"] },
  { symbol: "LINK", name: "Chainlink", pair: "LINKUSDT", defillamaSlug: "chainlink", aliases: ["chainlink", "$link"] },
  { symbol: "DOT", name: "Polkadot", pair: "DOTUSDT", defillamaChain: "Polkadot", aliases: ["polkadot", "$dot"] },
  { symbol: "POL", name: "Polygon", pair: "POLUSDT", defillamaChain: "Polygon", aliases: ["polygon", "matic", "$matic", "$pol"] },
  { symbol: "LTC", name: "Litecoin", pair: "LTCUSDT", aliases: ["litecoin", "ltc", "$ltc"] },
  { symbol: "TRX", name: "TRON", pair: "TRXUSDT", defillamaChain: "Tron", aliases: ["tron", "trx", "$trx"] },
  { symbol: "TON", name: "Toncoin", pair: "TONUSDT", defillamaChain: "TON", aliases: ["toncoin", "$ton"] },
  { symbol: "SUI", name: "Sui", pair: "SUIUSDT", defillamaChain: "Sui", aliases: ["sui", "$sui"] },
  { symbol: "APT", name: "Aptos", pair: "APTUSDT", defillamaChain: "Aptos", aliases: ["aptos", "$apt"] },
  { symbol: "SHIB", name: "Shiba Inu", pair: "SHIBUSDT", aliases: ["shiba", "shib", "$shib"] },
  { symbol: "PEPE", name: "Pepe", pair: "PEPEUSDT", aliases: ["pepe", "$pepe"] },
  { symbol: "BCH", name: "Bitcoin Cash", pair: "BCHUSDT", aliases: ["bitcoin cash", "bch", "$bch"] },
  { symbol: "UNI", name: "Uniswap", pair: "UNIUSDT", defillamaSlug: "uniswap", aliases: ["uniswap", "$uni"] },
  { symbol: "AAVE", name: "Aave", pair: "AAVEUSDT", defillamaSlug: "aave", aliases: ["aave", "$aave"] },
  { symbol: "NEAR", name: "NEAR Protocol", pair: "NEARUSDT", defillamaChain: "Near", aliases: ["near protocol", "$near"] },
  { symbol: "ICP", name: "Internet Computer", pair: "ICPUSDT", aliases: ["internet computer", "$icp"] },
  { symbol: "RENDER", name: "Render", pair: "RENDERUSDT", aliases: ["render token", "$rndr", "$render"] },
  { symbol: "ARB", name: "Arbitrum", pair: "ARBUSDT", defillamaChain: "Arbitrum", aliases: ["arbitrum", "$arb"] },
  { symbol: "OP", name: "Optimism", pair: "OPUSDT", defillamaChain: "Optimism", aliases: ["optimism", "$op"] },
  { symbol: "WLD", name: "Worldcoin", pair: "WLDUSDT", aliases: ["worldcoin", "$wld"] },
  {
    symbol: "USDT",
    name: "Tether",
    pair: "USDCUSDT",
    proxyNote: "Proxy stablecoin: USDC priced in USDT. Di atas 1 berarti USDT relatif lebih murah dari USDC.",
    aliases: ["tether", "usdt", "$usdt"],
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    pair: "USDCUSDT",
    proxyNote: "Proxy stablecoin: USDC priced in USDT. Di bawah 1 berarti USDC relatif lebih murah dari USDT.",
    aliases: ["usd coin", "usdc", "$usdc"],
  },
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAlias(text, alias) {
  const normalizedAlias = normalizeText(alias);
  if (!normalizedAlias) return false;
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(text);
}

function marketText({ market, event, markets } = {}) {
  const marketList = Array.isArray(markets) ? markets : [];
  return [
    market?.question,
    market?.eventTitle,
    market?.groupItemTitle,
    market?.description,
    event?.title,
    event?.description,
    ...marketList.flatMap((item) => [
      item?.question,
      item?.eventTitle,
      item?.groupItemTitle,
      item?.description,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
}

function primaryAssetText({ market, event, markets } = {}) {
  const marketList = Array.isArray(markets) ? markets : [];
  return [
    market?.question,
    market?.eventTitle,
    market?.groupItemTitle,
    event?.title,
    ...marketList.flatMap((item) => [
      item?.question,
      item?.eventTitle,
      item?.groupItemTitle,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
}

export function detectCryptoAssets(input) {
  const text = normalizeText(input);
  if (!text) return [];

  const detected = [];
  for (const coin of COIN_ALIASES) {
    const matched = coin.aliases.find((alias) => hasAlias(text, alias));
    if (matched) {
      detected.push({
        symbol: coin.symbol,
        name: coin.name,
        pair: coin.pair,
        proxyNote: coin.proxyNote || null,
        defillamaChain: coin.defillamaChain || null,
        defillamaSlug: coin.defillamaSlug || null,
        matched,
      });
    }
  }

  return detected.slice(0, 6);
}

async function fetchJson(url, ttlSeconds = config.cryptoCacheTtlSeconds, externalSignal = null) {
  const key = `research:${url}`;
  const cached = getCache(key, ttlSeconds);
  if (cached) return cached;

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(config.researchFetchTimeoutMs)])
    : AbortSignal.timeout(config.researchFetchTimeoutMs);

  const response = await fetch(url, {
    signal,
    headers: {
      accept: "application/json",
      "user-agent": "polymarket-telegram-analyzer/0.1",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Crypto research HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = await response.json();
  setCache(key, json);
  return json;
}

function binanceUrl(path, symbol) {
  const url = new URL(path, config.binanceBaseUrl);
  url.searchParams.set("symbol", symbol);
  return url;
}

function binanceKlinesUrl(symbol) {
  const url = binanceUrl("/api/v3/klines", symbol);
  url.searchParams.set("interval", "15m");
  url.searchParams.set("limit", "96"); // 96 * 15m = 24 hours
  return url;
}

function binanceFuturesUrl(path, symbol) {
  const url = new URL(path, config.binanceFuturesBaseUrl);
  url.searchParams.set("symbol", symbol);
  return url;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compactUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function isoFromMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function trendFromKlines(klines) {
  if (!Array.isArray(klines)) {
    return {
      price_change_4h_pct: null,
      price_change_24h_pct: null,
      daily_closes_count: 0,
      rsi_14: null,
      sma_7: null,
      sma_30: null,
      support_24h: null,
      resistance_24h: null,
      ta_trend: null,
      volume_spike: null,
    };
  }

  const closes = klines.map((row) => num(row?.[4])).filter((value) => value != null);
  const highs = klines.map((row) => num(row?.[2])).filter((value) => value != null);
  const lows = klines.map((row) => num(row?.[3])).filter((value) => value != null);
  const volumes = klines.map((row) => num(row?.[5])).filter((value) => value != null);
  
  if (closes.length === 0) return { daily_closes_count: 0 };

  const latest = closes.at(-1);
  const fourHoursAgo = closes.length >= 16 ? closes[closes.length - 16] : null; // 16 * 15m = 4h
  const twentyFourHoursAgo = closes.length >= 96 ? closes[0] : null;

  // SMA
  const sma7 = closes.length >= 7 ? closes.slice(-7).reduce((a, b) => a + b, 0) / 7 : null;
  const sma30 = closes.length >= 30 ? closes.slice(-30).reduce((a, b) => a + b, 0) / 30 : null;

  // RSI 14
  let rsi14 = null;
  if (closes.length > 14) {
    let gains = 0, losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) rsi14 = 100;
    else {
      const rs = avgGain / avgLoss;
      rsi14 = 100 - (100 / (1 + rs));
    }
  }

  // Support / Resistance (24h / 96 bars)
  const support_24h = lows.length > 0 ? Math.min(...lows) : null;
  const resistance_24h = highs.length > 0 ? Math.max(...highs) : null;

  // Volume Breakout
  let volume_spike = null;
  if (volumes.length > 5) {
    const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const latestVol = volumes.at(-1);
    if (avgVol > 0 && latestVol > avgVol * 1.5) {
      volume_spike = `${(latestVol / avgVol).toFixed(1)}x`;
    }
  }

  // Price Action Trend (HH/HL)
  let ta_trend = "Neutral";
  if (highs.length >= 14 && lows.length >= 14) {
    const recentHighs = highs.slice(-7);
    const prevHighs = highs.slice(-14, -7);
    const recentLows = lows.slice(-7);
    const prevLows = lows.slice(-14, -7);

    const avgRecentHigh = recentHighs.reduce((a, b) => a + b, 0) / 7;
    const avgPrevHigh = prevHighs.reduce((a, b) => a + b, 0) / 7;
    const avgRecentLow = recentLows.reduce((a, b) => a + b, 0) / 7;
    const avgPrevLow = prevLows.reduce((a, b) => a + b, 0) / 7;

    if (avgRecentHigh > avgPrevHigh && avgRecentLow > avgPrevLow) {
      ta_trend = "Bullish";
    } else if (avgRecentHigh < avgPrevHigh && avgRecentLow < avgPrevLow) {
      ta_trend = "Bearish";
    } else {
      ta_trend = "Sideways";
    }
  }

  return {
    price_change_4h_pct: pctChange(fourHoursAgo, latest),
    price_change_24h_pct: pctChange(twentyFourHoursAgo, latest),
    daily_closes_count: closes.length,
    rsi_14: rsi14,
    sma_7: sma7,
    sma_30: sma30,
    support_24h,
    resistance_24h,
    ta_trend,
    volume_spike,
  };
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (error.name === "TimeoutError") return "Request timeout";
  return String(error.message || error)
    .replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, "[redacted endpoint]")
    .replace(/\b(?:authorization|api[-_ ]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 300);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Research request aborted");
  error.name = "AbortError";
  throw error;
}

function providerError(provider, error) {
  return { provider, status: "error", error: errorMessage(error) };
}

function unwrapResult(result, fallback) {
  return result.status === "fulfilled" ? result.value : fallback;
}

async function fetchBinanceFutures(asset, signal = null) {
  throwIfAborted(signal);
  if (asset.proxyNote) {
    return {
      futures_status: "skipped",
      futures_reason: "Stablecoin proxy tidak memakai futures context.",
    };
  }

  const premiumUrl = binanceFuturesUrl("/fapi/v1/premiumIndex", asset.pair);
  const openInterestUrl = binanceFuturesUrl("/fapi/v1/openInterest", asset.pair);
  const longShortUrl = binanceFuturesUrl("/fapi/v1/globalLongShortAccountRatio", asset.pair);
  longShortUrl.searchParams.set("period", "5m");
  longShortUrl.searchParams.set("limit", "1");
  
  const klinesUrl = binanceFuturesUrl("/fapi/v1/klines", asset.pair);
  klinesUrl.searchParams.set("interval", "5m");
  klinesUrl.searchParams.set("limit", "6");

  const [premiumResult, openInterestResult, longShortResult, klinesResult] = await Promise.allSettled([
    fetchJson(premiumUrl.toString(), undefined, signal),
    fetchJson(openInterestUrl.toString(), undefined, signal),
    fetchJson(longShortUrl.toString(), undefined, signal),
    fetchJson(klinesUrl.toString(), undefined, signal),
  ]);
  throwIfAborted(signal);

  if (premiumResult.status === "rejected" && openInterestResult.status === "rejected") {
    return {
      futures_status: "error",
      futures_error: [
        `premium ${errorMessage(premiumResult.reason)}`,
        `openInterest ${errorMessage(openInterestResult.reason)}`,
      ].join("; "),
    };
  }

  const premium = premiumResult.status === "fulfilled" ? premiumResult.value : {};
  const openInterest =
    openInterestResult.status === "fulfilled" ? openInterestResult.value : {};
  const longShortData = longShortResult.status === "fulfilled" && Array.isArray(longShortResult.value) ? longShortResult.value[0] : {};
  const klines = klinesResult.status === "fulfilled" && Array.isArray(klinesResult.value) ? klinesResult.value : [];

  const klinesSummary = klines.map(k => ({
    time: isoFromMs(k[0]),
    open: num(k[1]),
    high: num(k[2]),
    low: num(k[3]),
    close: num(k[4]),
    volume: num(k[5])
  }));

  return {
    futures_status:
      premiumResult.status === "fulfilled" && openInterestResult.status === "fulfilled"
        ? "ok"
        : "partial",
    futures_mark_price: num(premium.markPrice),
    futures_index_price: num(premium.indexPrice),
    futures_last_funding_rate: num(premium.lastFundingRate),
    futures_next_funding_time: isoFromMs(premium.nextFundingTime),
    futures_open_interest: num(openInterest.openInterest),
    futures_long_short_ratio: num(longShortData?.longShortRatio),
    futures_long_account_pct: num(longShortData?.longAccount),
    futures_short_account_pct: num(longShortData?.shortAccount),
    futures_klines_5m: klinesSummary,
    futures_time: isoFromMs(premium.time || openInterest.time),
    futures_error:
      premiumResult.status === "rejected"
        ? `premium ${errorMessage(premiumResult.reason)}`
        : null,
  };
}

async function fetchFearGreed(signal = null) {
  throwIfAborted(signal);
  const url = new URL(config.fearGreedUrl);
  url.searchParams.set("limit", "7");
  url.searchParams.set("format", "json");

  const json = await fetchJson(url.toString(), config.fundamentalCacheTtlSeconds, signal);
  const rows = Array.isArray(json?.data) ? json.data : [];
  const latest = rows[0] || null;
  const values = rows.map((row) => num(row.value)).filter((value) => value != null);
  const average7d =
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return {
    provider: "Alternative.me Fear & Greed",
    status: latest ? "ok" : "empty",
    current_value: latest ? num(latest.value) : null,
    current_classification: latest?.value_classification || null,
    average_7d: average7d,
    latest_timestamp: latest?.timestamp ? isoFromMs(Number(latest.timestamp) * 1000) : null,
    observations: rows.slice(0, 7).map((row) => ({
      value: num(row.value),
      classification: row.value_classification || null,
      timestamp: row.timestamp ? isoFromMs(Number(row.timestamp) * 1000) : null,
    })),
  };
}

function fearGreedSummary(sentiment) {
  if (!sentiment || sentiment.status !== "ok") return "n/a";
  const current =
    sentiment.current_value == null
      ? "n/a"
      : `${sentiment.current_value}/100 ${sentiment.current_classification || ""}`.trim();
  const avg =
    sentiment.average_7d == null ? "n/a" : `${sentiment.average_7d.toFixed(1)}/100`;
  return `Fear & Greed ${current}, 7d avg ${avg}`;
}

async function fetchDefiLlamaChains(uniqueAssets, signal = null) {
  throwIfAborted(signal);
  const chainNames = uniqueAssets.map((asset) => asset.defillamaChain).filter(Boolean);
  if (!chainNames.length) return [];

  const wanted = new Set(chainNames.map((name) => normalizeText(name)));
  const url = new URL("/v2/chains", config.defillamaBaseUrl);
  const chains = await fetchJson(url.toString(), config.fundamentalCacheTtlSeconds, signal);
  const rows = Array.isArray(chains) ? chains : [];

  return rows
    .filter((row) => wanted.has(normalizeText(row.name)))
    .slice(0, 6)
    .map((row) => ({
      name: row.name,
      tvl_usd: num(row.tvl),
      change_1d_pct: num(row.change_1d),
      change_7d_pct: num(row.change_7d),
      change_1m_pct: num(row.change_1m),
      stablecoins_mcap_usd: num(row.stables),
    }));
}

async function fetchDefiLlamaProtocols(uniqueAssets, signal = null) {
  throwIfAborted(signal);
  const assets = uniqueAssets.filter((asset) => asset.defillamaSlug).slice(0, 3);
  if (!assets.length) return [];

  const results = await Promise.allSettled(
    assets.map(async (asset) => {
      const url = new URL(`/protocol/${asset.defillamaSlug}`, config.defillamaBaseUrl);
      const json = await fetchJson(url.toString(), config.fundamentalCacheTtlSeconds, signal);
      return {
        symbol: asset.symbol,
        name: json.name || asset.name,
        slug: asset.defillamaSlug,
        category: json.category || null,
        tvl_usd: num(json.tvl),
        change_1d_pct: num(json.change_1d),
        change_7d_pct: num(json.change_7d),
        chain_tvls: json.chainTvls
          ? Object.entries(json.chainTvls)
              .map(([chain, tvl]) => ({ chain, tvl_usd: num(tvl) }))
              .sort((a, b) => (b.tvl_usd || 0) - (a.tvl_usd || 0))
              .slice(0, 4)
          : [],
      };
    })
  );

  throwIfAborted(signal);
  return results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
}

async function fetchDefiLlamaStablecoins(uniqueAssets, signal = null) {
  throwIfAborted(signal);
  const stableSymbols = new Set(
    uniqueAssets
      .filter((asset) => asset.symbol === "USDT" || asset.symbol === "USDC")
      .map((asset) => asset.symbol)
  );
  if (!stableSymbols.size) return [];

  const url = new URL("/stablecoins", config.defillamaStablecoinsUrl);
  url.searchParams.set("includePrices", "true");
  const json = await fetchJson(url.toString(), config.fundamentalCacheTtlSeconds, signal);
  const rows = Array.isArray(json?.peggedAssets) ? json.peggedAssets : [];

  return rows
    .filter((row) => stableSymbols.has(String(row.symbol || "").toUpperCase()))
    .slice(0, 4)
    .map((row) => ({
      name: row.name,
      symbol: row.symbol,
      peg_type: row.pegType || null,
      peg_mechanism: row.pegMechanism || null,
      price: num(row.price),
      circulating_usd: num(row.circulating?.peggedUSD ?? row.circulating?.peggedUsd),
      chains: row.chainCirculating
        ? Object.entries(row.chainCirculating)
            .map(([chain, value]) => ({
              chain,
              circulating_usd: num(value?.current?.peggedUSD ?? value?.current?.peggedUsd),
            }))
            .sort((a, b) => (b.circulating_usd || 0) - (a.circulating_usd || 0))
            .slice(0, 4)
        : [],
    }));
}

async function buildDefiLlamaContext(uniqueAssets, signal = null) {
  const [chainsResult, protocolsResult, stablecoinsResult] = await Promise.allSettled([
    fetchDefiLlamaChains(uniqueAssets, signal),
    fetchDefiLlamaProtocols(uniqueAssets, signal),
    fetchDefiLlamaStablecoins(uniqueAssets, signal),
  ]);
  throwIfAborted(signal);

  return {
    provider: "DefiLlama",
    status:
      [chainsResult, protocolsResult, stablecoinsResult].some(
        (result) => result.status === "fulfilled" && result.value?.length
      )
        ? "ok"
        : "empty",
    chains: unwrapResult(chainsResult, []),
    protocols: unwrapResult(protocolsResult, []),
    stablecoins: unwrapResult(stablecoinsResult, []),
    errors: [chainsResult, protocolsResult, stablecoinsResult]
      .filter((result) => result.status === "rejected")
      .map((result) => errorMessage(result.reason)),
  };
}

function defiLlamaSummary(defi) {
  if (!defi || defi.status !== "ok") return "n/a";
  const parts = [];
  for (const chain of defi.chains || []) {
    const change = chain.change_7d_pct == null ? "n/a" : `${chain.change_7d_pct.toFixed(2)}% 7d`;
    parts.push(`${chain.name} TVL ${compactUsd(chain.tvl_usd)} (${change})`);
  }
  for (const protocol of defi.protocols || []) {
    const change =
      protocol.change_7d_pct == null ? "n/a" : `${protocol.change_7d_pct.toFixed(2)}% 7d`;
    parts.push(`${protocol.name} TVL ${compactUsd(protocol.tvl_usd)} (${change})`);
  }
  for (const stable of defi.stablecoins || []) {
    const price = stable.price == null ? "n/a" : stable.price.toFixed(4);
    parts.push(`${stable.symbol} supply ${compactUsd(stable.circulating_usd)}, price ${price}`);
  }
  return parts.slice(0, 6).join("; ") || "n/a";
}

const NEWS_STOPWORDS = new Set([
  "will",
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "before",
  "after",
  "market",
  "markets",
  "polymarket",
  "event",
  "yes",
  "no",
  "hit",
  "above",
  "below",
  "price",
  "prices",
  "increase",
  "decrease",
  "2025",
  "2026",
  "2027",
  "win",
  "who",
  "when",
  "what",
  "where",
  "why",
  "how",
  "election",
  "presidential",
  "president",
  "nominee",
  "candidate",
]);

function extractNewsKeywords(text) {
  const words = normalizeText(text)
    .split(/\s+/)
    .map((word) => word.replace(/^\$+/, ""))
    .filter((word) => word.length >= 3 && !NEWS_STOPWORDS.has(word) && !/^\d+$/.test(word));

  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 6);
}

function newsQueryFor(uniqueAssets, text) {
  const assetTerms = uniqueAssets
    .filter((asset) => !asset.proxyNote)
    .slice(0, 3)
    .map((asset) => asset.name);
  const stableTerms = uniqueAssets
    .filter((asset) => asset.proxyNote)
    .slice(0, 2)
    .map((asset) => asset.symbol);
  const keywords = extractNewsKeywords(text).slice(0, 4);
  
  // Only append "crypto" if there are actually crypto assets detected
  const cryptoTerm = uniqueAssets.length > 0 ? "crypto" : null;
  const terms = [...assetTerms, ...stableTerms, ...keywords, cryptoTerm].filter(Boolean);
  
  return [...new Set(terms)].slice(0, 8).join(" ");
}

async function fetchBinancePair(asset, signal = null) {
  throwIfAborted(signal);
  if (!asset.pair) {
    return {
      symbol: asset.symbol,
      name: asset.name,
      pair: null,
      status: "skipped",
      reason: "Stablecoin/base asset tidak punya pair USDT yang informatif.",
    };
  }

  const tickerUrl = binanceUrl("/api/v3/ticker/24hr", asset.pair);
  const bookUrl = binanceUrl("/api/v3/ticker/bookTicker", asset.pair);
  const klinesUrl = binanceKlinesUrl(asset.pair);
  const [tickerResult, bookResult, klinesResult, futuresResult] = await Promise.allSettled([
    fetchJson(tickerUrl.toString(), undefined, signal),
    fetchJson(bookUrl.toString(), undefined, signal),
    fetchJson(klinesUrl.toString(), undefined, signal),
    fetchBinanceFutures(asset, signal),
  ]);
  throwIfAborted(signal);

  if (tickerResult.status === "rejected") {
    return {
      symbol: asset.symbol,
      name: asset.name,
      pair: asset.pair,
      status: "error",
      error: errorMessage(tickerResult.reason),
    };
  }

  const ticker = tickerResult.value;
  const book = bookResult.status === "fulfilled" ? bookResult.value : {};
  const trend =
    klinesResult.status === "fulfilled"
      ? trendFromKlines(klinesResult.value)
      : trendFromKlines([]);
  const futures =
    futuresResult.status === "fulfilled"
      ? futuresResult.value
      : { futures_status: "error", futures_error: errorMessage(futuresResult.reason) };

  return {
    symbol: asset.symbol,
    name: asset.name,
    pair: asset.pair,
    proxy_note: asset.proxyNote || null,
    status: "ok",
    last_price_usdt: num(ticker.lastPrice),
    weighted_avg_price_24h: num(ticker.weightedAvgPrice),
    price_change_24h: num(ticker.priceChange),
    price_change_24h_pct: num(ticker.priceChangePercent),
    high_24h: num(ticker.highPrice),
    low_24h: num(ticker.lowPrice),
    volume_base_24h: num(ticker.volume),
    volume_quote_24h: num(ticker.quoteVolume),
    trade_count_24h: num(ticker.count),
    best_bid: num(book.bidPrice),
    best_bid_qty: num(book.bidQty),
    best_ask: num(book.askPrice),
    best_ask_qty: num(book.askQty),
    ...trend,
    ...futures,
    close_time: isoFromMs(ticker.closeTime),
    book_error: bookResult.status === "rejected" ? errorMessage(bookResult.reason) : null,
    trend_error: klinesResult.status === "rejected" ? errorMessage(klinesResult.reason) : null,
  };
}

function researchSummary(pairs) {
  const okPairs = pairs.filter((pair) => pair.status === "ok");
  if (!okPairs.length) return "Crypto asset terdeteksi, tapi Binance tidak mengembalikan pair market data.";

  return okPairs
    .map((pair) => {
      const price = pair.last_price_usdt == null ? "n/a" : `${pair.last_price_usdt} USDT`;
      const change4h = pair.price_change_4h_pct == null ? "n/a" : `${pair.price_change_4h_pct.toFixed(2)}%`;
      const change24h = pair.price_change_24h_pct == null ? "n/a" : `${pair.price_change_24h_pct.toFixed(2)}%`;
      const spread = pair.best_bid != null && pair.best_ask != null ? `${(pair.best_ask - pair.best_bid).toFixed(8)} USDT` : "n/a";
      const funding = pair.futures_last_funding_rate == null ? "n/a" : `${(pair.futures_last_funding_rate * 100).toFixed(4)}%`;
      
      const rsi = pair.rsi_14 != null ? `RSI(14): ${pair.rsi_14.toFixed(1)}` : "";
      const sma7 = pair.sma_7 != null ? `SMA(7): ${pair.sma_7.toFixed(2)}` : "";
      const sma30 = pair.sma_30 != null ? `SMA(30): ${pair.sma_30.toFixed(2)}` : "";
      const ta = [rsi, sma7, sma30].filter(Boolean).join(", ");
      
      const trend = pair.ta_trend ? `Trend: ${pair.ta_trend}` : "";
      const sr = (pair.support_24h != null && pair.resistance_24h != null) ? `24h S/R: [${pair.support_24h} - ${pair.resistance_24h}]` : "";
      const volSpike = pair.volume_spike ? `Vol Spike: ${pair.volume_spike}` : "";
      const paStr = [trend, sr, volSpike].filter(Boolean).join(", ");

      const extraStr = [ta, paStr].filter(Boolean).join(" | ");
      const finalExtra = extraStr ? ` | TA: ${extraStr}` : "";

      const proxyNote = pair.proxy_note ? `, note ${pair.proxy_note}` : "";
      return `${pair.pair}: last ${price}, 4h ${change4h}, 24h ${change24h}, book spread ${spread}, futures funding ${funding}${finalExtra}${proxyNote}`;
    })
    .join("; ");
}

async function fetchPremiumNews(queryStr, signal = null) {
  throwIfAborted(signal);
  if (!queryStr) return [];
  try {
    const query = `(site:nytimes.com OR site:pubity.com OR site:wsj.com OR site:bloomberg.com OR site:cryptoslate.com OR site:coinbureau.com OR site:coindesk.com OR site:cointelegraph.com) ${queryStr}`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const key = `ddg_premium:${query}`;
    const cached = getCache(key, 900);
    if (cached) return cached;
    
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    const res = await fetch(url, {
      signal: requestSignal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });
    
    if (!res.ok) return [];
    const html = await res.text();
    
    const snippets = [];
    const regex = /<a class="result__snippet[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const clean = match[1].replace(/<\/?[^>]+(>|$)/g, "").replace(/&\w+;/g, " ").replace(/\s+/g, " ").trim();
      if (clean) snippets.push(clean);
    }
    
    const results = snippets.slice(0, 3);
    setCache(key, results);
    return results;
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

async function fetchForexFactory(signal = null) {
  throwIfAborted(signal);
  try {
    const key = `forex_factory_this_week`;
    const cached = getCache(key, 3600); // cache for 1 hour
    if (cached) return cached;
    
    const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000);
    const res = await fetch(url, {
      signal: requestSignal,
      headers: { "User-Agent": "polymarket-telegram-analyzer/0.1" }
    });
    
    if (!res.ok) return [];
    const json = await res.json();
    
    // Filter only "High" impact news from today onwards
    const todayStr = new Date().toISOString().split("T")[0];
    const highImpact = json.filter(event => 
      event.impact === "High" && 
      event.date.startsWith(todayStr)
    ).map(event => `${event.title} (${event.country}) at ${event.date}`);
    
    setCache(key, highImpact);
    return highImpact;
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

export async function buildResearchContext({ market, event, markets, signal = null } = {}) {
  throwIfAborted(signal);
  const text = marketText({ market, event, markets });
  const primaryText = primaryAssetText({ market, event, markets });
  const forexFactoryNews = await fetchForexFactory(signal);

  const detectedFromTitle = detectCryptoAssets(primaryText);
  const detectedAssets = detectedFromTitle.length ? detectedFromTitle : detectCryptoAssets(text);

  // If no crypto assets, we do a "general" news-only research context
  if (!detectedAssets.length) {
    const premiumSnippets = await fetchPremiumNews(newsQueryFor([], text), signal);
    const premiumNewsText = premiumSnippets.length ? premiumSnippets.join("; ") : "";
    const finalNewsSummary = premiumNewsText ? `PREMIUM NEWS: ${premiumNewsText}` : "n/a";
    
    return {
      type: "general",
      status: premiumSnippets.length ? "ok" : "partial",
      provider: "DDG Premium News",
      fetchedAt: new Date().toISOString(),
      detectedAssets: [],
      summary: "Non-crypto event. No market data available.",
      sentimentSummary: "n/a",
      fundamentalSummary: "n/a",
      newsSummary: finalNewsSummary,
      pairs: [],
      sentiment: null,
      defi: null,
      forexFactory: forexFactoryNews,
      errors: [],
      limitations: [
        "Event ini tidak terdeteksi sebagai event Crypto. Analisis menggunakan keyword general.",
        "Berita headline adalah sinyal kasar dan butuh verifikasi manual.",
      ],
    };
  }

  const uniqueAssets = [];
  const seenPairs = new Set();
  for (const asset of detectedAssets) {
    const key = asset.pair || asset.symbol;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    uniqueAssets.push(asset);
  }

  const pairs = await Promise.all(
    uniqueAssets.map(async (asset) => {
      try {
        return await fetchBinancePair(asset, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          symbol: asset.symbol,
          name: asset.name,
          pair: asset.pair,
          status: "error",
          error: errorMessage(error),
        };
      }
    })
  );
  throwIfAborted(signal);
  const okCount = pairs.filter((pair) => pair.status === "ok").length;
  const [sentimentResult, defiResult, premiumSnippetsResult] = await Promise.allSettled([
    fetchFearGreed(signal),
    buildDefiLlamaContext(uniqueAssets, signal),
    fetchPremiumNews(newsQueryFor(uniqueAssets, text), signal),
  ]);
  throwIfAborted(signal);

  const sentiment = unwrapResult(
    sentimentResult,
    providerError("Alternative.me Fear & Greed", sentimentResult.reason)
  );
  const defi = unwrapResult(defiResult, providerError("DefiLlama", defiResult.reason));
  
  const pSnippets = premiumSnippetsResult.status === "fulfilled" ? premiumSnippetsResult.value : [];
  const premiumNewsText = pSnippets.length ? pSnippets.join("; ") : "";
  const finalNewsSummary = premiumNewsText ? `PREMIUM NEWS: ${premiumNewsText}` : "n/a";

  const extraOk = [sentiment, defi].some(
    (item) => item?.status === "ok" || item?.status === "partial"
  );
  const status =
    okCount === pairs.length && extraOk
      ? "ok"
      : okCount > 0 || extraOk
        ? "partial"
        : "error";

  return {
    type: "crypto",
    status,
    provider: "Binance + DefiLlama + Alternative.me",
    sourceBaseUrl: config.binanceBaseUrl,
    futuresSourceBaseUrl: config.binanceFuturesBaseUrl,
    defiLlamaSourceBaseUrl: config.defillamaBaseUrl,
    fearGreedSourceUrl: config.fearGreedUrl,
    fetchedAt: new Date().toISOString(),
    detectedAssets,
    summary: researchSummary(pairs),
    sentimentSummary: fearGreedSummary(sentiment),
    fundamentalSummary: defiLlamaSummary(defi),
    newsSummary: finalNewsSummary,
    pairs,
    sentiment,
    defi,
    forexFactory: forexFactoryNews,
    errors: pairs
      .filter((pair) => pair.status === "error")
      .map((pair) => `${pair.symbol}: ${pair.error || "unknown error"}`)
      .concat(
        [sentiment, defi]
          .filter((item) => item?.status === "error")
          .map((item) => `${item.provider}: ${item.error || "unknown error"}`)
      ),
    limitations: [
      "Binance data adalah exchange market data, bukan agregat seluruh pasar dan bukan prediksi resolusi Polymarket.",
      "Spot data sudah mencakup snapshot 24 jam dan tren candle harian 7/30 hari.",
      "Futures data mencakup funding rate dan open interest jika pair tersedia di Binance USD-M Futures.",
      "DefiLlama menambah konteks TVL, protocol, dan stablecoin jika asset relevan.",
      "Alternative.me Fear & Greed adalah sentiment market-wide, bukan sentiment khusus satu coin.",
      "Data ini belum mencakup liquidation, ETF flow detail, wallet/whale flow, atau social sentiment premium.",
    ],
  };
}
