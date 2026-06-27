import { getAnalyzedEvents, getAnalyzedEventById, updateAnalyzedEventStatus, saveReflection, getReflectionByMarketId } from "./storage.js";
import { getMarketById, pickYesNoTokens } from "./polymarket.js";
import { config } from "./config.js";

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
Bongkar argumen di "Analisis Lamamu". Di mana letak kecacatan logikamu? Apakah ada data on-chain, orderbook, atau sentimen makro yang kamu abaikan atau salah interpretasi?

2. **Blind Spots (Titik Buta)**
Apa variabel tak terduga (contoh: Whale Trap, News Dadakan, Likuiditas Palsu) yang tidak kamu perhitungkan saat itu? Mengapa modelmu gagal mendeteksinya?

3. **Core Lesson Learned (Pelajaran Inti)**
Satu paragraf padat berisi inti pelajaran yang harus diingat seumur hidup agar kebodohan analitis ini tidak terulang di market serupa.

Gunakan bahasa Indonesia yang tajam, profesional, dan to-the-point.
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
    temperature: 0.4,
    max_tokens: 1500,
  };

  try {
    const res = await fetch(`${config.qwenBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.qwenApiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
    const json = await res.json();
    return json?.choices?.[0]?.message?.content || "Gagal mendapatkan refleksi dari Qwen.";
  } catch (error) {
    console.error("[Evaluate] Error calling Qwen for reflection:", error.stack);
    return "Error memanggil Qwen saat evaluasi.";
  }
}

export async function evaluateSingleEvent(eventId, signal = null) {
  try {
    const event = getAnalyzedEventById(eventId);
    if (!event) return { error: "Event tidak ditemukan." };

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
    
    if (reflectionNote === "Gagal mendapatkan refleksi dari Qwen." || reflectionNote === "Error memanggil Qwen saat evaluasi.") {
      return { error: reflectionNote };
    }
    
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
    return { error: error.message };
  }
}

export async function evaluateAllResolutions(signal = null) {
  const allEvents = getAnalyzedEvents(100).filter(e => e.status === "selesai" && e.result === "kalah");
  if (!allEvents.length) {
    return { status: "Selesai", message: "✅ Tidak ada histori tebakan yang salah untuk dievaluasi." };
  }

  let countEvaluated = 0;
  let textOut = "🔍 *Mengevaluasi Prediksi Salah*\n\n";

  for (const event of allEvents) {
    if (countEvaluated >= 5) break; // Limit API cost

    try {
      if (signal?.aborted) break;

      // Skip kalau prediksinya netral
      const p = (event.prediction || "").toUpperCase();
      if (p === "SKIP" || p === "WATCHLIST" || p === "NETRAL" || p === "=") continue;

      const existingReflection = getReflectionByMarketId(event.market_id);
      if (existingReflection) continue; // Sudah pernah dipelajari

      const market = await getMarketById(event.market_id, true);
      if (!market) continue;

      countEvaluated++;
      const reflectionNote = await fetchQwenReflection(market, event.prediction, event.actual_outcome, event.analysis_conclusion, signal);
      
      saveReflection({
        market_id: event.market_id,
        question: market.question,
        prediction: event.prediction,
        actual_outcome: event.actual_outcome,
        reflection_note: reflectionNote
      });

      textOut += `🔹 Market: ${market.question}\n💡 *Refleksi*: ${reflectionNote}\n\n`;

    } catch (error) {
      console.error(`[Evaluate] Error processing market ${event.market_id}:`, error.message);
    }
  }

  if (countEvaluated === 0) {
    return { status: "Selesai", message: "✅ Semua prediksi yang salah sudah dievaluasi sebelumnya." };
  }

  return { status: "Berhasil", message: `Berhasil mengevaluasi ${countEvaluated} market.`, details: textOut.trim() };
}

export async function evaluateResolutions(ctx = null) {
  const unresolved = getAnalyzedEvents(100).filter(e => e.status === "belum selesai");
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
      
      // Cek apakah market sudah ditutup oleh Polymarket ATAU waktunya sudah habis (expired)
      const isExpired = market.endDate && new Date(market.endDate).getTime() < Date.now();
      if (!market.closed && !isExpired) continue;

      countChecked++;
      const tokens = pickYesNoTokens(market);
      
      // Determine which outcome won based on price (>= 0.95 is considered settled)
      let winnerIndex = -1;
      for (let i = 0; i < market.outcomePrices.length; i++) {
        if (Number(market.outcomePrices[i]) >= 0.95) {
          winnerIndex = i;
          break;
        }
      }
      
      if (winnerIndex === -1) continue; // No clear winner yet
      
      const actualOutcome = market.outcomes[winnerIndex]; // e.g. "Up", "Down", "Yes", "No"
      if (!actualOutcome) continue;

      countResolved++;
      let statusText = "kalah";
      const p = (event.prediction || "").toUpperCase();
      const isNeutralPrediction = p === "=" || p === "SKIP" || p === "NETRAL" || p === "WATCHLIST";
      
      if (isNeutralPrediction) {
        statusText = "netral";
      } else if (p === actualOutcome.toUpperCase()) {
        statusText = "menang";
      }
      
      updateAnalyzedEventStatus(event.id, "selesai", statusText, actualOutcome);

      textOut += `🔹 Market: ${market.question}\nPrediksi: ${event.prediction} | Hasil: ${actualOutcome} | Status: *${statusText.toUpperCase()}*\n`;

      if (statusText === "kalah") {
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
