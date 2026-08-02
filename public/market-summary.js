import { escapeHtml, sanitizeHttpUrl } from "./render-safety.js";

const UNAVAILABLE = "Unavailable";

function after(line, prefix) {
  return line.slice(prefix.length).trim();
}

function numeric(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /^n\/?a$/i.test(normalized)) return null;
  const number = Number(normalized.replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function probabilityNumber(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /^n\/?a$/i.test(normalized)) return null;
  const number = Number(normalized.replace(/[,%]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function entryStatus(value) {
  const words = String(value || "").toUpperCase().match(/[A-Z]+/g) || [];
  if (words[0] === "NO" && ["ENTRY", "CHASE"].includes(words[1])) return `NO_${words[1]}`;
  return words[0] || null;
}

function firstPercentage(value) {
  return String(value || "").match(/-?\d+(?:\.\d+)?%/)?.[0] || null;
}

function formatPrice(value) {
  const number = numeric(value);
  if (number == null) return UNAVAILABLE;
  return `$${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function safe(value, fallback = UNAVAILABLE) {
  const text = String(value ?? "").trim();
  return escapeHtml(text && text !== "-" && text.toLowerCase() !== "n/a" ? text : fallback);
}

function parseMarketPrices(line) {
  const match = line.match(/^Market Price ([^:]+):\s*([^|]+)\|\s*Market Price ([^:]+):\s*(.+)$/i);
  if (!match) return null;
  return {
    primaryLabel: match[1].trim(),
    primaryValue: match[2].trim(),
    secondaryLabel: match[3].trim(),
    secondaryValue: match[4].trim(),
  };
}

export function parseMarketSummary(text) {
  const data = {
    market: null,
    group: null,
    variant: null,
    direction: null,
    entry: null,
    deadline: null,
    analysisTime: null,
    tokens: null,
    url: null,
    dominant: null,
    marketPrices: null,
    dominanceGap: null,
    underdog: null,
    liquidity: null,
    gammaVolume: null,
    orderbook: null,
    executableBooks: null,
    dataConfidence: null,
    modelConfidence: null,
    risks: null,
    dataWarning: null,
    guardrail: null,
    summary: null,
    fairProbability: null,
    terminalProbability: null,
    expectedValue: null,
    kellySizing: null,
    bullPoint: null,
    bearPoint: null,
    finalReason: null,
    targetPrice: null,
    realtimePrice: null,
    realtimeSource: null,
    priceDelta: null,
    priceDeltaPercent: null,
    bidPercent: null,
    askPercent: null,
  };

  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("Market:")) data.market = after(line, "Market:");
    else if (line.startsWith("Group:")) data.group = after(line, "Group:");
    else if (line.startsWith("Variant:")) data.variant = after(line, "Variant:");
    else if (line.startsWith("Durasi Analisis:")) data.analysisTime = after(line, "Durasi Analisis:").replace(/\s*detik$/i, "");
    else if (line.startsWith("AI Tokens:")) data.tokens = after(line, "AI Tokens:");
    else if (line.startsWith("Tokens:")) data.tokens = after(line, "Tokens:");
    else if (line.startsWith("API close/resolution:")) data.deadline = after(line, "API close/resolution:").replace(/\s*WIB$/i, "");
    else if (line.startsWith("URL:")) data.url = after(line, "URL:");
    else if (line.startsWith("Arah market:")) data.direction = after(line, "Arah market:").split(/\s+/)[0].replace(/[^a-z]/gi, "").toUpperCase() || null;
    else if (line.startsWith("Entry status:")) data.entry = entryStatus(after(line, "Entry status:"));
    else if (line.startsWith("Dominan:")) data.dominant = after(line, "Dominan:");
    else if (line.startsWith("Market Price ")) data.marketPrices = parseMarketPrices(line) || data.marketPrices;
    else if (line.startsWith("Gap dominansi:")) data.dominanceGap = after(line, "Gap dominansi:");
    else if (line.startsWith("Underdog:")) data.underdog = after(line, "Underdog:");
    else if (line.startsWith("Liquidity:")) data.liquidity = after(line, "Liquidity:").split(/\s+/)[0];
    else if (line.startsWith("Gamma volume:")) data.gammaVolume = after(line, "Gamma volume:").split(/\s+/)[0];
    else if (line.startsWith("Orderbook ")) data.orderbook = line.replace(/^Orderbook\s+/i, "");
    else if (line.startsWith("Executable books:")) data.executableBooks = after(line, "Executable books:");
    else if (line.startsWith("Data confidence:")) {
      const [dataPart, modelPart] = line.split("|");
      data.dataConfidence = after(dataPart.trim(), "Data confidence:");
      if (modelPart) data.modelConfidence = modelPart.split(":").slice(1).join(":").trim();
    }
    else if (line.startsWith("Risks:")) data.risks = after(line, "Risks:");
    else if (line.startsWith("Data warning:")) data.dataWarning = after(line, "Data warning:");
    else if (line.startsWith("Guardrail:")) data.guardrail = after(line, "Guardrail:");
    else if (line.startsWith("Explanation:")) data.summary = after(line, "Explanation:");
    else if (line.startsWith("Qwen summary:")) data.summary = after(line, "Qwen summary:");
    else if (line.startsWith("Selected/lean Fair Prob:") || line.startsWith("Est. Fair Prob:")) {
      const [fairPart, terminalPart] = line.split("|");
      data.fairProbability = firstPercentage(fairPart);
      if (terminalPart) data.terminalProbability = firstPercentage(terminalPart);
    }
    else if (line.startsWith("Expected Value (EV):")) data.expectedValue = after(line, "Expected Value (EV):");
    else if (line.startsWith("Kelly Sizing Rec:")) data.kellySizing = after(line, "Kelly Sizing Rec:");
    else if (line.startsWith("Bull point:")) data.bullPoint = after(line, "Bull point:");
    else if (line.startsWith("Bear point:")) data.bearPoint = after(line, "Bear point:");
    else if (line.startsWith("Final reason:")) data.finalReason = after(line, "Final reason:");
    else if (line.startsWith("Kesimpulan Analisis:")) data.summary = after(line, "Kesimpulan Analisis:");
    else if (line.startsWith("Target Price:")) data.targetPrice = after(line, "Target Price:");
    else if (line.startsWith("Realtime Chainlink Price:")) {
      data.realtimePrice = after(line, "Realtime Chainlink Price:");
      data.realtimeSource = data.realtimePrice ? "Chainlink" : null;
    }
    else if (line.startsWith("Realtime Price:")) {
      data.realtimePrice = after(line, "Realtime Price:");
      data.realtimeSource = data.realtimePrice ? "Pyth" : null;
    }
  }

  const realtime = numeric(data.realtimePrice);
  const target = numeric(data.targetPrice);
  if (realtime != null && target != null) {
    data.priceDelta = realtime - target;
    data.priceDeltaPercent = target !== 0 ? (data.priceDelta / target) * 100 : null;
  }

  if (data.marketPrices) {
    const primary = probabilityNumber(data.marketPrices.primaryValue);
    const secondary = probabilityNumber(data.marketPrices.secondaryValue);
    if (primary != null && secondary != null && primary >= 0 && secondary >= 0 && primary + secondary > 0) {
      data.bidPercent = Math.round((primary / (primary + secondary)) * 100);
      data.askPercent = 100 - data.bidPercent;
    }
  }

  return data;
}

function detailRow(label, value, className = "") {
  return `<div class="msp-detail-row ${className}"><span>${escapeHtml(label)}</span><strong>${safe(value)}</strong></div>`;
}

function deltaText(data) {
  if (data.priceDelta == null) return UNAVAILABLE;
  const sign = data.priceDelta >= 0 ? "+" : "-";
  const absolute = Math.abs(data.priceDelta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percent = data.priceDeltaPercent == null
    ? ""
    : ` (${data.priceDeltaPercent >= 0 ? "+" : ""}${data.priceDeltaPercent.toFixed(2)}%)`;
  return `${sign}$${absolute}${percent}`;
}

export function buildMarketSummaryHtml(text, { isHistory = false } = {}) {
  const data = parseMarketSummary(text);
  const direction = ["UP", "DOWN"].includes(data.direction) ? data.direction.toLowerCase() : "neutral";
  const displayDirection = data.direction === "NEUTRAL" ? "NO SIGNAL" : data.direction;
  const displayEntry = data.direction === "NEUTRAL" ? "NO_ENTRY" : data.entry;
  const entryTone = ["WAIT", "WATCHLIST", "WATCHING"].includes(displayEntry)
    ? "is-watch"
    : ["SKIP", "AVOID", "NO_ENTRY", "NO_CHASE"].includes(displayEntry)
      ? "is-risk"
      : ["ENTRY", "PLAY", "READY"].includes(displayEntry) ? "is-entry" : "is-neutral";
  const safeUrl = sanitizeHttpUrl(data.url);
  const headerText = isHistory ? "History Archive" : "Market Summary";
  const headerIcon = isHistory ? "archive" : "zap";
  const deltaTone = data.priceDelta == null ? "" : data.priceDelta >= 0 ? "is-positive" : "is-negative";

  return `
    <article class="msp-board is-${direction}" data-summary-direction="${safe(data.direction)}">
      <header class="msp-board-head">
        <div class="msp-board-title">
          <span class="msp-eyebrow"><i data-lucide="${headerIcon}" aria-hidden="true"></i>${headerText}</span>
          <h2>${safe(data.market, "Unknown market")}</h2>
          ${data.variant || data.group ? `<p>${safe(data.variant || data.group)}</p>` : ""}
        </div>
        <div class="msp-board-actions">
          ${data.analysisTime ? `<span><i data-lucide="timer" aria-hidden="true"></i>${safe(data.analysisTime)}s</span>` : ""}
          ${data.tokens ? `<span><i data-lucide="cpu" aria-hidden="true"></i>${safe(data.tokens)}</span>` : ""}
          ${data.deadline ? `<span><i data-lucide="clock" aria-hidden="true"></i>${safe(data.deadline)}</span>` : ""}
          ${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link" aria-hidden="true"></i>Polymarket</a>` : ""}
          <button id="bentoKesimpulanBox" type="button" onclick="openFullReportModal()">Full report</button>
          <button type="button" class="is-close" onclick="closeStaticPanel()" aria-label="Close Market Summary"><i data-lucide="x" aria-hidden="true"></i></button>
        </div>
      </header>

      <section class="msp-decision-band" data-summary-section="verdict" aria-label="Decision summary">
        <div class="msp-decision-signal">
          <span class="msp-section-kicker">Signal</span>
          <strong><span aria-hidden="true">${direction === "up" ? "UP" : direction === "down" ? "DOWN" : "?"}</span>${safe(displayDirection)}</strong>
          <small>${safe(data.dominant ? `Dominant ${data.dominant}` : data.dominanceGap)}</small>
        </div>
        <div class="msp-price-compare">
          <div><span>${data.realtimeSource ? `${safe(data.realtimeSource)} realtime` : "Realtime"}</span><strong>${formatPrice(data.realtimePrice)}</strong></div>
          <div class="msp-price-delta ${deltaTone}"><span>Distance to beat</span><strong>${escapeHtml(deltaText(data))}</strong></div>
          <div><span>Price to beat</span><strong>${formatPrice(data.targetPrice)}</strong></div>
        </div>
        <div class="msp-entry-decision ${entryTone}">
          <span class="msp-section-kicker">Entry status</span>
          <strong>${safe(displayEntry)}</strong>
          <small>Manual decision only</small>
        </div>
      </section>

      <section class="msp-detail-grid" aria-label="Decision details">
        <article class="msp-detail-card" data-summary-section="why">
          <header><span>01</span><h3>Why</h3></header>
          <p class="msp-summary-copy">${safe(data.summary)}</p>
          ${detailRow("Final reason", data.finalReason)}
          <div class="msp-case-grid">
            <div class="is-bull"><span>Bull case</span><p>${safe(data.bullPoint)}</p></div>
            <div class="is-bear"><span>Bear case</span><p>${safe(data.bearPoint)}</p></div>
          </div>
        </article>

        <article class="msp-detail-card" data-summary-section="risks">
          <header><span>02</span><h3>Risk & guardrails</h3></header>
          <div class="msp-guardrail"><span>Guardrail</span><p>${safe(data.guardrail)}</p></div>
          ${detailRow("Risk profile", data.risks)}
          ${detailRow("Data warning", data.dataWarning, data.dataWarning ? "is-warning" : "")}
          ${detailRow("Data confidence", data.dataConfidence)}
          ${detailRow("Model confidence", data.modelConfidence)}
        </article>

        <article class="msp-detail-card" data-summary-section="evidence">
          <header><span>03</span><h3>Evidence & value</h3></header>
          <div class="msp-probability-grid">
            <div><span>Fair probability</span><strong>${safe(data.fairProbability)}</strong></div>
            <div><span>Terminal UP</span><strong>${safe(data.terminalProbability)}</strong></div>
          </div>
          ${detailRow("Expected value", data.expectedValue)}
          ${detailRow("Kelly sizing", data.kellySizing)}
          ${detailRow("Executable books", data.executableBooks)}
          ${detailRow("Orderbook", data.orderbook)}
        </article>
      </section>

      <section class="msp-metric-strip" aria-label="Market metrics">
        <div><span>Liquidity</span><strong>${safe(data.liquidity)}</strong></div>
        <div><span>Gamma volume</span><strong>${safe(data.gammaVolume)}</strong></div>
        <div><span>Dominance gap</span><strong>${safe(data.dominanceGap)}</strong></div>
        <div><span>Underdog</span><strong>${safe(data.underdog)}</strong></div>
        <div><span>Data confidence</span><strong>${safe(data.dataConfidence)}</strong></div>
      </section>

      <section class="msp-market-depth" aria-label="Market depth">
        <div><span class="is-bid">BID ${data.bidPercent == null ? UNAVAILABLE : `${data.bidPercent}%`}</span><span>Market depth</span><span class="is-ask">ASK ${data.askPercent == null ? UNAVAILABLE : `${data.askPercent}%`}</span></div>
        <div class="msp-market-depth-bar"><span class="is-bid" style="width:${data.bidPercent || 0}%"></span><span class="is-ask" style="width:${data.askPercent || 0}%"></span></div>
      </section>
    </article>
  `;
}
