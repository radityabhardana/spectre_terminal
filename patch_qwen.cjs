const fs = require('fs');

let content = fs.readFileSync('c:/ALL/Razor Bot/src/qwen.js', 'utf8');

const normalizeStart = content.indexOf('function normalizeAnalysis(value, rawText) {');
const normalizeEnd = content.indexOf('function normalizeEventAnalysis(value, rawText) {');

const askQwenStart = content.indexOf('export async function askQwen({ market, score, orderBook, researchContext = null, signal = null }) {');
const askQwenEnd = content.indexOf('export async function askQwenEvent({ event, analyzedMarkets, researchContext = null, signal = null }) {');

if (normalizeStart === -1 || askQwenStart === -1) {
    console.error('Failed to find markers.');
    process.exit(1);
}

const newNormalize = `function normalizeAnalysis(value, rawText) {
  const verdict = String(value.verdict || "").trim().toUpperCase();

  return {
    verdict: VALID_VERDICTS.has(verdict) ? verdict : "SKIP",
    confidence: Number.isFinite(Number(value.confidence)) && Number(value.confidence) > 0
      ? Math.max(1, Math.min(100, Math.round(Number(value.confidence))))
      : null,
    positionSizePct: Number.isFinite(Number(value.position_size_pct)) ? Number(value.position_size_pct) : null,
    estimatedFairProbability: Number.isFinite(Number(value.estimated_fair_probability)) ? Number(value.estimated_fair_probability) : null,
    expectedValueCents: Number.isFinite(Number(value.expected_value_cents)) ? Number(value.expected_value_cents) : null,
    kellyEdge: Number.isFinite(Number(value.kelly_edge)) ? Number(value.kelly_edge) : null,
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

`;

const newAskQwen = `export async function askQwen({ market, score, orderBook, researchContext = null, signal = null }) {
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

  let cryptoSymbol = "";
  const qLower = (market.question || "").toLowerCase();
  if (qLower.includes("bitcoin") || qLower.includes("btc")) cryptoSymbol = "BTC";
  else if (qLower.includes("ethereum") || qLower.includes("eth")) cryptoSymbol = "ETH";
  
  let cryptoContext = "";
  if (cryptoSymbol) {
    if (market.currentPrice !== undefined && market.priceToBeat) {
      cryptoContext = \`\\n\\nREAL-TIME CRYPTO DATA (\${cryptoSymbol}/USDT):\\n- Target Price: \${market.priceToBeat}\\n- Current Price (Pyth Oracle): $\${market.currentPrice.toFixed(2)}\\n[!] CATATAN: Harga menggunakan API Pyth Oracle secara Real-time (akurat 1:1 dengan Polymarket).\`;
    }
  }

  const recentReflections = getRecentReflections(5);
  const lessonsBlock = recentReflections.length > 0 
    ? \`\\nLESSONS FROM PAST MISTAKES (RAG MEMORY):\\n\${recentReflections.map((r, i) => \`\${i+1}. Market: \${r.question}\\nPrediksi Salah: \${r.prediction} (Hasil asli: \${r.actual_outcome})\\nRefleksi: \${r.reflection_note}\`).join("\\n\\n")}\`
    : "";

  const sharedContext = \`
CURRENT DATE:
\${nowInJakarta()} Asia/Jakarta
\${cryptoContext}

DATA MARKET:
\${marketData}

ORDERBOOK \${primaryOutcomeLabel.toUpperCase()} (TOP LEVELS ONLY):
\${JSON.stringify(compactOrderBook(orderBook), null, 2).slice(0, config.maxQwenInputChars)}

SCORING AWAL DARI BOT:
\${JSON.stringify(score, null, 2)}

\${researchBlock(researchContext)}
\${lessonsBlock}
\`.trim();

  // STAGE 1: BULL AGENT
  const bullPrompt = \`
Kamu adalah BULL AGENT di dalam sistem Multi-Agent Debate.
Tugas tunggalmu: Cari SEMUA alasan kuat mengapa trader harus membeli YES / memihak pada PRIMARY OUTCOME (\${primaryOutcomeLabel}).

\${sharedContext}

Aturan:
- Abaikan risiko dan kasus bearish. Itu tugas Bear Agent.
- Fokus pada momentum, whale flow (jika ada), sentimen positif, dan catalyst bullish.
- Khusus Crypto: Jika Orderbook Imbalance Beli tinggi atau Klines naik, jadikan ini senjata utamamu.
- Jika market ini mustahil Bullish, berikan argumen terkuat yang tersisa meski kecil.
- Balas hanya JSON valid.

Format JSON:
{
  "agent_role": "BULL",
  "bullish_arguments": ["poin 1", "poin 2", "poin 3"],
  "estimated_probability_yes": 60,
  "confidence_in_bull_case": 85,
  "evidence_cited": ["data 1", "data 2"]
}
\`.trim();

  const bullPayload = {
    model: config.qwenFastModel,
    messages: [
      { role: "system", content: "Kamu adalah BULL AGENT yang agresif dan tajam. Tugasmu mencari edge untuk sisi YES/PRIMARY." },
      { role: "user", content: bullPrompt },
    ],
    temperature: 0.2,
    max_tokens: roleMaxTokens("fast"),
    response_format: { type: "json_object" },
  };

  const bullJson = await callRoleQwenJson(bullPayload, config.qwenAnalystModel, signal);
  const bullAgentResult = parseJsonOr(bullJson.text, {});

  // STAGE 2: BEAR AGENT
  const bearPrompt = \`
Kamu adalah BEAR AGENT di dalam sistem Multi-Agent Debate.
Tugas tunggalmu: Cari SEMUA alasan kuat mengapa trader harus membeli NO / memihak pada SECONDARY OUTCOME (\${secondaryOutcomeLabel}).

\${sharedContext}

Aturan:
- Abaikan argumen bullish. Itu tugas Bull Agent.
- Fokus pada risiko, spread tinggi, jebakan likuiditas, delay Polymarket, dan indikator bearish.
- Khusus Crypto: Jika Orderbook Imbalance Beli rendah (<35%) atau Klines turun, jadikan ini senjata utamamu.
- Bandingkan arah harga asli dengan harga Polymarket. Cari kelemahannya.
- Balas hanya JSON valid.

Format JSON:
{
  "agent_role": "BEAR",
  "bearish_arguments": ["poin 1", "poin 2", "poin 3"],
  "estimated_probability_no": 55,
  "confidence_in_bear_case": 80,
  "evidence_cited": ["data 1", "data 2"]
}
\`.trim();

  const bearPayload = {
    model: config.qwenAnalystModel,
    messages: [
      { role: "system", content: "Kamu adalah BEAR AGENT yang skeptis, sinis, dan tajam. Tugasmu mencari edge untuk sisi NO/SECONDARY dan mencari kelemahan market." },
      { role: "user", content: bearPrompt },
    ],
    temperature: 0.2,
    max_tokens: roleMaxTokens("analyst"),
    response_format: { type: "json_object" },
  };

  const bearJson = await callRoleQwenJson(bearPayload, config.qwenFinalModel, signal);
  const bearAgentResult = parseJsonOr(bearJson.text, {});

  // STAGE 3: RISK MANAGER (FINAL JUDGE)
  const riskManagerPrompt = \`
Kamu adalah RISK MANAGER (Final Judge) untuk market Polymarket. Ambil keputusan akhir setelah mengevaluasi debat antara Bull Agent dan Bear Agent.

\${sharedContext}

DEBAT AGEN:
[BULL AGENT]:
\${JSON.stringify(promptSafe(bullAgentResult), null, 2)}

[BEAR AGENT]:
\${JSON.stringify(promptSafe(bearAgentResult), null, 2)}

Aturan wajib:
- Jangan mengarang data eksternal.
- Tentukan 'estimated_fair_probability' (0-100%) secara objektif sebagai penengah.
- Hitung Expected Value (EV): EV = (estimated_fair_probability / 100) - (marketProbability di SCORING AWAL / 100).
- MATEMATIKA MUTLAK 1: Jika EV <= 0, verdict kamu WAJIB "SKIP".
- MATEMATIKA MUTLAK 2: Jika spread % terlalu gila atau likuiditas mati, WAJIB "SKIP".
- Hitung Sizing via Kelly Criterion: 
  f* = ((Edge / 100) * Odds - (1 - (Edge / 100))) / Odds. 
  (Di sini asumsikan Odds biner adalah (1 / marketProbability) - 1). 
  Tapi untuk amannya, berikan estimasi Kelly dari 0% hingga 5% maksimal (Half-Kelly).
- Verdict hanya salah satu: SKIP, WATCHLIST, VALUE CANDIDATE, HIGH RISK UNDERDOG.

Format JSON wajib:
{
  "verdict": "SKIP",
  "confidence": "[1-100]",
  "estimated_fair_probability": 60,
  "expected_value_cents": 10,
  "kelly_edge": 0.15,
  "position_size_pct": 2.5,
  "summary": "Ringkasan debat dan konklusi Risk Manager.",
  "data_quality": "Kualitas data.",
  "bullish_case": ["maks 3 poin"],
  "bearish_case": ["maks 3 poin"],
  "risks": {
    "liquidity": "Low/Medium/High + alasan",
    "spread": "Low/Medium/High + alasan",
    "resolution": "Low/Medium/High + alasan",
    "catalyst": "Ada/tidak ada catalyst + alasan"
  },
  "missing_data": ["maks 4 data"],
  "checklist": { "liquidity": true, "spread": true, "rules": true, "edge": false, "catalyst": false },
  "final_reason": "Justifikasi akhir mengapa verdict ini diambil dan sizing Kelly dihitung sekian."
}
\`.trim();

  const rmPayload = {
    model: config.qwenFinalModel,
    messages: [
      { role: "system", content: "Kamu adalah RISK MANAGER hedge fund kuantitatif. Tugasmu menyelesaikan debat antara agen Bull dan Bear, menerapkan Kelly Criterion, dan memberikan keputusan dingin, logis, dan definitif." },
      { role: "user", content: riskManagerPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("final"),
    response_format: { type: "json_object" },
  };

  const finalJson = await callRoleQwenJson(rmPayload, config.qwenAnalystModel, signal);

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
        bearish_case: ["Format Qwen tidak valid."],
        final_reason: "Skip karena output model tidak terstruktur.",
      },
      finalJson.text
    );
  }

  const roleResults = [
    { role: "bull_agent", model: bullJson.model, usage: bullJson.usage },
    { role: "bear_agent", model: bearJson.model, usage: bearJson.usage },
    { role: "risk_manager", model: finalJson.model, usage: finalJson.usage },
  ];
  const models = {
    fast: bullJson.model,
    analyst: bearJson.model,
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

`;

content = content.substring(0, normalizeStart) + newNormalize + content.substring(normalizeEnd, askQwenStart) + newAskQwen + content.substring(askQwenEnd);

fs.writeFileSync('c:/ALL/Razor Bot/src/qwen.js', content, 'utf8');
console.log('qwen.js successfully patched.');
