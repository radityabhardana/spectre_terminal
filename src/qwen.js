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

function compactOrderBook(book, levels = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  return {
    asset_id: book?.asset_id || null,
    bids_count: bids.length,
    asks_count: asks.length,
    top_bids: bids.slice(0, levels).map((item) => ({
      price: item.price,
      size: item.size,
    })),
    top_asks: asks.slice(0, levels).map((item) => ({
      price: item.price,
      size: item.size,
    })),
  };
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
    confidence: Number.isFinite(Number(value.confidence)) && Number(value.confidence) > 0
      ? Math.max(1, Math.min(100, Math.round(Number(value.confidence))))
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

function normalizeScout(value, rawText) {
  return {
    taskType: truncate(value.task_type || value.taskType || "", 80),
    complexity: truncate(value.complexity || "", 80),
    mainQuestion: truncate(value.main_question || value.mainQuestion || "", 220),
    marketType: truncate(value.market_type || value.marketType || "", 120),
    riskFocus: cleanList(value.risk_focus || value.riskFocus),
    missingData: cleanList(value.missing_data || value.missingData),
    recommendedDepth: truncate(value.recommended_depth || value.recommendedDepth || "", 80),
    rawText,
  };
}

function normalizeAnalystReview(value, rawText) {
  const verdict = String(value.preliminary_verdict || value.preliminaryVerdict || "").trim().toUpperCase();

  return {
    rulesSummary: truncate(value.rules_summary || value.rulesSummary || "", 360),
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
    preliminaryVerdict: VALID_VERDICTS.has(verdict) ? verdict : "WATCHLIST",
    confidence: Number.isFinite(Number(value.confidence)) && Number(value.confidence) > 0
      ? Math.max(1, Math.min(100, Math.round(Number(value.confidence))))
      : null,
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

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Prompt dibatalkan.");
    error.name = "AbortError";
    throw error;
  }
}

async function callQwen(payload, signal = null) {
  throwIfAborted(signal);
  const response = await fetch(`${config.qwenBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.qwenApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Qwen HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

async function callQwenJson(payload, signal = null) {
  let json;
  try {
    json = await callQwen(payload, signal);
  } catch (error) {
    if (!String(error.message).includes("response_format")) throw error;
    const { response_format, ...fallbackPayload } = payload;
    json = await callQwen(fallbackPayload, signal);
  }

  const text = json.choices?.[0]?.message?.content?.trim() || "";
  return {
    json,
    text,
    model: json.model || payload.model,
    usage: json.usage || null,
  };
}

async function callRoleQwenJson(payload, fallbackModel = "", signal = null) {
  try {
    return await callQwenJson(payload, signal);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (/Qwen HTTP (401|403)/.test(String(error.message))) throw error;
    if (!fallbackModel || payload.model === fallbackModel) throw error;
    const fallback = await callQwenJson({ ...payload, model: fallbackModel }, signal);
    return { ...fallback, fallbackFrom: payload.model };
  }
}

function usageValue(usage, key) {
  const value = usage?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function promptUsage(usage) {
  return usageValue(usage, "prompt_tokens") || usageValue(usage, "input_tokens");
}

function completionUsage(usage) {
  return usageValue(usage, "completion_tokens") || usageValue(usage, "output_tokens");
}

function aggregateUsage(roleResults) {
  const usages = roleResults.map((item) => item.usage).filter(Boolean);
  if (!usages.length) return null;

  const prompt = usages.reduce((sum, usage) => sum + promptUsage(usage), 0);
  const completion = usages.reduce((sum, usage) => sum + completionUsage(usage), 0);
  const total = usages.reduce((sum, usage) => {
    const explicit = usageValue(usage, "total_tokens");
    return sum + (explicit || promptUsage(usage) + completionUsage(usage));
  }, 0);

  return {
    prompt_tokens: prompt || undefined,
    completion_tokens: completion || undefined,
    total_tokens: total || undefined,
    role_usage: Object.fromEntries(roleResults.map((item) => [item.role, item.usage || null])),
  };
}

function pipelineModelLabel(models) {
  return `fast:${models.fast} | analyst:${models.analyst} | final:${models.final}`;
}

function roleMaxTokens(role) {
  const total = Math.max(900, config.qwenMaxTokens);
  if (role === "fast") return Math.max(300, Math.floor(total * 0.1));
  if (role === "analyst") return Math.max(300, Math.floor(total * 0.3));
  return Math.max(300, total - roleMaxTokens("fast") - roleMaxTokens("analyst"));
}

function parseJsonOr(value, fallback) {
  try {
    return extractJsonObject(value);
  } catch {
    return fallback;
  }
}

function promptSafe(value) {
  if (!value || typeof value !== "object") return value;
  const { rawText, ...rest } = value;
  return rest;
}

function researchBlock(researchContext) {
  if (!researchContext || researchContext.status === "skipped") {
    return [
      "EXTERNAL RESEARCH CONTEXT:",
      "Tidak tersedia. Jangan mengarang data eksternal.",
    ].join("\n");
  }

  // Compress the context to make API calls highly efficient while preserving the best analysis data
  const compressedContext = {
    provider: researchContext.provider,
    type: researchContext.type,
    summary: researchContext.summary,
    sentiment: researchContext.sentimentSummary,
    fundamental: researchContext.fundamentalSummary,
    news: researchContext.newsSummary,
    fighterConditions: researchContext.fighterConditions,
    limitations: researchContext.limitations
  };

  return [
    "EXTERNAL RESEARCH CONTEXT (COMPRESSED):",
    JSON.stringify(compressedContext, null, 2),
  ].join("\n");
}

export async function askQwen({ market, score, orderBook, researchContext = null, signal = null }) {
  throwIfAborted(signal);
  const primaryOutcomeLabel = String(score?.primaryOutcomeLabel || market.outcomes?.[0] || "YES");
  const secondaryOutcomeLabel = String(score?.secondaryOutcomeLabel || market.outcomes?.[1] || "NO");
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
      primaryOutcomeLabel,
      secondaryOutcomeLabel,
      url: market.url,
    },
    null,
    2
  );

  const sharedContext = `
CURRENT DATE:
${nowInJakarta()} Asia/Jakarta

DATA MARKET:
${marketData}

ORDERBOOK ${primaryOutcomeLabel.toUpperCase()} (TOP LEVELS ONLY):
${JSON.stringify(compactOrderBook(orderBook), null, 2).slice(0, config.maxQwenInputChars)}

SCORING AWAL DARI BOT:
${JSON.stringify(score, null, 2)}

${researchBlock(researchContext)}
`.trim();

  const scoutPrompt = `
Klasifikasikan market Polymarket ini secara cepat sebelum dianalisis lebih dalam.

${sharedContext}

Aturan:
- Jangan mengarang data eksternal.
- Jika ada statistik UFC dan kondisi fisik/mental (fighterConditions dari DDG Scraper), evaluasi momentum (training camp, cedera, perilaku) dan keunggulan teknis.
- Tugasmu hanya membuat brief pendek untuk analis berikutnya.
- Balas hanya JSON valid.

Format JSON:
{
  "task_type": "single_market_analysis",
  "complexity": "simple/medium/complex",
  "main_question": "inti pertanyaan market",
  "market_type": "politik/makro/crypto/sports/lainnya",
  "risk_focus": ["maks 4 risiko utama yang perlu dicek"],
  "missing_data": ["maks 4 data eksternal yang masih kurang"],
  "recommended_depth": "fast/standard/deep"
}
`.trim();

  const scoutPayload = {
    model: config.qwenFastModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu model fast scout. Tugasmu membaca input cepat, mengklasifikasi kompleksitas, dan memberi brief ringkas tanpa analisis panjang.",
      },
      { role: "user", content: scoutPrompt },
    ],
    temperature: 0,
    max_tokens: roleMaxTokens("fast"),
    response_format: { type: "json_object" },
  };

  const scoutJson = await callRoleQwenJson(scoutPayload, config.qwenAnalystModel, signal);
  const scout = normalizeScout(parseJsonOr(scoutJson.text, {}), scoutJson.text);

  const analystPrompt = `
Review market Polymarket ini sebagai analis risiko. Kamu bukan final judge.

${sharedContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

Aturan:
- Jangan mengarang data eksternal jika tidak ada di DATA MARKET / EXTERNAL RESEARCH CONTEXT.
- Jika ada statistik UFC dan data 'fighterConditions' (Scraper), jadikan sebagai analisis data-driven utama. Analisis kondisi fisik, mental, training camp, atau cedera terbaru dari cuplikan artikel tersebut.
- Kalau memakai pengetahuan umum, labeli sebagai asumsi umum.
- Fokus pada aturan resolusi, risiko, missing data, dan bull/bear case.
- Balas hanya JSON valid.

Format JSON:
{
  "rules_summary": "ringkasan aturan resolusi dan hal yang menentukan outcome utama/lawan",
  "data_quality": "kualitas data yang tersedia dan batasannya",
  "bullish_case": ["maks 3 poin"],
  "bearish_case": ["maks 3 poin"],
  "risks": {
    "liquidity": "Low/Medium/High + alasan pendek",
    "spread": "Low/Medium/High + alasan pendek",
    "resolution": "Low/Medium/High + alasan pendek",
    "catalyst": "Ada/tidak ada catalyst + alasan pendek"
  },
  "missing_data": ["maks 4 data yang masih kurang"],
  "preliminary_verdict": "SKIP/WATCHLIST/VALUE CANDIDATE/HIGH RISK UNDERDOG",
  "confidence": 65
}
`.trim();

  const analystPayload = {
    model: config.qwenAnalystModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu model analyst/reviewer. Tugasmu membedah risk, rules, bull/bear case, dan missing data secara konservatif.",
      },
      { role: "user", content: analystPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("analyst"),
    response_format: { type: "json_object" },
  };

  const analystJson = await callRoleQwenJson(analystPayload, config.qwenFinalModel, signal);
  const analyst = normalizeAnalystReview(parseJsonOr(analystJson.text, {}), analystJson.text);

  const finalPrompt = `
Kamu final judge untuk market Polymarket. Ambil keputusan akhir dari data market, scoring bot, fast scout, dan analyst review.

${sharedContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

ANALYST REVIEW:
${JSON.stringify(promptSafe(analyst), null, 2)}

Aturan wajib:
- Jangan mengarang data eksternal jika tidak ada di DATA MARKET / EXTERNAL RESEARCH CONTEXT.
- Jika ada data kondisi fisik/mental petarung (fighterConditions), berikan bobot lebih pada psikologi, cedera, dan kesiapan (camp) mereka.
- Jangan ragu memberikan verdict "HIGH RISK UNDERDOG" jika harga saham murah (probabilitas ≤35%) tapi data fisik/mental menunjukkan keunggulan atau potensi kejutan yang diremehkan pasar.
- Estimated fair probability dari bot saat ini sama dengan market implied probability, jadi edge mekanis 0 kecuali ada alasan kuat dan diberi label estimasi.
- Verdict adalah status ENTRY/TRADABILITY, bukan prediksi arah outcome utama/lawan. Jika arah market jelas tapi entry buruk, verdict tetap SKIP atau WATCHLIST.
- Summary wajib membedakan arah market dari kelayakan entry.
- Jadikan analyst review sebagai bahan kritik, bukan keputusan otomatis.
- Jangan berikan markdown. Balas hanya JSON valid.
- Verdict hanya salah satu: SKIP, WATCHLIST, VALUE CANDIDATE, HIGH RISK UNDERDOG.
- Confidence wajib angka 1-100 tentang keyakinanmu pada kualitas analisis/verdict. Jangan salin angka contoh mentah.

Format JSON wajib:
{
  "verdict": "SKIP",
  "confidence": 65,
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
    model: config.qwenFinalModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu final judge prediction market yang konservatif. Kamu bukan financial advisor. Kamu menyatukan scout + analyst review menjadi keputusan akhir yang jelas.",
      },
      { role: "user", content: finalPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("final"),
    response_format: { type: "json_object" },
  };

  const finalJson = await callRoleQwenJson(payload, config.qwenAnalystModel, signal);

  let analysis;
  try {
    analysis = normalizeAnalysis(extractJsonObject(finalJson.text), finalJson.text);
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
      finalJson.text
    );
  }

  const roleResults = [
    { role: "fast", model: scoutJson.model, usage: scoutJson.usage },
    { role: "analyst", model: analystJson.model, usage: analystJson.usage },
    { role: "final", model: finalJson.model, usage: finalJson.usage },
  ];
  const models = {
    fast: scoutJson.model,
    analyst: analystJson.model,
    final: finalJson.model,
  };

  return {
    provider: "qwen-multi-role",
    model: pipelineModelLabel(models),
    models,
    roleResults,
    usage: aggregateUsage(roleResults),
    researchContext,
    analysis,
  };
}

export async function askQwenShadow({ market, score, orderBook, researchContext = null, signal = null }) {
  throwIfAborted(signal);
  const marketData = JSON.stringify({
    question: market.question,
    liquidity: market.liquidity,
    volume: market.volume,
    outcomes: market.outcomes,
    outcomePrices: market.outcomePrices,
  }, null, 2);

  const shadowContext = `
MARKET:
${marketData}

ORDERBOOK:
${JSON.stringify(compactOrderBook(orderBook), null, 2).slice(0, 1000)}

SCORING BOT:
${JSON.stringify({
  spreadPercent: score.spreadPercent,
  confidenceScore: score.confidenceScore,
  underdogScore: score.underdogScore,
  liquidityRisk: score.liquidityRisk,
  blockers: score.blockers
}, null, 2)}
`.trim();

  const shadowPrompt = `
Kamu adalah bot trading otomatis (Shadow Bot). Evaluasi cepat market ini untuk melihat apakah layak dibeli.

${shadowContext}

ATURAN UTAMA:
1. Prioritaskan market dengan NARASI POPULER (Politik, Kripto besar, Macro) dan pastikan liquidity atau volume sangat sehat (> $10000).
2. Jika market punya likuiditas > $10000, spread < 5%, dan "blockers" kosong, berikan "VALUE CANDIDATE".
3. Jika likuiditas > $10000 dan salah satu sisi punya harga murah (<30c) dengan alasan kemenangan yang logis (underdogScore bagus), berikan "HIGH RISK UNDERDOG".
4. Berikan "SKIP" jika liquidity di bawah $10000, narasinya tidak populer/terlalu niche, atau spread sangat buruk (>10%).
5. Balas dengan JSON valid.

Format JSON:
{
  "verdict": "VALUE CANDIDATE" | "HIGH RISK UNDERDOG" | "SKIP" | "WATCHLIST",
  "reason": "Alasan singkat kenapa dibeli atau di-skip"
}
`.trim();

  const payload = {
    model: config.qwenAnalystModel || "qwen-plus",
    messages: [
      { role: "system", content: "Kamu bot eksekutor trading agresif. Jangan banyak skip, cari peluang!" },
      { role: "user", content: shadowPrompt }
    ],
    temperature: 0.4,
    max_tokens: 150,
    response_format: { type: "json_object" }
  };

  const json = await callQwenJson(payload, signal);
  let analysis;
  try {
    const obj = extractJsonObject(json.text);
    const v = String(obj.verdict || "").toUpperCase();
    analysis = {
      verdict: VALID_VERDICTS.has(v) ? v : "SKIP",
      finalReason: obj.reason || "",
      rawText: json.text
    };
  } catch {
    analysis = { verdict: "SKIP", finalReason: "JSON error", rawText: json.text };
  }

  return { analysis, usage: json.usage };
}

export async function askQwenBtcShortTerm({ market, score, orderBook, researchContext, signal = null }) {
  throwIfAborted(signal);

  const st = researchContext;
  const candles  = st?.candles;
  const futures  = st?.futures;
  const bybit    = st?.bybit;
  const interp   = st?.interpretation;

  const derivativesBlock = st?.summary
    ? `\nDATA DERIVATIVES REAL-TIME:\n${st.summary}`
    : "\nDATA DERIVATIVES: tidak tersedia.";

  const marketBlock = JSON.stringify({
    question: market.question,
    liquidity: market.liquidity,
    volume: market.volume,
    outcomePrices: market.outcomePrices,
    outcomes: market.outcomes,
  }, null, 2);

  const prompt = `
Kamu adalah analis khusus Polymarket untuk market BTC JANGKA SANGAT PENDEK (5-15 menit).

MARKET:
${marketBlock}

SCORING MEKANIS:
${JSON.stringify({
  spreadPercent: score.spreadPercent,
  confidenceScore: score.confidenceScore,
  liquidityRisk: score.liquidityRisk,
  blockers: score.blockers,
}, null, 2)}
${derivativesBlock}

INSTRUKSI WAJIB:
1. Ini adalah prediksi harga SANGAT jangka pendek (menit) — JANGAN analisis fundamental makro.
2. Fokuslah HANYA pada: momentum 5m, long/short imbalance, funding rate, OI delta, volume spike.
3. Jika long_ratio > 60%: pasar terlalu banyak long → risiko dump → pertimbangkan sisi NO/DOWN.
4. Jika long_ratio < 40%: banyak short → potensi squeeze → pertimbangkan sisi YES/UP.
5. Jika consensus dari interpretation adalah "bearish_bias" atau "strong_bearish" → lebih mungkin harga turun.
6. Jika consensus "bullish_bias" atau "strong_bullish" → lebih mungkin harga naik.
7. Jika tidak ada data derivatives → berikan "WATCHLIST" (jangan SKIP karena data cukup dari orderbook).
8. Berikan "VALUE CANDIDATE" jika ada setidaknya 2 sinyal yang konsisten satu arah.
9. Balas hanya JSON valid.

Format JSON:
{
  "verdict": "VALUE CANDIDATE" | "HIGH RISK UNDERDOG" | "WATCHLIST" | "SKIP",
  "preferred_side": "YES" | "NO" | null,
  "reason": "Alasan singkat berdasarkan data derivatives"
}
`.trim();

  const payload = {
    model: config.qwenAnalystModel || "qwen-plus",
    messages: [
      { role: "system", content: "Kamu analis short-term trading crypto untuk prediksi 5 menit. Fokus pada microstructure, bukan makro." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 180,
    response_format: { type: "json_object" },
  };

  const json = await callQwenJson(payload, signal);
  let analysis;
  try {
    const obj = extractJsonObject(json.text);
    const v = String(obj.verdict || "").toUpperCase();
    analysis = {
      verdict: VALID_VERDICTS.has(v) ? v : "WATCHLIST",
      preferredSide: obj.preferred_side || null,
      finalReason: obj.reason || "",
      rawText: json.text,
    };
  } catch {
    analysis = { verdict: "WATCHLIST", finalReason: "JSON parse error", rawText: json.text };
  }

  return { analysis, usage: json.usage };
}

export async function askQwenEvent({ event, analyzedMarkets, researchContext = null, signal = null }) {

  throwIfAborted(signal);
  const compactMarkets = analyzedMarkets.map(({ market, score }) => ({
    market_id: market.id,
    question: market.question,
    variant: market.groupItemTitle,
    status: market.closed ? "closed" : market.acceptingOrders ? "open" : "active_orders_unclear",
    primary_outcome: score.primaryOutcomeLabel || market.outcomes?.[0] || "YES",
    secondary_outcome: score.secondaryOutcomeLabel || market.outcomes?.[1] || "NO",
    gamma_primary_price: score.gammaPrimaryPrice ?? market.outcomePrices?.[0] ?? null,
    gamma_secondary_price: market.outcomePrices?.[score.secondaryOutcomeIndex ?? 1] ?? market.outcomePrices?.[1] ?? null,
    liquidity: market.liquidity,
    gamma_volume: market.volume,
    clob_implied_probability_percent: score.marketProbability,
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

  const eventContext = `
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

${researchBlock(researchContext)}
`.trim();

  const scoutPrompt = `
Klasifikasikan event Polymarket multi-market ini secara cepat.

${eventContext}

Aturan:
- Jangan mengarang data eksternal.
- Tugasmu hanya membuat brief pendek untuk analyst dan final judge.
- Balas hanya JSON valid.

Format JSON:
{
  "task_type": "event_market_comparison",
  "complexity": "simple/medium/complex",
  "main_question": "inti event",
  "market_type": "politik/makro/crypto/sports/lainnya",
  "risk_focus": ["maks 4 risiko utama"],
  "missing_data": ["maks 4 data eksternal yang masih kurang"],
  "recommended_depth": "fast/standard/deep"
}
`.trim();

  const scoutPayload = {
    model: config.qwenFastModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu model fast scout. Tugasmu membaca event multi-market cepat dan memberi brief ringkas tanpa memilih final secara agresif.",
      },
      { role: "user", content: scoutPrompt },
    ],
    temperature: 0,
    max_tokens: roleMaxTokens("fast"),
    response_format: { type: "json_object" },
  };

  const scoutJson = await callRoleQwenJson(scoutPayload, config.qwenAnalystModel, signal);
  const scout = normalizeScout(parseJsonOr(scoutJson.text, {}), scoutJson.text);

  const analystPrompt = `
Review semua pilihan aktif dalam event Polymarket ini. Kamu bukan final judge.

${eventContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

Aturan:
- Jangan mengarang data eksternal seperti polling, berita, FedWatch, on-chain data, funding, atau filing jika tidak ada di input / EXTERNAL RESEARCH CONTEXT.
- Bandingkan market dari sisi orderbook, spread, liquidity, rules, timeline, dan blocker.
- Nilai "worth it" berarti paling layak dipantau/diteliti, bukan pasti value.
- Balas hanya JSON valid.

Format JSON:
{
  "rules_summary": "ringkasan struktur event dan cara tiap market akan resolve",
  "data_quality": "kualitas data event dan batasannya",
  "bullish_case": ["maks 3 poin umum kenapa event layak dipantau"],
  "bearish_case": ["maks 3 poin umum kenapa perlu hati-hati"],
  "risks": {
    "liquidity": "catatan liquidity antar pilihan",
    "spread": "catatan spread antar pilihan",
    "resolution": "risiko resolution antar pilihan",
    "catalyst": "ada/tidak ada catalyst dari data input"
  },
  "missing_data": ["maks 4 data eksternal yang masih kurang"],
  "preliminary_verdict": "SKIP/WATCHLIST/VALUE CANDIDATE/HIGH RISK UNDERDOG",
  "confidence": 65
}
`.trim();

  const analystPayload = {
    model: config.qwenAnalystModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu model analyst/reviewer untuk event multi-market. Tugasmu membandingkan risiko dan kualitas kandidat secara konservatif.",
      },
      { role: "user", content: analystPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("analyst"),
    response_format: { type: "json_object" },
  };

  const analystJson = await callRoleQwenJson(analystPayload, config.qwenFinalModel, signal);
  const analyst = normalizeAnalystReview(parseJsonOr(analystJson.text, {}), analystJson.text);

  const finalPrompt = `
Bandingkan semua pilihan aktif dalam satu event Polymarket dan tentukan mana yang paling layak dipantau.

${eventContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

ANALYST REVIEW:
${JSON.stringify(promptSafe(analyst), null, 2)}

Aturan wajib:
- Jangan mengarang data eksternal seperti polling, berita, FedWatch, on-chain data, funding, atau filing jika tidak ada di input / EXTERNAL RESEARCH CONTEXT.
- Nilai "worth it" di sini berarti paling layak dipantau/diteliti dari data market, bukan pasti value.
- Karena belum ada fair probability eksternal, jangan klaim VALUE CANDIDATE kecuali alasannya sangat konservatif.
- Verdict ranking adalah status entry/tradability tiap pilihan, bukan prediksi arah outcome utama/lawan.
- Prioritaskan market dengan orderbook sehat, spread rendah, liquidity cukup, rules jelas, dan alasan risiko yang masuk akal.
- Jadikan analyst review sebagai bahan kritik, bukan keputusan otomatis.
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
    model: config.qwenFinalModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu final judge event prediction market yang konservatif. Kamu memilih ranking akhir dari scout + analyst review + market data.",
      },
      { role: "user", content: finalPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("final"),
    response_format: { type: "json_object" },
  };

  const finalJson = await callRoleQwenJson(payload, config.qwenAnalystModel, signal);

  let analysis;
  try {
    analysis = normalizeEventAnalysis(extractJsonObject(finalJson.text), finalJson.text);
  } catch {
    analysis = mechanicalEventFallback(analyzedMarkets, finalJson.text);
  }

  const roleResults = [
    { role: "fast", model: scoutJson.model, usage: scoutJson.usage },
    { role: "analyst", model: analystJson.model, usage: analystJson.usage },
    { role: "final", model: finalJson.model, usage: finalJson.usage },
  ];
  const models = {
    fast: scoutJson.model,
    analyst: analystJson.model,
    final: finalJson.model,
  };

  return {
    provider: "qwen-multi-role",
    model: pipelineModelLabel(models),
    models,
    roleResults,
    usage: aggregateUsage(roleResults),
    researchContext,
    analysis,
  };
}
