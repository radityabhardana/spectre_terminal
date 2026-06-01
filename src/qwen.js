import { config } from "./config.js";

const VALID_VERDICTS = new Set([
  "SKIP",
  "WATCHLIST",
  "VALUE CANDIDATE",
  "HIGH RISK UNDERDOG",
]);

function truncate(value, maxChars) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function nowInJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysUntil(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.round((time - Date.now()) / 86400000);
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty Qwen response");

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Qwen response is not valid JSON");
  }
}

function cleanList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 5);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeAnalysis(value, rawText) {
  const verdict = String(value.verdict || "").trim().toUpperCase();

  return {
    verdict: VALID_VERDICTS.has(verdict) ? verdict : "SKIP",
    confidence: Number.isFinite(Number(value.confidence))
      ? Math.max(0, Math.min(100, Math.round(Number(value.confidence))))
      : null,
    summary: truncate(value.summary || value.ringkasan || "", 420),
    dataQuality: truncate(value.data_quality || value.dataQuality || "", 360),
    bullishCase: cleanList(value.bullish_case || value.bullishCase),
    bearishCase: cleanList(value.bearish_case || value.bearishCase),
    risks: {
      liquidity: truncate(value.risks?.liquidity || value.liquidity_risk || "", 220),
      spread: truncate(value.risks?.spread || value.spread_risk || "", 220),
      resolution: truncate(value.risks?.resolution || value.resolution_risk || "", 220),
      catalyst: truncate(value.risks?.catalyst || value.catalyst || "", 220),
    },
    missingData: cleanList(value.missing_data || value.missingData),
    checklist: {
      liquidity: Boolean(value.checklist?.liquidity),
      spread: Boolean(value.checklist?.spread),
      rules: Boolean(value.checklist?.rules),
      edge: Boolean(value.checklist?.edge),
      catalyst: Boolean(value.checklist?.catalyst),
    },
    finalReason: truncate(value.final_reason || value.finalReason || "", 420),
    rawText,
  };
}

function normalizeEventAnalysis(value, rawText) {
  const ranking = Array.isArray(value.ranking)
    ? value.ranking
        .map((item) => {
          const verdict = String(item.verdict || "").trim().toUpperCase();
          return {
            marketId: String(item.market_id || item.marketId || "").trim(),
            verdict: VALID_VERDICTS.has(verdict) ? verdict : "WATCHLIST",
            reason: truncate(item.reason || "", 260),
          };
        })
        .filter((item) => item.marketId)
        .slice(0, 20)
    : [];

  return {
    eventSummary: truncate(value.event_summary || value.eventSummary || "", 500),
    bestMarketId: String(value.best_market_id || value.bestMarketId || "").trim(),
    bestReason: truncate(value.best_reason || value.bestReason || "", 420),
    ranking,
    avoid: cleanList(value.avoid || value.avoid_markets || value.avoidMarkets),
    missingData: cleanList(value.missing_data || value.missingData),
    finalNote: truncate(value.final_note || value.finalNote || "", 420),
    rawText,
  };
}

function eventHardBlockers(score) {
  return (score.blockers || []).filter((item) => item !== "No measured positive edge");
}

function mechanicalEventFallback(analyzedMarkets, rawText = "") {
  const ranked = [...analyzedMarkets].sort((a, b) => {
    const aBlocked = eventHardBlockers(a.score).length ? 1 : 0;
    const bBlocked = eventHardBlockers(b.score).length ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;

    const aSpread = Number.isFinite(a.score.spreadPercent) ? a.score.spreadPercent : 99;
    const bSpread = Number.isFinite(b.score.spreadPercent) ? b.score.spreadPercent : 99;
    if (aSpread !== bSpread) return aSpread - bSpread;

    return b.market.liquidity + b.market.volume - (a.market.liquidity + a.market.volume);
  });
  const best = ranked.find((item) => eventHardBlockers(item.score).length === 0);

  return normalizeEventAnalysis(
    {
      event_summary:
        "Qwen tidak mengembalikan JSON valid, jadi bot memakai fallback ranking mekanis dari semua market aktif.",
      best_market_id: best?.market.id || "",
      best_reason: best
        ? "Dipilih fallback karena orderbook/spread relatif paling sehat dan market lolos hard blocker."
        : "Tidak ada market yang lolos hard blocker mekanis.",
      ranking: ranked.slice(0, 8).map(({ market, score }) => ({
        market_id: market.id,
        verdict: eventHardBlockers(score).length ? "SKIP" : score.verdict,
        reason: eventHardBlockers(score).length
          ? `Hard blocker: ${eventHardBlockers(score).join("; ")}`
          : `Spread ${score.spreadPercent?.toFixed?.(2) ?? "n/a"}%, confidence ${
              score.confidenceScore
            }/100, liquidity ${Math.round(market.liquidity)}.`,
      })),
      avoid: ranked
        .filter((item) => eventHardBlockers(item.score).length)
        .slice(0, 5)
        .map((item) => `${item.market.id}: ${eventHardBlockers(item.score).join("; ")}`),
      missing_data: ["Fair probability eksternal", "Catalyst/fundamental terbaru"],
      final_note:
        "Fallback ini berbasis market data, bukan analisis fundamental. Gunakan /analyze <Market ID> untuk deep dive pilihan tertentu.",
    },
    rawText
  );
}

async function callQwen(payload) {
  const response = await fetch(`${config.qwenBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.qwenApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Qwen HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

export async function askQwen({ market, score, orderBook }) {
  const marketData = JSON.stringify(
    {
      currentDateAsiaJakarta: nowInJakarta(),
      question: market.question,
      eventGroup: market.eventTitle,
      marketVariant: market.groupItemTitle,
      description: market.description,
      endDate: market.endDate,
      daysUntilEndDate: daysUntil(market.endDate),
      active: market.active,
      closed: market.closed,
      acceptingOrders: market.acceptingOrders,
      liquidity: market.liquidity,
      volume: market.volume,
      outcomes: market.outcomes,
      outcomePrices: market.outcomePrices,
      url: market.url,
    },
    null,
    2
  );

  const prompt = `
Analisis market Polymarket berikut sebelum entry.

CURRENT DATE:
${nowInJakarta()} Asia/Jakarta

DATA MARKET:
${marketData}

ORDERBOOK YES:
${JSON.stringify(orderBook, null, 2).slice(0, config.maxQwenInputChars)}

SCORING AWAL DARI BOT:
${JSON.stringify(score, null, 2)}

Aturan wajib:
- Jangan mengarang data eksternal seperti FedWatch, dot plot, polling, CPI, berita, atau riset bank jika tidak ada di DATA MARKET.
- Jika memakai pengetahuan umum, labeli sebagai asumsi umum, bukan fakta aktual.
- Estimated fair probability dari bot saat ini sama dengan market implied probability, jadi edge mekanis 0 kecuali ada alasan kuat dan diberi label estimasi.
- Jangan berikan markdown. Balas hanya JSON valid.
- Verdict hanya salah satu: SKIP, WATCHLIST, VALUE CANDIDATE, HIGH RISK UNDERDOG.

Format JSON wajib:
{
  "verdict": "SKIP",
  "confidence": 0,
  "summary": "1-2 kalimat inti market dan kondisi entry.",
  "data_quality": "Kualitas data yang tersedia dan batasannya.",
  "bullish_case": ["maks 3 poin"],
  "bearish_case": ["maks 3 poin"],
  "risks": {
    "liquidity": "Low/Medium/High + alasan pendek",
    "spread": "Low/Medium/High + alasan pendek",
    "resolution": "Low/Medium/High + alasan pendek",
    "catalyst": "Ada/tidak ada catalyst + alasan pendek"
  },
  "missing_data": ["maks 4 data yang masih kurang"],
  "checklist": {
    "liquidity": true,
    "spread": true,
    "rules": true,
    "edge": false,
    "catalyst": false
  },
  "final_reason": "Alasan final verdict dalam 1-2 kalimat."
}
`.trim();

  const payload = {
    model: config.qwenModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu analis prediction market yang konservatif. Kamu bukan financial advisor. Tugasmu membedakan data aktual, estimasi, dan data yang tidak tersedia. Jangan mengarang fakta eksternal.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: config.qwenMaxTokens,
    response_format: { type: "json_object" },
  };

  let json;
  try {
    json = await callQwen(payload);
  } catch (error) {
    if (!String(error.message).includes("response_format")) throw error;
    const { response_format, ...fallbackPayload } = payload;
    json = await callQwen(fallbackPayload);
  }

  const text = json.choices?.[0]?.message?.content?.trim() || "";
  let analysis;
  try {
    analysis = normalizeAnalysis(extractJsonObject(text), text);
  } catch {
    analysis = normalizeAnalysis(
      {
        verdict: "SKIP",
        confidence: null,
        summary: "Qwen menjawab, tapi format JSON gagal dibaca.",
        data_quality: "Analisis mentah disimpan di rawText.",
        bearish_case: ["Format Qwen tidak valid, jadi bot tidak memakai verdict bebas dari model."],
        final_reason: "Skip karena output model tidak terstruktur.",
      },
      text
    );
  }

  return {
    provider: "qwen",
    model: json.model || config.qwenModel,
    usage: json.usage || null,
    analysis,
  };
}

export async function askQwenEvent({ event, analyzedMarkets }) {
  const compactMarkets = analyzedMarkets.map(({ market, score }) => ({
    market_id: market.id,
    question: market.question,
    variant: market.groupItemTitle,
    status: market.closed ? "closed" : market.acceptingOrders ? "open" : "active_orders_unclear",
    yes_price: market.outcomePrices?.[0] ?? null,
    no_price: market.outcomePrices?.[1] ?? null,
    liquidity: market.liquidity,
    volume: market.volume,
    implied_probability_percent: score.marketProbability,
    best_bid: score.bestBid,
    best_ask: score.bestAsk,
    spread_percent: score.spreadPercent,
    confidence: score.confidenceScore,
    underdog_score: score.underdogScore,
    liquidity_risk: score.liquidityRisk,
    spread_risk: score.spreadRisk,
    resolution_risk: score.resolutionRisk,
    blockers: score.blockers,
    mechanical_verdict: score.verdict,
  }));

  const prompt = `
Bandingkan semua pilihan aktif dalam satu event Polymarket dan tentukan mana yang paling layak dipantau.

CURRENT DATE:
${nowInJakarta()} Asia/Jakarta

EVENT:
${JSON.stringify(
  {
    title: event?.title,
    description: event?.description,
    endDate: event?.endDate,
    url: event?.url,
  },
  null,
  2
)}

MARKETS:
${JSON.stringify(compactMarkets, null, 2)}

Aturan wajib:
- Jangan mengarang data eksternal seperti polling, berita, FedWatch, on-chain data, atau filing jika tidak ada di input.
- Nilai "worth it" di sini berarti paling layak dipantau/diteliti dari data market, bukan pasti value.
- Karena belum ada fair probability eksternal, jangan klaim VALUE CANDIDATE kecuali alasannya sangat konservatif.
- Prioritaskan market dengan orderbook sehat, spread rendah, liquidity cukup, rules jelas, dan alasan risiko yang masuk akal.
- Balas hanya JSON valid, tanpa markdown.
- Field ranking cukup TOP 8 paling layak dipantau setelah mempertimbangkan semua market. Jangan tulis semua market di JSON.

Format JSON wajib:
{
  "event_summary": "ringkasan event dan jumlah pilihan aktif",
  "best_market_id": "id market paling layak dipantau, atau kosong kalau semua skip",
  "best_reason": "alasan ringkas kenapa pilihan itu paling worth it dibanding lainnya",
  "ranking": [
    {
      "market_id": "123",
      "verdict": "SKIP",
      "reason": "alasan pendek"
    }
  ],
  "avoid": ["market/tipe pilihan yang sebaiknya dihindari dan alasannya"],
  "missing_data": ["data eksternal yang perlu dicek sebelum entry"],
  "final_note": "catatan final untuk user"
}
`.trim();

  const payload = {
    model: config.qwenModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu analis event prediction market yang konservatif. Kamu membandingkan semua pilihan, bukan memilih otomatis secara buta. Jangan mengarang fakta eksternal.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: config.qwenMaxTokens,
    response_format: { type: "json_object" },
  };

  let json;
  try {
    json = await callQwen(payload);
  } catch (error) {
    if (!String(error.message).includes("response_format")) throw error;
    const { response_format, ...fallbackPayload } = payload;
    json = await callQwen(fallbackPayload);
  }

  const text = json.choices?.[0]?.message?.content?.trim() || "";
  let analysis;
  try {
    analysis = normalizeEventAnalysis(extractJsonObject(text), text);
  } catch {
    analysis = mechanicalEventFallback(analyzedMarkets, text);
  }

  return {
    provider: "qwen",
    model: json.model || config.qwenModel,
    usage: json.usage || null,
    analysis,
  };
}
