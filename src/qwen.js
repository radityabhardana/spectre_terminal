import { config } from "./config.js";

export async function askQwen({ market, score, orderBook }) {
  const marketData = JSON.stringify(
    {
      question: market.question,
      description: market.description,
      endDate: market.endDate,
      active: market.active,
      closed: market.closed,
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

DATA MARKET:
${marketData}

ORDERBOOK YES:
${JSON.stringify(orderBook, null, 2).slice(0, config.maxQwenInputChars)}

SCORING AWAL DARI BOT:
${JSON.stringify(score, null, 2)}

Tugas wajib:
1. Jelaskan event dan aturan resolusi jika tersedia.
2. Bedakan data aktual vs opini/estimasi.
3. Berikan bullish case dan bearish case.
4. Nilai liquidity risk, spread risk, resolution risk, dan catalyst.
5. Jangan memberi kepastian palsu. Jika data kurang, katakan data kurang.
6. Berikan final verdict: SKIP, WATCHLIST, VALUE CANDIDATE, atau HIGH RISK UNDERDOG.
7. Jawab bahasa Indonesia, ringkas, tajam, dan praktis.
`.trim();

  const response = await fetch(`${config.qwenBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.qwenApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.qwenModel,
      messages: [
        {
          role: "system",
          content:
            "Kamu adalah analis prediction market yang kritis. Kamu bukan financial advisor. Fokus pada probabilitas, value, liquidity, spread, rules, catalyst, dan risiko.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Qwen HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const json = await response.json();
  return json.choices?.[0]?.message?.content?.trim() || "Qwen tidak memberi output.";
}
