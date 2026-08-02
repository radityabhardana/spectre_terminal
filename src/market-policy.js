const UFC_TOKEN = /(?:^|[^a-z0-9])ufc(?=$|[^a-z0-9])/i;
const UFC_NAME = /(?:^|[^a-z0-9])ultimate\s+fighting\s+championship(?=$|[^a-z0-9])/i;
const UFC_SLUG_NAME = /(?:^|[^a-z0-9])ultimate[^a-z0-9]+fighting[^a-z0-9]+championship(?=$|[^a-z0-9])/i;
const MAX_PATH_DECODE_PASSES = 2;

function hasUfcText(value) {
  return typeof value === "string" && (UFC_TOKEN.test(value) || UFC_NAME.test(value));
}

function hasUfcSlug(value) {
  return typeof value === "string" && (UFC_TOKEN.test(value) || UFC_SLUG_NAME.test(value));
}

function decodePathSegments(value) {
  if (typeof value !== "string") return value;
  return value.split("/").map((segment) => {
    let decoded = segment;
    for (let pass = 0; pass < MAX_PATH_DECODE_PASSES; pass++) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    return decoded;
  }).join("/");
}

function hasUfcResolutionSource(value) {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const source = /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())
      ? new URL(value.trim())
      : new URL(`https://${value.trim()}`);
    const hostname = source.hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "ufc.com" || hostname.endsWith(".ufc.com");
  } catch {
    return false;
  }
}

function exactUfcTag(tag) {
  if (typeof tag === "string") return tag.trim().toLowerCase() === "ufc";
  if (!tag || typeof tag !== "object") return false;
  return [tag.label, tag.slug].some(
    (value) => typeof value === "string" && value.trim().toLowerCase() === "ufc",
  );
}

function hasUfcCategory(category) {
  if (typeof category === "string") return hasUfcText(category) || hasUfcSlug(category);
  if (!category || typeof category !== "object") return false;
  return [category.label, category.name, category.title].some(hasUfcText)
    || [category.slug, category.ticker].some(hasUfcSlug);
}

function hasUfcSeries(series) {
  if (typeof series === "string") return hasUfcSlug(series);
  if (!series || typeof series !== "object") return false;
  return [series.slug, series.ticker, series.seriesSlug].some(hasUfcSlug) || hasUfcText(series.title);
}

function values(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function isBlockedUfcMarket(market, event = null) {
  const queue = [market, event];
  const visited = new Set();

  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }

    if ([value.question, value.title, value.eventTitle, value.market_question, value.description].some(hasUfcText)) return true;
    if ([value.slug, value.eventSlug, value.market_slug, value.ticker].some(hasUfcSlug)) return true;
    if (hasUfcSlug(value.sportsMarketType)) return true;
    if (hasUfcSlug(decodePathSegments(value.urlPath))) return true;
    if (typeof value.url === "string") {
      try {
        const pathname = new URL(value.url, "https://local.invalid").pathname;
        if (hasUfcSlug(decodePathSegments(pathname))) return true;
      } catch {}
    }
    if (hasUfcResolutionSource(value.resolutionSource)) return true;
    if (hasUfcSlug(value.seriesSlug)) return true;

    if (values(value.category).some(hasUfcCategory)) return true;
    if (values(value.tags).some(exactUfcTag)) return true;
    if (values(value.series).some(hasUfcSeries)) return true;

    for (const key of ["raw", "event", "events", "markets", "rawEvent", "rawEvents", "raw_event", "raw_events"]) {
      queue.push(...values(value[key]));
    }
    for (const series of values(value.series)) {
      if (series && typeof series === "object") queue.push(series);
    }
  }

  return false;
}

export function assertMarketAllowed(market, event = null) {
  if (!isBlockedUfcMarket(market, event)) return market;

  const error = new Error("UFC markets are unsupported");
  error.code = "UNSUPPORTED_UFC";
  error.status = 422;
  throw error;
}
