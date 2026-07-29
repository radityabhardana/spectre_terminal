import { ANALYSIS_STRATEGY_VERSION, getAnalyzedEvents, getUnresolvedAnalyzedEvents, getAnalyzedEventById, updateAnalyzedEventStatus, saveReflection, getReflectionByMarketId } from "./storage.js";
import { getMarketById } from "./polymarket.js";
import { config } from "./config.js";
import { requestAiText } from "./qwen.js";

async function fetchQwenReflection(market, prediction, actualOutcome, originalAnalysis, signal = null) {
  const prompt = `
Kamu adalah AI Hedge Fund Analyst Senior yang sedang melakukan **Post-Mortem Analysis (Evaluasi Mendalam)** atas kerugian fatal.
Kamu membuat prediksi di masa lalu, dan hasilnya ternyata **SALAH TOTAL**.

[DATA MARKET]
Pertanyaan Market: ${market.question}
Hasil Aktual (Oracle): ${actualOutcome}
Prediksimu Saat Itu: ${prediction}

[ANALISIS LAMAMU]
${originalAnalysis}

[TUGASMU]
Lakukan evaluasi MENDALAM secara objektif, kejam, dan analitis. Jangan mencari alasan, carilah akar masalah logika!
Jawab dalam format terstruktur berikut:

1. **Root Cause Analysis (Akar Masalah)**
Bongkar hanya argumen yang benar-benar tertulis di "Analisis Lamamu" dan tunjukkan kecacatan logikanya.

2. **Blind Spots (Titik Buta)**
Sebutkan data yang memang hilang dari input. Jangan mengklaim berita, whale trap, on-chain event, atau penyebab lain benar-benar terjadi jika tidak ada bukti di input; labeli semuanya sebagai hipotesis yang belum terverifikasi.

3. **Core Lesson Learned (Pelajaran Inti)**
Satu paragraf padat berisi inti pelajaran yang harus diingat seumur hidup agar kebodohan analitis ini tidak terulang di market serupa.

Gunakan bahasa Indonesia yang profesional dan to-the-point. Pisahkan fakta terverifikasi dari hipotesis. Jika bukti tidak cukup, tulis "tidak dapat ditentukan dari data tersimpan".
`.trim();

  const payload = {
    model: config.qwenEvaluatorModel,
    messages: [
      {
        role: "system",
        content: "Kamu adalah AI Hedge Fund Analyst yang tidak mentolerir kesalahan logika. Evaluasi kekalahanmu dengan tajam, analitis, dan mendalam.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 1500,
  };

  const result = await requestAiText(payload, {
    fallbackModel: config.qwenRiskManagerModel,
    signal,
  });
  return result.text;
}

export async function evaluateSingleEvent(eventId, signal = null) {
  try {
    const event = getAnalyzedEventById(eventId);
    if (!event) return { error: "Event tidak ditemukan." };

    if (event.actionable !== 1 || !["YES", "UP", "NO", "DOWN"].includes(String(event.prediction || "").toUpperCase())) {
      return { error: "Event ini bukan PLAY yang actionable dan tidak boleh masuk reflection memory." };
    }
    if (event.result !== 'kalah') {
      return { error: "Event ini tidak berstatus kalah. Evaluasi hanya untuk prediksi yang salah." };
    }

    // Cek apakah sudah pernah dievaluasi
    const existingReflection = getReflectionByMarketId(event.market_id);
    if (existingReflection) {
      return { reflection: existingReflection.reflection_note };
    }

    const market = await getMarketById(event.market_id, true);
    if (!market) return { error: "Data market Polymarket tidak ditemukan." };

    const reflectionNote = await fetchQwenReflection(market, event.prediction, event.actual_outcome, event.analysis_conclusion, signal);
    
    saveReflection({
      market_id: event.market_id,
      question: market.question,
      prediction: event.prediction,
      actual_outcome: event.actual_outcome,
      reflection_note: reflectionNote
    });

    return { reflection: reflectionNote };
  } catch (error) {
    console.error(`[Evaluate] Error evaluating single event ${eventId}:`, error.message);
    return { error: "AI evaluator gagal memproses event.", status: 502 };
  }
}

export async function evaluateAllResolutions(signal = null) {
  const allEvents = getAnalyzedEvents(100).filter(e =>
    e.status === "selesai" && e.result === "kalah" && e.actionable === 1 && e.strategy_version === ANALYSIS_STRATEGY_VERSION
  );
  if (!allEvents.length) {
    return { status: "Selesai", message: "✅ Tidak ada histori tebakan yang salah untuk dievaluasi." };
  }

  let countEvaluated = 0;
  let countFailed = 0;
  let countAttempted = 0;
  let textOut = "🔍 *Mengevaluasi Prediksi Salah*\n\n";

  for (const event of allEvents) {
    if (countAttempted >= 5) break; // Limit provider cost, including failed attempts.

    try {
      if (signal?.aborted) break;

      // Skip kalau prediksinya netral
      const p = (event.prediction || "").toUpperCase();
      if (p === "SKIP" || p === "WATCHLIST" || p === "NETRAL" || p === "=") continue;

      const existingReflection = getReflectionByMarketId(event.market_id);
      if (existingReflection) continue; // Sudah pernah dipelajari

      const market = await getMarketById(event.market_id, true);
      if (!market) continue;

      countAttempted++;
      const reflectionNote = await fetchQwenReflection(market, event.prediction, event.actual_outcome, event.analysis_conclusion, signal);
      
      saveReflection({
        market_id: event.market_id,
        question: market.question,
        prediction: event.prediction,
        actual_outcome: event.actual_outcome,
        reflection_note: reflectionNote
      });
      countEvaluated++;

      textOut += `🔹 Market: ${market.question}\n💡 *Refleksi*: ${reflectionNote}\n\n`;

    } catch (error) {
      countFailed++;
      console.error(`[Evaluate] Error processing market ${event.market_id}:`, error.message);
    }
  }

  if (countEvaluated === 0) {
    if (countFailed > 0) {
      return { status: "Gagal", message: `Gagal mengevaluasi ${countFailed} market.`, attempted: countAttempted, succeeded: 0, failed: countFailed };
    }
    return { status: "Selesai", message: "✅ Semua prediksi yang salah sudah dievaluasi sebelumnya." };
  }

  return {
    status: countFailed > 0 ? "Sebagian berhasil" : "Berhasil",
    message: `Berhasil mengevaluasi ${countEvaluated} market${countFailed ? `; ${countFailed} gagal` : ""}.`,
    attempted: countAttempted,
    succeeded: countEvaluated,
    failed: countFailed,
    details: textOut.trim(),
  };
}

export async function evaluateResolutions(ctx = null) {
  const unresolved = getUnresolvedAnalyzedEvents();
  if (!unresolved.length) {
    return "✅ Semua prediksi yang ada di memori saat ini sudah tereksekusi atau belum ada yang close.";
  }

  let textOut = "🔍 *Mengecek Market Terselesaikan*\n\n";
  let countChecked = 0;
  let countResolved = 0;

  for (const event of unresolved) {
    try {
      const market = await getMarketById(event.market_id, true);
      if (!market) continue;
      
      // Never infer settlement from time alone; wait for Polymarket's final state.
      if (!market.closed) continue;

      countChecked++;
      const prices = market.outcomePrices.map(Number);
      const winners = prices
        .map((price, index) => ({ price, index }))
        .filter(({ price }) => price >= 0.99);
      const winnerIndex = winners.length === 1 && prices.every((price, index) => index === winners[0].index || price <= 0.01)
        ? winners[0].index
        : -1;
      
      if (winnerIndex === -1) continue; // No clear winner yet
      
      const actualOutcome = market.outcomes[winnerIndex]; // e.g. "Up", "Down", "Yes", "No"
      if (!actualOutcome) continue;

      countResolved++;
      let statusText = "kalah";
      const p = (event.prediction || "").toUpperCase();
      const isNeutralPrediction = event.actionable !== 1 || p === "=" || p === "SKIP" || p === "NETRAL" || p === "WATCHLIST";
      const w = (actualOutcome || "").toUpperCase();
      const directMatch = p && w && p === w;
      
      if (isNeutralPrediction) {
        statusText = "netral";
      } else if (directMatch) {
        statusText = "menang";
      }
      
      updateAnalyzedEventStatus(event.id, "selesai", statusText, actualOutcome);

      textOut += `🔹 Market: ${market.question}\nPrediksi: ${event.prediction} | Hasil: ${actualOutcome} | Status: *${statusText.toUpperCase()}*\n`;

      if (statusText === "kalah" && event.actionable === 1) {
        const reflectionNote = await fetchQwenReflection(market, event.prediction, actualOutcome, event.analysis_conclusion, ctx?.signal);
        saveReflection({
          market_id: event.market_id,
          question: market.question,
          prediction: event.prediction,
          actual_outcome: actualOutcome,
          reflection_note: reflectionNote
        });
        textOut += `💡 *Refleksi*: ${reflectionNote}\n\n`;
      } else {
        textOut += "\n";
      }

    } catch (error) {
      console.error(`[Evaluate] Error processing market ${event.market_id}:`, error.message);
    }
  }

  if (countChecked === 0) return "⏳ Belum ada market yang *closed*. Semua prediksi masih menunggu hasil.";
  return textOut.trim();
}
