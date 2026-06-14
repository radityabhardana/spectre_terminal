import { config } from "./config.js";
import { getCache, setCache } from "./storage.js";

async function fetchJson(url) {
  const cached = getCache(url);
  if (cached) return cached;

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "polymarket-telegram-analyzer/0.1",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`);
  }

  const json = await response.json();
  setCache(url, json);
  return json;
}

function safeJsonParse(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const SEARCH_ENGINE_VERSION = "public-search-v2-event-wide-analysis-v14-top-market-discovery";

function normalizeMarket(raw, event = null, eventSearchRank = 999) {
  const outcomes = safeJsonParse(raw.outcomes, raw.outcomes || []);
  const outcomePrices = safeJsonParse(raw.outcomePrices, raw.outcomePrices || []);
  const clobTokenIds = safeJsonParse(raw.clobTokenIds, raw.clobTokenIds || []);
  const eventSlug = event?.slug || "";
  const marketSlug = raw.slug || "";

  return {
    id: String(raw.id ?? raw.conditionId ?? ""),
    conditionId: raw.conditionId || raw.condition_id || "",
    question: raw.question || raw.title || raw.slug || "Untitled market",
    slug: marketSlug,
    eventTitle: event?.title || "",
    eventSlug,
    eventSearchRank,
    groupItemTitle: raw.groupItemTitle || "",
    selectionNote: raw.selectionNote || "",
    eventOpenMarketCount: raw.eventOpenMarketCount || null,
    url: eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : marketSlug
        ? `https://polymarket.com/event/${marketSlug}`
        : "",
    description: raw.description || "",
    resolutionSource: raw.resolutionSource || event?.resolutionSource || "",
    endDate: raw.endDate || raw.end_date || raw.endDateIso || "",
    startDate: raw.startDate || raw.start_date || raw.startDateIso || raw.createdAt || "",
    updatedAt: raw.updatedAt || raw.updated_at || "",
    active: raw.active ?? true,
    closed: raw.closed ?? false,
    acceptingOrders: raw.acceptingOrders ?? false,
    volume: Number(raw.volumeNum ?? raw.volume ?? raw.volume24hr ?? 0),
    volume24hr: Number(raw.volume24hr ?? raw.volume24hrNum ?? raw.volume24h ?? raw.volumeNum ?? raw.volume ?? 0),
    liquidity: Number(raw.liquidityNum ?? raw.liquidity ?? 0),
    outcomes,
    outcomePrices: outcomePrices.map(Number),
    clobTokenIds: clobTokenIds.map(String),
    raw,
  };
}

function listRows(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

export function topMarketMode(input = "") {
  const value = normalizeText(input || "volume");

  if (["liquidity", "liq", "liquid"].includes(value)) {
    return {
      mode: "liquidity",
      title: "Top markets by liquidity",
      apiOrder: "liquidity",
      ascending: false,
      metric: (market) => market.liquidity,
      metricLabel: "Liquidity",
    };
  }

  if (["ending", "close", "closing", "deadline", "soon"].includes(value)) {
    return {
      mode: "ending",
      title: "Markets closing soon",
      apiOrder: "end_date",
      ascending: true,
      metric: (market) => {
        const time = new Date(market.endDate).getTime();
        return Number.isFinite(time) ? -time : Number.NEGATIVE_INFINITY;
      },
      metricLabel: "Close",
    };
  }

  if (["new", "newest", "recent", "fresh"].includes(value)) {
    return {
      mode: "new",
      title: "Newest active markets",
      apiOrder: "start_date",
      ascending: false,
      metric: (market) => {
        const time = new Date(market.startDate || market.updatedAt).getTime();
        return Number.isFinite(time) ? time : 0;
      },
      metricLabel: "Start",
    };
  }

  return {
    mode: "volume",
    title: "Top markets by 24h volume",
    apiOrder: "volume_24hr",
    ascending: false,
    metric: (market) => market.volume24hr || market.volume,
    metricLabel: "24h Volume",
  };
}

function sortByTopMetric(markets, config) {
  return [...markets].sort((a, b) => {
    const metricDiff = Number(config.metric(b) || 0) - Number(config.metric(a) || 0);
    if (metricDiff !== 0) return metricDiff;

    const liquidityDiff = b.liquidity - a.liquidity;
    if (liquidityDiff !== 0) return liquidityDiff;

    return (b.volume24hr || b.volume) - (a.volume24hr || a.volume);
  });
}

async function fetchTopEvents(modeConfig, limit) {
  const url = new URL("/events", config.gammaUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", modeConfig.apiOrder);
  url.searchParams.set("ascending", String(modeConfig.ascending));
  url.searchParams.set("limit", String(Math.max(limit * 4, 40)));
  return fetchJson(url.toString());
}

async function fetchTopMarketRows(modeConfig, limit) {
  const url = new URL("/markets", config.gammaUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", modeConfig.apiOrder);
  url.searchParams.set("ascending", String(modeConfig.ascending));
  url.searchParams.set("limit", String(Math.max(limit * 2, 20)));
  return fetchJson(url.toString());
}

export async function listTopMarkets({ mode = "volume", limit = 10 } = {}) {
  const modeConfig = topMarketMode(mode);
  const eventsData = await fetchTopEvents(modeConfig, limit);
  const eventRows = listRows(eventsData, "events");
  const eventMarkets = eventRows.flatMap((event, eventIndex) =>
    Array.isArray(event.markets)
      ? event.markets.map((market) => normalizeMarket(market, event, eventIndex))
      : []
  );

  let markets = eventMarkets.filter(openTradableMarket);

  if (!markets.length) {
    const marketsData = await fetchTopMarketRows(modeConfig, limit);
    markets = listRows(marketsData, "markets")
      .map((market) => normalizeMarket(market))
      .filter(openTradableMarket);
  }

  return {
    mode: modeConfig.mode,
    title: modeConfig.title,
    metricLabel: modeConfig.metricLabel,
    markets: sortByTopMetric(markets, modeConfig).slice(0, limit),
  };
}

function openTradableMarket(market) {
  return market.active && !market.closed && market.clobTokenIds.length > 0;
}

function sortEventMarkets(markets) {
  return [...markets].sort((a, b) => {
    const aOrders = a.acceptingOrders ? 1 : 0;
    const bOrders = b.acceptingOrders ? 1 : 0;
    if (aOrders !== bOrders) return bOrders - aOrders;

    return b.liquidity + b.volume - (a.liquidity + a.volume);
  });
}

function withSelectionNote(market, note, openCount) {
  return {
    ...market,
    selectionNote: note,
    eventOpenMarketCount: openCount,
  };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function queryTokens(keyword) {
  return normalizeText(keyword)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function relevanceScore(market, keyword) {
  const normalizedQuery = normalizeText(keyword);
  const tokens = queryTokens(keyword);
  const question = normalizeText(market.question);
  const slug = normalizeText(market.slug);
  const eventTitle = normalizeText(market.eventTitle);
  const eventSlug = normalizeText(market.eventSlug);
  const description = normalizeText(market.description);
  const haystack = `${question} ${slug} ${eventTitle} ${eventSlug} ${description}`;

  if (!tokens.length) return 0;

  let score = 0;
  if (question === normalizedQuery) score += 120;
  if (slug === normalizedQuery) score += 100;
  if (eventTitle === normalizedQuery) score += 120;
  if (eventSlug === normalizedQuery) score += 100;

  if (question.includes(normalizedQuery)) score += 40;
  if (slug.includes(normalizedQuery)) score += 25;
  if (eventTitle.includes(normalizedQuery)) score += 35;
  if (eventSlug.includes(normalizedQuery)) score += 25;
  if (description.includes(normalizedQuery)) score += 10;

  for (const token of tokens) {
    const root = token.length >= 7 ? token.slice(0, 7) : token;
    if (question.includes(token)) score += 12;
    else if (question.includes(root)) score += 7;

    if (slug.includes(token)) score += 8;
    else if (slug.includes(root)) score += 4;

    if (eventTitle.includes(token)) score += 10;
    else if (eventTitle.includes(root)) score += 6;

    if (eventSlug.includes(token)) score += 8;
    else if (eventSlug.includes(root)) score += 4;

    if (description.includes(token)) score += 3;
    else if (description.includes(root)) score += 1;

    if (!haystack.includes(token) && !haystack.includes(root)) score -= 4;
  }

  return score;
}

function sortMarkets(markets, keyword) {
  return [...markets].sort((a, b) => {
    const relevanceDiff = b.relevanceScore - a.relevanceScore;
    if (relevanceDiff !== 0) return relevanceDiff;

    const eventRankDiff = a.eventSearchRank - b.eventSearchRank;
    if (eventRankDiff !== 0) return eventRankDiff;

    const aOpen = a.active && !a.closed ? 1 : 0;
    const bOpen = b.active && !b.closed ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;

    return (b.liquidity + b.volume) - (a.liquidity + a.volume);
  });
}

export async function searchMarkets(keyword, limit = 5) {
  const url = new URL("/public-search", config.gammaUrl);
  url.searchParams.set("q", keyword);
  url.searchParams.set("limit_per_type", String(Math.max(limit, 10)));
  url.searchParams.set("events_status", "active");
  url.searchParams.set("search_profiles", "false");

  const data = await fetchJson(url.toString());

  const directMarkets = Array.isArray(data.markets) ? data.markets : [];
  const eventMarkets = Array.isArray(data.events)
    ? data.events.flatMap((event, eventIndex) =>
        Array.isArray(event.markets)
          ? event.markets.map((market) => normalizeMarket(market, event, eventIndex))
          : []
      )
    : [];

  const scored = [...directMarkets.map((market) => normalizeMarket(market)), ...eventMarkets]
    .filter((market) => market.active && !market.closed)
    .map((market) => ({
      ...market,
      relevanceScore: relevanceScore(market, keyword),
    }))
    .filter((market) => market.relevanceScore > 0 && market.clobTokenIds.length > 0);

  return sortMarkets(scored, keyword).slice(0, limit);
}

export async function getMarketById(marketId) {
  const url = new URL(`/markets/${marketId}`, config.gammaUrl);
  const data = await fetchJson(url.toString());
  return normalizeMarket(data);
}

export async function getMarketBySlug(slug) {
  const url = new URL(`/markets/slug/${slug}`, config.gammaUrl);
  const data = await fetchJson(url.toString());
  return normalizeMarket(data);
}

export async function getEventBySlug(slug) {
  const url = new URL(`/events/slug/${slug}`, config.gammaUrl);
  return fetchJson(url.toString());
}

function normalizeEvent(raw) {
  return {
    id: String(raw?.id || ""),
    title: raw?.title || raw?.ticker || raw?.slug || "Untitled event",
    slug: raw?.slug || "",
    description: raw?.description || "",
    endDate: raw?.endDate || "",
    url: raw?.slug ? `https://polymarket.com/event/${raw.slug}` : "",
    raw,
  };
}

export function parsePolymarketLink(value) {
  const input = String(value || "").trim();
  if (!/^https?:\/\//i.test(input)) return null;

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "polymarket.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const eventIndex = parts.indexOf("event");
  const marketIndex = parts.indexOf("market");
  const fallbackSlug = parts.at(-1);

  if (eventIndex >= 0 && parts[eventIndex + 1]) {
    return { type: "event", slug: decodeSlug(parts[eventIndex + 1]), url: input };
  }
  if (marketIndex >= 0 && parts[marketIndex + 1]) {
    return { type: "market", slug: decodeSlug(parts[marketIndex + 1]), url: input };
  }

  if (isPolymarketSlug(fallbackSlug)) {
    return { type: "slug", slug: decodeSlug(fallbackSlug), url: input };
  }

  return null;
}

function decodeSlug(value) {
  try {
    return decodeURIComponent(String(value || "").trim());
  } catch {
    return String(value || "").trim();
  }
}

function isPolymarketSlug(value) {
  const slug = decodeSlug(value);
  return /^[a-z0-9][a-z0-9-]{2,}$/i.test(slug);
}

export async function getMarketFromPolymarketLink(value) {
  const parsed = parsePolymarketLink(value);
  if (!parsed) return null;

  const tryMarketSlug = async () => {
    try {
      return await getMarketBySlug(parsed.slug);
    } catch {
      return null;
    }
  };

  const tryEventSlug = async () => {
    try {
      const event = await getEventBySlug(parsed.slug);
      const markets = Array.isArray(event.markets)
        ? event.markets.map((market) => normalizeMarket(market, event))
        : [];
      const openMarkets = sortEventMarkets(markets.filter(openTradableMarket));
      if (!openMarkets.length) return null;

      const selected = openMarkets[0];
      const note =
        openMarkets.length > 1
          ? `Auto-selected 1 dari ${openMarkets.length} market aktif di event link berdasarkan acceptingOrders dan liquidity/volume. Pakai /search ${parsed.slug} kalau mau pilih market lain.`
          : "Auto-selected satu-satunya market aktif dari event link.";

      return withSelectionNote(selected, note, openMarkets.length);
    } catch {
      return null;
    }
  };

  const trySearchSlug = async () => {
    try {
      const query = parsed.slug.replace(/-/g, " ");
      const markets = await searchMarkets(query, 1);
      return markets[0] || null;
    } catch {
      return null;
    }
  };

  if (parsed.type === "market") {
    return (await tryMarketSlug()) || (await tryEventSlug()) || (await trySearchSlug());
  }

  if (parsed.type === "event" || parsed.type === "slug") {
    return (await tryEventSlug()) || (await tryMarketSlug()) || (await trySearchSlug());
  }

  return (await tryMarketSlug()) || (await tryEventSlug()) || (await trySearchSlug());
}

export async function getMarketsFromPolymarketLink(value) {
  const parsed = parsePolymarketLink(value);
  if (!parsed) return null;

  const tryMarketSlug = async () => {
    try {
      const market = await getMarketBySlug(parsed.slug);
      return {
        kind: "market",
        event: null,
        markets: market ? [market] : [],
      };
    } catch {
      return null;
    }
  };

  const tryEventSlug = async () => {
    try {
      const eventRaw = await getEventBySlug(parsed.slug);
      const event = normalizeEvent(eventRaw);
      const markets = Array.isArray(eventRaw.markets)
        ? eventRaw.markets.map((market) => normalizeMarket(market, eventRaw))
        : [];
      const openMarkets = sortEventMarkets(markets.filter(openTradableMarket));

      return {
        kind: openMarkets.length > 1 ? "event" : "market",
        event,
        markets: openMarkets,
      };
    } catch {
      return null;
    }
  };

  const trySearchSlug = async () => {
    try {
      const query = parsed.slug.replace(/-/g, " ");
      const markets = await searchMarkets(query, 10);
      if (!markets.length) return null;

      return {
        kind: markets.length > 1 ? "event" : "market",
        event: {
          id: "",
          title: `Search fallback: ${parsed.slug}`,
          slug: parsed.slug,
          description: "",
          endDate: "",
          url: parsed.url,
          raw: null,
        },
        markets,
      };
    } catch {
      return null;
    }
  };

  if (parsed.type === "market") {
    return (await tryMarketSlug()) || (await tryEventSlug()) || (await trySearchSlug());
  }

  if (parsed.type === "event" || parsed.type === "slug") {
    return (await tryEventSlug()) || (await tryMarketSlug()) || (await trySearchSlug());
  }

  return (await tryMarketSlug()) || (await tryEventSlug()) || (await trySearchSlug());
}

export async function getOrderBook(tokenId) {
  const url = new URL("/book", config.clobUrl);
  url.searchParams.set("token_id", tokenId);
  return fetchJson(url.toString());
}

export function pickYesNoTokens(market) {
  const yesIndex = market.outcomes.findIndex((x) => String(x).toLowerCase() === "yes");
  const noIndex = market.outcomes.findIndex((x) => String(x).toLowerCase() === "no");
  const primaryIndex = yesIndex >= 0 ? yesIndex : 0;
  const secondaryIndex = noIndex >= 0 ? noIndex : primaryIndex === 0 ? 1 : 0;

  return {
    yesTokenId: market.clobTokenIds[primaryIndex],
    noTokenId: market.clobTokenIds[secondaryIndex],
    yesPrice: market.outcomePrices[primaryIndex],
    noPrice: market.outcomePrices[secondaryIndex],
    yesLabel: market.outcomes[primaryIndex] || "Yes",
    noLabel: market.outcomes[secondaryIndex] || "No",
    yesIndex: primaryIndex,
    noIndex: secondaryIndex,
  };
}
