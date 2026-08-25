import {
  DEFAULT_ENTRY_SCANNER_CONFIG,
  advanceEntryScannerState,
  normalizeEntryScannerResult,
  resetEntryScannerItem,
  selectNewestEntryScannerItem,
  summarizeEntryScannerSession,
  terminalizeEntryScannerState,
} from "./entry-scanner.js";
import {
  escapeHtml,
  formatLimitedRichText,
  polymarketEventUrl,
  sanitizeHttpUrl,
} from "./render-safety.js";
import { buildMarketSummaryHtml } from "./market-summary.js";

/* ============================================================
   MVPM Terminal — Smart Input App Logic
   v31: Unified input system
   ============================================================ */

/* --- DOM Elements --- */
const deckTabsEl = document.querySelector("#deckTabs");
const messagesEl = document.querySelector("#messages");
const emptyState = document.querySelector("#emptyState");
const loadingState = document.querySelector("#loadingState");
const timerText = document.querySelector("#timerText");
const versionText = document.querySelector("#versionText");
const qwenStatus = document.querySelector("#qwenStatus");
const togglePolyBtn = document.querySelector("#togglePolyBtn");
const polyFrame = document.querySelector("#polyFrame");
const polyEmpty = document.querySelector("#polyEmpty");
const polyTitle = document.querySelector("#polyTitle");
const polyOpenLink = document.querySelector("#polyOpenLink");
const guardDot = document.querySelector("#guardDot");
const guardStatus = document.querySelector("#guardStatus");

// Status bar
const connDot = document.querySelector("#connDot");
const connLabel = document.querySelector("#connLabel");
const sbEngine = document.querySelector("#sbEngine");
const sbQwenDot = document.querySelector("#sbQwenDot");
const sbQwenLabel = document.querySelector("#sbQwenLabel");
const sbLatency = document.querySelector("#sbLatency");
const clockTime = document.querySelector("#clockTime");

const CLIENT_VERSION = "public-search-v2-event-wide-analysis-v18-dynamic-ev-scanner";
let busy = false;
let timerId = null;
let startedAt = 0;
let versionWarningShown = false;
let activeRequest = null;
let cooldownTimerId = null;
let commandCooldownUntil = 0;
let qwenCooldownUntil = 0;
let commandCooldownMs = 3000;
let qwenCommandCooldownMs = 45000;
let duplicateCommandCooldownMs = 3000;
const outputTabs = new Map();
let activeTabId = "";
let marketSummaryClosed = false;

/* --- Local Storage State --- */
function saveState() {
  const tabsData = Array.from(outputTabs.values()).map(t => ({
    id: t.id,
    label: t.label,
    hidden: !!t.hidden,
    messages: t.messages.slice(-50), // keep last 50 msgs
  }));
  localStorage.setItem("mvpm_state_v2", JSON.stringify({ activeTabId, tabsData }));
}

function loadState() {
  try {
    const saved = localStorage.getItem("mvpm_state_v2");
    if (saved) {
      const { activeTabId: savedActiveId, tabsData } = JSON.parse(saved);
      if (tabsData) {
        outputTabs.clear();
        for (const tab of tabsData) outputTabs.set(tab.id, tab);
      }
      // Never restore to history-archive on page load (no UI button to open it)
      if (savedActiveId && outputTabs.has(savedActiveId) && savedActiveId !== "history-archive") {
        activeTabId = savedActiveId;
      } else if (outputTabs.size > 0) {
        // Default to cmd:console, not history-archive
        activeTabId = "cmd:console";
      }
    }
    // Pastikan base tabs selalu ada
    if (!outputTabs.has("cmd:console")) outputTabs.set("cmd:console", { id: "cmd:console", label: "Console", messages: [], hidden: false });
    if (!outputTabs.has("history-archive")) outputTabs.set("history-archive", { id: "history-archive", label: "History Archive", messages: [], hidden: false });
    
    if (!activeTabId) activeTabId = "cmd:console";
  } catch (e) {
    console.warn("Failed to load state", e);
  }
}

/* --- Live Clock --- */
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  if (clockTime) clockTime.textContent = `${h}:${m}:${s}`;
}
updateClock();
setInterval(updateClock, 1000);

/* --- Live Price Tickers (Pyth Network WebSocket) --- */
(function initPriceTickers() {
  const priceBTC = document.querySelector("#priceBTC");
  const priceETH = document.querySelector("#priceETH");
  const priceDOGE = document.querySelector("#priceDOGE");

  const PYTH_IDS = {
    "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": "BTC",
    "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace": "ETH",
    "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c": "DOGE"
  };

  function formatPrice(p, asset) {
    const num = parseFloat(p);
    if (asset === 'DOGE') {
      return "$" + num.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 5 });
    }
    return "$" + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function connect() {
    const ws = new WebSocket("wss://hermes.pyth.network/ws");
    ws.onopen = () => {
      ws.send(JSON.stringify({
        "type": "subscribe",
        "ids": Object.keys(PYTH_IDS)
      }));
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "price_update" && data.price_feed && data.price_feed.price) {
        const id = data.price_feed.id;
        const asset = PYTH_IDS[id];
        if (asset) {
          const priceObj = data.price_feed.price;
          const priceVal = Number(priceObj.price) * Math.pow(10, priceObj.expo);
          
          if (asset === "BTC" && priceBTC) priceBTC.textContent = formatPrice(priceVal, 'BTC');
          if (asset === "ETH" && priceETH) priceETH.textContent = formatPrice(priceVal, 'ETH');
          if (asset === "DOGE" && priceDOGE) priceDOGE.textContent = formatPrice(priceVal, 'DOGE');
        }
      }
    };
    ws.onclose = () => {
      setTimeout(connect, 5000); // Reconnect on close
    };
    ws.onerror = () => {
      if (priceBTC) priceBTC.textContent = "Error";
      if (priceETH) priceETH.textContent = "Error";
      if (priceDOGE) priceDOGE.textContent = "Error";
    };
  }
  connect();
})();

/* The terminal has one supported appearance: dark mode with Geist. */
(function initTerminalAppearance() {
  document.documentElement.dataset.mode = "dark";
  document.documentElement.dataset.font = "geist";
  document.documentElement.removeAttribute("data-theme");

  const modalIds = ['settingsModal', 'historyModal', 'manualModal', 'alertModal', 'reasonModal', 'positionsModal', 'summaryModal', 'sniperSummaryModal'];
  modalIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) document.body.appendChild(el);
  });
})();

document.querySelector("#sidebarBackdrop")?.addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
});

document.querySelector("#sidebarToggleBtn")?.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-open");
});

document.addEventListener("click", (event) => {
  const closeModalButton = event.target.closest("[data-close-modal]");
  if (closeModalButton) {
    const modal = document.getElementById(closeModalButton.dataset.closeModal);
    if (modal) modal.style.display = "none";
    return;
  }

  const staticAction = event.target.closest("[data-static-action]")?.dataset.staticAction;
  if (staticAction === "close") closeStaticPanel();
  if (staticAction === "full-report") openFullReportModal();
});

const whaleVolumeToggle = document.querySelector("#whaleVolumeToggle");
whaleVolumeToggle?.addEventListener("click", toggleWhaleVolume);
whaleVolumeToggle?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleWhaleVolume();
});

/* --- Helpers --- */
function shortLabel(value, max = 34) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function tabInfoForCommand(requestText, mode = "auto") {
  const command = String(requestText || "").trim();
  const lower = command.toLowerCase();
  
  const topLabels = {
    "/top": "Volume", "/top liquidity": "Liquidity",
    "/top new": "New", "/top ending": "Ending",
  };

  if (topLabels[lower]) {
    return { id: `top:${lower.replace("/top", "volume").trim() || "volume"}`, label: topLabels[lower] };
  }

  // Everything else goes to a single unified tab
  return {
    id: "cmd:console",
    label: "Console",
  };
}

function ensureTab(tabInfo) {
  const info = typeof tabInfo === "string" ? { id: tabInfo, label: tabInfo } : tabInfo;
  if (!outputTabs.has(info.id)) {
    outputTabs.set(info.id, { id: info.id, label: info.label || "Console", messages: [], hidden: false });
  } else {
    const tab = outputTabs.get(info.id);
    if (info.label) tab.label = info.label;
    tab.hidden = false;
  }
  return outputTabs.get(info.id);
}

function activeTab() {
  return activeTabId ? outputTabs.get(activeTabId) : null;
}

function updateCommandDeckState() {
  document.querySelectorAll("[data-command]").forEach((btn) => {
    const tab = tabInfoForCommand(btn.dataset.command || "", "auto");
    btn.classList.toggle("active", tab.id === activeTabId);
  });
}

function renderTabs() {
  deckTabsEl.innerHTML = "";
  for (const tab of outputTabs.values()) {
    if (tab.hidden) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.title = tab.label;
    button.classList.toggle("active", tab.id === activeTabId);
    
    const labelSpan = document.createElement("span");
    labelSpan.textContent = tab.label;
    button.appendChild(labelSpan);

    if (tab.id !== "cmd:console" && tab.id !== "history-archive") {
      const closeSpan = document.createElement("span");
      closeSpan.textContent = "×";
      closeSpan.className = "tab-close";
      closeSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        tab.hidden = true;
        if (activeTabId === tab.id) {
          activeTabId = "cmd:console";
        }
        renderTabs();
        renderMessages();
        saveState();
      });
      button.appendChild(closeSpan);
    }

    button.addEventListener("click", () => setActiveTab(tab.id));
    deckTabsEl.append(button);
  }
  updateCommandDeckState();
}

function setActiveTab(tabInfo, options = {}) {
  const tab = typeof tabInfo === "string" ? outputTabs.get(tabInfo) : ensureTab(tabInfo);
  if (!tab) return;
  activeTabId = tab.id;
  if (options.reset) tab.messages = [];
  renderTabs();
  renderMessages();
  saveState();

  // Toggle Right Panel: polyPanelContainer vs historyListPanel
  const polyPanelContainer = document.querySelector("#polyPanelContainer");
  const historyListPanel = document.querySelector("#historyListPanel");
  const consoleBody = document.querySelector(".console-body");
  
  if (activeTabId === "history-archive") {
    if (historyListPanel) {
      historyListPanel.style.display = "flex";
      renderHistoryListPanel();
    }
  } else {
    if (historyListPanel) historyListPanel.style.display = "none";
  }
}

let pipelineInterval;
const pipelineStages = [
  "Inisiasi Agent...",
  "Menarik data Polymarket & Orderbook...",
  "Mengevaluasi sentimen pasar...",
  "Qwen-Kuantitatif memproses probabilitas...",
  "Menghitung Expected Value & Risk...",
  "Menyusun kesimpulan analisis..."
];

function setBusy(nextBusy) {
  busy = nextBusy;
  loadingState.classList.toggle("hidden", !busy);

  if (busy) {
    marketSummaryClosed = false;
  }

  // Disable action chips while busy
  document.querySelectorAll(".action-chip").forEach(btn => {
    btn.disabled = busy;
  });

  if (busy) {
    startedAt = Date.now();
    timerText.textContent = "0s";
    timerId = setInterval(() => {
      timerText.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
    }, 500);

    const dConc = document.getElementById("dashConclusionText");
    const staticPanel = document.getElementById("staticResultPanel");
    const staticContent = document.getElementById("staticResultContent");

    if (dConc || (staticPanel && staticContent)) {
      let stageIdx = 0;
      const initialText = pipelineStages[0];
      
      if (dConc) dConc.innerText = initialText;
      
      if (staticPanel && staticContent) {
        staticPanel.classList.remove("hidden");
        staticContent.style.overflowY = "hidden";
        staticContent.innerHTML = `
          <div class="empty-dashboard-state" style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 240px; gap: 20px;">
            <div class="spinner" style="width:40px; height:40px; border-width:2px; border-radius:50%; border-color:rgba(16,185,129,0.15); border-top-color:var(--neon-green);"></div>
            <div id="staticLoadingText" style="font-family:var(--font-secondary); font-size:12px; color:var(--neon-green); letter-spacing:0.2em; text-transform:uppercase; font-weight:500;">
              ${initialText}
            </div>
          </div>
        `;
      }

      if (pipelineInterval) clearInterval(pipelineInterval);
      
      pipelineInterval = setInterval(() => {
        stageIdx++;
        if (stageIdx < pipelineStages.length) {
          const newText = pipelineStages[stageIdx];
          if (dConc) dConc.innerText = newText;
          const slt = document.getElementById("staticLoadingText");
          if (slt) slt.innerText = newText;
        }
      }, 3000);
    }

  } else if (timerId) {
    clearInterval(timerId);
    timerId = null;
    if (pipelineInterval) clearInterval(pipelineInterval);
    const dConc = document.getElementById("dashConclusionText");
    if (dConc) dConc.innerText = "STANDBY - Siap menerima instruksi.";
    
    // Also reset static loading if it was aborted or finished without output
    const slt = document.getElementById("staticLoadingText");
    if (slt) {
      slt.innerText = "ANALISIS SELESAI";
      slt.style.color = "var(--text-secondary)";
    }
  }
}

function getCooldownRemaining(commandText) {
  if (!commandText) return 0;
  const target = isQwenCommand(commandText) ? qwenCooldownUntil : commandCooldownUntil;
  return Math.max(0, target - Date.now());
}

function setCooldown(ms, isQwen = false) {
  const durationMs = Math.max(0, Number(ms) || 0);
  if (!durationMs) return;
  const targetTime = Date.now() + durationMs;
  
  if (isQwen) {
    if (targetTime > qwenCooldownUntil) qwenCooldownUntil = targetTime;
  } else {
    if (targetTime > commandCooldownUntil) commandCooldownUntil = targetTime;
  }
  
  if (!cooldownTimerId) {
    cooldownTimerId = setInterval(updateCooldownUI, 250);
  }
  updateCooldownUI();
}

function updateCooldownUI() {
  const now = Date.now();

  // Display if ANY cooldown is active on the Guard Rail
  const maxRemainingMs = Math.max(0, qwenCooldownUntil - now, commandCooldownUntil - now);
  const maxRemaining = Math.ceil(maxRemainingMs / 1000);

  if (guardStatus) {
    if (maxRemaining > 0) {
      guardStatus.textContent = `Cooldown active (${maxRemaining}s) - Qwen protected`;
      guardStatus.style.color = "var(--text-warn)";
    } else {
      guardStatus.textContent = "Ready - Qwen protected";
      guardStatus.style.color = "var(--text-secondary)";
    }
  }
  if (guardDot) {
    guardDot.className = maxRemaining > 0 ? "guard-dot warn" : "guard-dot";
  }

  if (maxRemaining <= 0 && cooldownTimerId) {
    clearInterval(cooldownTimerId);
    cooldownTimerId = null;
    loadHealth();
  }
}

function cancelActiveRequest() {
  if (!activeRequest) return;
  activeRequest.abort();
}

/* --- Polymarket Embed --- */
function polymarketUrlsFromText(text) {
  return String(text || "").match(/https?:\/\/(?:www\.)?polymarket\.com\/[^\s)]+/gi) || [];
}

function slugFromPolymarketUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "polymarket.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const eventIndex = parts.indexOf("event");
    const marketIndex = parts.indexOf("market");
    const slug =
      eventIndex >= 0 && parts[eventIndex + 1] ? parts[eventIndex + 1]
        : marketIndex >= 0 && parts[marketIndex + 1] ? parts[marketIndex + 1]
        : parts.at(-1);
    return decodeURIComponent(slug || "");
  } catch { return ""; }
}

function embedUrlFromPolymarketUrl(value) {
  const slug = slugFromPolymarketUrl(value);
  if (!slug) return "";
  const url = new URL("https://embed.polymarket.com/market");
  url.searchParams.set("market", slug);
  url.searchParams.set("theme", "dark");
  url.searchParams.set("height", "550");
  return url.toString();
}

function setPolymarketEmbed(value, source = "Detected market") {
  const embedUrl = embedUrlFromPolymarketUrl(value);
  if (!embedUrl) return false;
  // polyFrame.src = embedUrl;
  // polyFrame.classList.remove("hidden");
  if (typeof polyEmpty !== 'undefined' && polyEmpty) polyEmpty.classList.add("hidden");
  if (typeof polyTitle !== 'undefined' && polyTitle) polyTitle.textContent = source;
  if (typeof polyOpenLink !== 'undefined' && polyOpenLink) {
    polyOpenLink.href = value;
    polyOpenLink.classList.remove("disabled");
  }
  
  if (typeof showPanel === "function") {
    // showPanel removed
  }
  
  return true;
}

function syncPolymarketEmbedFromText(text, source) {
  const urls = polymarketUrlsFromText(text);
  if (source === "From result" && (urls.length > 1 || /^TOP MARKETS\b|^SEARCH RESULTS\b/i.test(String(text || "")))) {
    return;
  }
  const [firstUrl] = urls;
  if (firstUrl) {
    let finalSource = source;
    if (source === "From result" || source === "From input") {
      const slug = slugFromPolymarketUrl(firstUrl);
      if (slug) {
        finalSource = slug.replace(/-/g, " ");
      }
    }
    setPolymarketEmbed(firstUrl, finalSource);
  }
}

/* --- Rendering --- */
function renderMessages() {
  messagesEl.innerHTML = "";
  const tab = activeTab();
  const messages = tab?.messages || [];
  if (emptyState) emptyState.classList.toggle("hidden", messages.length > 0 && !messages.every(m => m.deleted));
  for (const message of messages) {
    if (message.deleted) continue;
    appendMessageElement(message);
  }
  const embedMessage = [...messages].reverse().find(m => polymarketUrlsFromText(m.text).length);
  if (embedMessage) syncPolymarketEmbedFromText(embedMessage.text, "From result");
  messagesEl.scrollTop = 0;
}

function appendMessageElement(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role || "assistant"}`;

  const header = document.createElement("div");
  header.className = "message-header";
  const meta = document.createElement("span");
  meta.className = "msg-time";
  meta.textContent = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  header.append(meta);

  const body = document.createElement("div");
  body.className = "message-body formatted-text";
  
  if (message.role === "user") {
    body.textContent = message.text || "";
    body.classList.add("raw-pre");
  } else {
    // Format the plain text result into rich HTML
    const lines = (message.text || "").split("\n");
    let html = "";
    
    let currentSection = "";
    let sectionContent = "";
    let metricGrid = ""; // To hold metrics

    const getIconForSection = (title) => {
      if (title.includes("SUMMARY")) return "info";
      if (title.includes("ARAH")) return "compass";
      if (title.includes("SNAPSHOT")) return "bar-chart-2";
      if (title.includes("CONFIDENCE")) return "shield-alert";
      if (title.includes("ALASAN")) return "message-square";
      if (title.includes("KESIMPULAN AKHIR")) return "target";
      return "hash";
    };

    const flushSection = () => {
      if (!currentSection && !sectionContent) return;
      if (!currentSection) {
        // If there's no section, it's usually an error or plain text. 
        // Don't wrap in analysis-card so it doesn't trigger the static panel.
        html += `<div class="raw-text-message" style="color:var(--neon-red); padding:10px; background:rgba(255,0,0,0.1); border-radius:4px; margin-bottom:8px;">${sectionContent}</div>`;
        const isDanger = sectionContent.includes("SKIP") || sectionContent.includes("TIDAK LAYAK");
        const isWarn = sectionContent.includes("WAIT") || sectionContent.includes("HATI-HATI") || sectionContent.includes("WATCHLIST");
        const color = isDanger ? "var(--neon-red)" : (isWarn ? "var(--neon-amber)" : "var(--neon-green)");
        const bgWrap = isDanger ? "rgba(239, 68, 68, 0.08)" : (isWarn ? "rgba(245, 158, 11, 0.08)" : "rgba(16, 185, 129, 0.08)");
        
        html += `<div class="dash-agent-analysis" style="border-radius:12px; margin-bottom:12px; height:auto; max-height:none; padding:6px; flex:none; background:${bgWrap}; border:1px solid ${color}; box-shadow:0 0 20px ${bgWrap};">
          <div class="dash-inner-core" style="padding:16px; box-shadow:inset 0 1px 1px rgba(255,255,255,0.06); background:var(--bg-elevated); border-radius:8px; border-left:3px solid ${color};">
            <div class="dash-col-header" style="font-size:12px; font-weight:800; color:${color}; margin-bottom:14px; display:flex; align-items:center; gap:8px; text-transform:uppercase; letter-spacing:1px;">
              <i data-lucide="zap" style="width:16px;height:16px;color:${color};"></i> ${currentSection}
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
              ${sectionContent}
            </div>
          </div>
        </div>`;
      } else {
        // Normal card
        let content = sectionContent;
        if (currentSection === "SNAPSHOT DATA" && metricGrid) {
          content += `<div class="dash-grid-2x2" style="margin-bottom:0;">${metricGrid}</div>`;
        }
        let icon = getIconForSection(currentSection);
        html += `<div class="dash-agent-analysis" style="border-radius:12px; margin-bottom:12px; height:auto; max-height:none; padding:6px; flex:none;">
          <div class="dash-inner-core" style="padding:16px; box-shadow:inset 0 1px 1px rgba(255,255,255,0.06); background:var(--bg-elevated); border-radius:8px;">
            <div class="dash-col-header" style="font-size:11px; font-weight:600; color:var(--text-primary); margin-bottom:14px; display:flex; align-items:center; gap:8px; text-transform:uppercase; letter-spacing:1px;">
              <i data-lucide="${icon}" style="width:16px;height:16px;color:var(--neon-purple);"></i> ${currentSection}
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
              ${content}
            </div>
          </div>
        </div>`;
      }
      sectionContent = "";
      metricGrid = "";
      currentSection = "";
    };
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      // All-caps headers (e.g. MARKET SUMMARY, KESIMPULAN CEPAT)
      if (/^[A-Z0-9 \-&/]{3,}$/.test(line.trim())) {
        flushSection();
        currentSection = escapeHtml(line.trim());
      } 
      else if (/^([A-Za-z0-9 \(\)-]+):(.*)$/.test(line) && !line.startsWith("http")) {
        const match = line.match(/^([A-Za-z0-9 \(\)-]+):(.*)$/);
        const key = match[1].trim();
        const rawVal = match[2].trim();
        const safeKey = escapeHtml(key);

        if (key === "Realtime Ticker" && rawVal.length > 0) {
          const payload = escapeHtml(rawVal);
          sectionContent += `<div class="msg-kv realtime-ticker-kv"><span class="live-ticker" data-tokens="${payload}">⏳ Syncing CLOB & Crypto Feed...</span></div>`;
          continue;
        }

        // Visual progress bar handling
        if (key.startsWith("Confidence") && rawVal.includes(" | ")) {
           let part1 = `${key}: ${rawVal.split(" | ")[0]}`;
           let part2 = rawVal.split(" | ")[1];
           let pct1 = part1.match(/(\d+(\.\d+)?)%/);
           let pct2 = part2.match(/(\d+(\.\d+)?)%/);
           if (pct1 && pct2) {
             let p1 = parseFloat(pct1[1]);
             let p2 = parseFloat(pct2[1]);
              sectionContent += `<div style="font-size:10px; color:var(--text-tertiary); margin-top:8px; display:flex; justify-content:space-between;"><span>${escapeHtml(part1.split(':')[0])}</span><span>${escapeHtml(part2.split(':')[0])}</span></div>`;
             sectionContent += `<div class="visual-bar-container">
               <div class="visual-bar-fill" style="width:${p1}%">${p1}%</div>
               <div class="visual-bar-fill secondary" style="width:${p2}%">${p2}%</div>
             </div>`;
             continue;
           }
        }

        // Highlight percentages and money
        const val = escapeHtml(rawVal).replace(/(\$[\d,]+(\.\d+)?|\d+(\.\d+)?%)/g, '<span class="hl-val">$1</span>');
        
        if (currentSection === "SNAPSHOT DATA" && (key === "Liquidity" || key === "Gamma volume" || key.startsWith("Orderbook"))) {
          metricGrid += `<div class="dash-box"><div class="dash-label">${safeKey}</div><div class="dash-val" style="font-size:12px; color:var(--text-primary); font-family:'JetBrains Mono', monospace;">${val}</div></div>`;
        } else {
           sectionContent += `
              <div class="dash-box" style="margin-bottom:2px;">
                <div class="dash-label">${safeKey}</div>
               <div class="dash-val" style="font-size:12px; white-space:normal; line-height:1.4; color:var(--text-secondary); font-family:'JetBrains Mono', monospace;">${val}</div>
             </div>
           `;
        }
      } 
      // List items
      else if (line.startsWith("- ") || line.startsWith("* ")) {
        sectionContent += `<div style="font-size:11px; color:var(--text-secondary); margin-bottom:6px; line-height:1.5; padding-left:12px; position:relative;"><span style="position:absolute; left:0; color:var(--neon-purple);">&bull;</span> ${escapeHtml(line.substring(2))}</div>`;
      } 
      // Normal text
      else {
        const htmlLine = formatLimitedRichText(line);
        sectionContent += `<div class="msg-text">${htmlLine}</div>`;
      }
    }
    flushSection();
    
    body.innerHTML = html;
    
    // Refresh lucide icons for the newly injected HTML
    if (window.lucide) {
      window.lucide.createIcons({
        root: body
      });
    }

    // [STATIC PANEL INJECTION LOGIC]
    const staticPanel = document.getElementById("staticResultPanel");
    const staticContent = document.getElementById("staticResultContent");
    const isQueueCompletionSummary = String(message.text || "").includes("Antrian Selesai Diproses");
    if (staticPanel && staticContent && !marketSummaryClosed && !isQueueCompletionSummary) {
      staticPanel.classList.remove("hidden");
      if (html.includes('class="dash-agent-analysis"')) {
        // Real Qwen analysis result - show in static panel
        if (message.text && message.text.includes("MARKET SUMMARY")) {
          const bentoHtml = buildMarketSummaryHtml(message.text);
          staticContent.style.overflowY = "auto";
          staticContent.innerHTML = bentoHtml;
          // Store the report HTML globally so the full-report action can access it.
          window._currentReportHtml = html;

        } else {
          staticContent.style.overflowY = "auto";
          staticContent.innerHTML = html;
        }

        if (window.lucide) window.lucide.createIcons({ root: staticContent });
        wrapper.style.display = "none";
      } else {
        // Raw text / errors: also show them in the static panel if the console feed is hidden
        staticContent.style.overflowY = "auto";
        staticContent.innerHTML = `<div style="display:flex; flex-direction:column; justify-content:center; padding: 24px; background:var(--bg-elevated); border-radius:12px; border:1px solid rgba(255,255,255,0.05); position:relative;">\n          <button data-static-action="close" style="position:absolute; top:12px; right:12px; background:none; border:none; color:var(--text-tertiary); cursor:pointer;"><i data-lucide="x" style="width:16px;height:16px;"></i></button>\n          ${html}\n        </div>`;
        if (window.lucide) window.lucide.createIcons({ root: staticContent });
        wrapper.style.display = "none";
      }
    }
  }
  wrapper.append(header, body);

  const rows = Array.isArray(message.buttons) ? message.buttons : [];
  const flatButtons = rows.flat().filter(Boolean);
  if (flatButtons.length) {
    const grid = document.createElement("div");
    grid.className = "action-grid";
    for (const button of flatButtons) {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = button.label;
      action.addEventListener("click", () => executeCommand(button.command));
      grid.append(action);
    }
    wrapper.append(grid);
  }

  messagesEl.append(wrapper);
}

const SoundManager = {
  ctx: null,
  config: {
    enabled: true,
    soundTypeSniffer: 'coin',
    soundTypeQueue: 'chime',
    soundTypeAlerts: 'beep',
    snifferEnabled: true,
    queueEnabled: true,
    alertsEnabled: true
  },
  
  init() {
    const saved = localStorage.getItem('soundConfig');
    if (saved) this.config = { ...this.config, ...JSON.parse(saved) };
    
    const btnAudio = document.getElementById('toggleAudioBtn');
    if(btnAudio) {
      this.updateBtnState(btnAudio);
      btnAudio.onclick = () => {
        this.config.enabled = !this.config.enabled;
        this.updateBtnState(btnAudio);
        this.save();
        if(this.config.enabled) this.playType('chime');
      };
    }

    ['Sniffer', 'Queue', 'Alerts'].forEach(key => {
      // Checkbox for Enable/Disable
      const chk = document.getElementById('chkSound' + key);
      const confKey = key.toLowerCase() + 'Enabled';
      if(chk) {
        chk.checked = this.config[confKey];
        chk.onchange = (e) => {
          this.config[confKey] = e.target.checked;
          this.save();
        }
      }

      // Dropdown for Sound Type
      const sel = document.getElementById('selectSound' + key);
      const typeKey = 'soundType' + key;
      if(sel) {
        sel.value = this.config[typeKey];
        sel.onchange = (e) => {
          this.config[typeKey] = e.target.value;
          this.save();
          this.playType(this.config[typeKey]);
        }
      }
    });

    // Test Buttons
    document.querySelectorAll('.btnTestSound').forEach(btn => {
      btn.onclick = () => {
        const type = btn.dataset.type; // sniffer, queue, alerts
        let soundType = this.config.soundTypeSniffer;
        if (type === 'queue') soundType = this.config.soundTypeQueue;
        else if (type === 'alerts') soundType = this.config.soundTypeAlerts;
        this.playType(soundType, true);
      };
    });
  },

  updateBtnState(btn) {
    btn.textContent = this.config.enabled ? "ON" : "OFF";
    btn.style.color = this.config.enabled ? "var(--green)" : "var(--text-tertiary)";
    btn.style.borderColor = this.config.enabled ? "var(--green)" : "var(--text-tertiary)";
    btn.style.background = this.config.enabled ? "rgba(45,184,112,0.1)" : "rgba(255,255,255,0.05)";
  },
  
  save() {
    localStorage.setItem('soundConfig', JSON.stringify(this.config));
  },
  
  play(event) {
    if (!this.config.enabled) return;
    if (event === 'sniffer' && !this.config.snifferEnabled) return;
    if (event === 'queue' && !this.config.queueEnabled) return;
    if (event === 'alerts' && !this.config.alertsEnabled) return;
    
    let type = 'chime';
    if (event === 'sniffer') type = this.config.soundTypeSniffer;
    else if (event === 'queue') type = this.config.soundTypeQueue;
    else if (event === 'alerts') type = this.config.soundTypeAlerts;

    this.playType(type);
  },

  playType(type, force = false) {
    if (!force && !this.config.enabled) return;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    
    if (type === 'beep') this.playBeep();
    else if (type === 'coin') this.playCoin();
    else this.playChime();
  },
  
  playBeep() {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, this.ctx.currentTime);
    gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  },
  
  playCoin() {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(987.77, this.ctx.currentTime);
    osc.frequency.setValueAtTime(1318.51, this.ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.4);
  },
  
  playChime() {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, this.ctx.currentTime);
    osc2.frequency.setValueAtTime(659.25, this.ctx.currentTime);
    gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);
    osc1.start();
    osc2.start();
    osc1.stop(this.ctx.currentTime + 0.5);
    osc2.stop(this.ctx.currentTime + 0.5);
  }
};

window.playAlertSound = () => SoundManager.play('alerts');
window.playQueueDoneSound = () => {
    if (!SoundManager.config.enabled || !SoundManager.config.queueEnabled) return;
    if (!SoundManager.ctx) SoundManager.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (SoundManager.ctx.state === 'suspended') SoundManager.ctx.resume();
    
    // Generate a unique random tone for each completed analysis
    const freq = Math.floor(Math.random() * 800) + 400;
    const osc = SoundManager.ctx.createOscillator();
    const gain = SoundManager.ctx.createGain();
    
    osc.type = Math.random() > 0.5 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, SoundManager.ctx.currentTime);
    
    // Add a pitch slide 50% of the time for extra uniqueness
    if (Math.random() > 0.5) {
      osc.frequency.setValueAtTime(freq * 1.25, SoundManager.ctx.currentTime + 0.1);
    }
    
    gain.gain.setValueAtTime(0.1, SoundManager.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, SoundManager.ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(SoundManager.ctx.destination);
    osc.start();
    osc.stop(SoundManager.ctx.currentTime + 0.3);
  };
window.playSnifferSound = () => SoundManager.play('sniffer');

document.addEventListener('DOMContentLoaded', () => SoundManager.init());

// Real-time polling for live tickers
setInterval(async () => {
  const tickers = document.querySelectorAll('.live-ticker');
  if (!tickers.length) return;
  
  const tokenSet = new Set();
  tickers.forEach(t => tokenSet.add(t.getAttribute('data-tokens')));
  
  for (const payload of tokenSet) {
    if (!payload) continue;
    try {
      const parts = payload.split('|');
      const primaryToken = parts[0];
      const secondaryToken = parts[1];
      const primaryLabel = parts[2] || "Yes";
      const secondaryLabel = parts[3] || "No";
      const question = (parts[4] || "").toLowerCase();
      const endDateStr = parts[5] || "";
      
      const variant = (parts[6] || "").toLowerCase();
      
      let cryptoSymbol = "";
      let binanceSymbol = "";
      if (question.includes("bitcoin") || question.includes("btc") || variant.includes("btc")) {
        cryptoSymbol = "BTC"; binanceSymbol = "btcusdt";
      } else if (question.includes("ethereum") || question.includes("eth") || variant.includes("eth")) {
        cryptoSymbol = "ETH"; binanceSymbol = "ethusdt";
      } else if (question.includes("dogecoin") || question.includes("doge") || variant.includes("doge")) {
        cryptoSymbol = "DOGE"; binanceSymbol = "dogeusdt";
      }
      
      let klineInterval = "1h";
      let intervalLabel = "1H";
      let msInterval = 60 * 60 * 1000;
      
      const timeMatch = question.match(/(\d{1,2}:\d{2}(?:am|pm))\s*-\s*(\d{1,2}:\d{2}(?:am|pm))/i);
      if (timeMatch) {
        const t1 = timeMatch[1].replace(/am/i, ' AM').replace(/pm/i, ' PM');
        const t2 = timeMatch[2].replace(/am/i, ' AM').replace(/pm/i, ' PM');
        const d1 = new Date('2024-01-01 ' + t1);
        const d2 = new Date('2024-01-01 ' + t2);
        let diff = (d2 - d1) / 60000;
        if (diff < 0) diff += 24 * 60;
        
        if (diff === 5) {
          klineInterval = "5m"; intervalLabel = "5M"; msInterval = 5 * 60 * 1000;
        } else if (diff === 15) {
          klineInterval = "15m"; intervalLabel = "15M"; msInterval = 15 * 60 * 1000;
        } else if (diff === 30) {
          klineInterval = "30m"; intervalLabel = "30M"; msInterval = 30 * 60 * 1000;
        } else if (diff === 60) {
          klineInterval = "1h"; intervalLabel = "1H"; msInterval = 60 * 60 * 1000;
        } else {
          msInterval = diff * 60 * 1000;
        }
      } else if (question.includes("5m") || question.includes("5 min") || question.includes("5-min") || variant.includes("5m")) {
        klineInterval = "5m";
        intervalLabel = "5M";
        msInterval = 5 * 60 * 1000;
      } else if (question.includes("15m") || question.includes("15 min") || question.includes("15-min") || variant.includes("15m")) {
        klineInterval = "15m";
        intervalLabel = "15M";
        msInterval = 15 * 60 * 1000;
      } else if (question.includes("30m") || question.includes("30 min") || question.includes("30-min") || variant.includes("30m")) {
        klineInterval = "30m";
        intervalLabel = "30M";
        msInterval = 30 * 60 * 1000;
      }
      
      const getMidpoint = async (token) => {
        if (!token || token === "undefined") return null;
        try {
          const res = await fetch(`https://clob.polymarket.com/book?token_id=${token}&_t=${Date.now()}`, { cache: 'no-store' });
          if (!res.ok) return null;
          const data = await res.json();
          const bestBid = data.bids && data.bids.length ? Number(data.bids[0].price) : null;
          const bestAsk = data.asks && data.asks.length ? Number(data.asks[0].price) : null;
          if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
          if (bestBid != null) return bestBid;
          if (bestAsk != null) return bestAsk;
        } catch(e) {}
        return null;
      };

      const getPythLatestPrice = async () => {
        if (!cryptoSymbol) return null;
        
        window.pythLivePrices = window.pythLivePrices || {};
        window.pythLiveSockets = window.pythLiveSockets || {};

        const pythIds = {
          BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
          ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
          DOGE: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c"
        };
        const pid = pythIds[cryptoSymbol];
        if (!pid) return null;

        if (!window.pythLiveSockets[cryptoSymbol]) {
          const stream = new EventSource(`https://hermes.pyth.network/v2/updates/price/stream?ids[]=${pid}`);
          stream.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              const kInfo = data.parsed?.[0]?.price;
              if (kInfo) {
                const openPrice = parseFloat(kInfo.price) * Math.pow(10, kInfo.expo);
                window.pythLivePrices[cryptoSymbol] = openPrice;
              }
            } catch(err) {}
          };
          stream.onerror = () => { stream.close(); delete window.pythLiveSockets[cryptoSymbol]; };
          window.pythLiveSockets[cryptoSymbol] = stream;
        }

        // Return immediately if we have a price, otherwise wait up to 1 second
        if (window.pythLivePrices[cryptoSymbol]) {
           return window.pythLivePrices[cryptoSymbol];
        }
        
        return new Promise(resolve => {
           setTimeout(() => resolve(window.pythLivePrices[cryptoSymbol] || null), 1000);
        });
      };

      const getPythOpenPrice = async () => {
        if (!cryptoSymbol) return null;
        const pythIds = {
          BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
          ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
          DOGE: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c"
        };
        const pid = pythIds[cryptoSymbol];
        if (!pid) return null;

        let referenceTime = Date.now();
        if (endDateStr && endDateStr !== "undefined" && endDateStr !== "null") {
          const parsedEndDate = new Date(endDateStr).getTime();
          if (!isNaN(parsedEndDate)) referenceTime = parsedEndDate - msInterval;
        } else {
          referenceTime = Math.floor(Date.now() / msInterval) * msInterval;
        }
        const startTs = Math.floor(referenceTime / 1000);
        const cacheKey = `${pid}-${startTs}`;
        window.pythPriceCache = window.pythPriceCache || new Map();
        
        if (window.pythPriceCache.has(cacheKey)) {
          const cached = window.pythPriceCache.get(cacheKey);
          if (cached && cached.price) return cached.price;
          if (cached && Date.now() < cached.retryAfter) return null;
          window.pythPriceCache.delete(cacheKey);
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          let kRes = await fetch(`https://hermes.pyth.network/v2/updates/price/${startTs}?ids[]=${pid}&_t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
          clearTimeout(timeoutId);
          if (!kRes.ok && kRes.status !== 429) kRes = await fetch(`https://hermes.pyth.network/v2/updates/price/${startTs - 5}?ids[]=${pid}&_t=${Date.now()}`, { cache: 'no-store' });
          if (kRes.ok) {
            const kData = await kRes.json();
            const kInfo = kData.parsed?.[0]?.price;
            if (kInfo) {
              const openPrice = parseFloat(kInfo.price) * Math.pow(10, kInfo.expo);
              window.pythPriceCache.set(cacheKey, { price: openPrice });
              return openPrice;
            } else {
              window.pythPriceCache.set(cacheKey, { retryAfter: Date.now() + 5000 });
            }
          } else {
            window.pythPriceCache.set(cacheKey, { retryAfter: Date.now() + 5000 });
          }
        } catch(e) {
          window.pythPriceCache.set(cacheKey, { retryAfter: Date.now() + 5000 });
        }
        return null;
      };

      // Run all async requests concurrently
      const [primaryMid, secondaryMid, cryptoPrice, cryptoOpen] = await Promise.all([
        getMidpoint(primaryToken),
        getMidpoint(secondaryToken),
        getPythLatestPrice(),
        getPythOpenPrice()
      ]);
      
      const parsedEndDate = (endDateStr && endDateStr !== "undefined" && endDateStr !== "null") ? new Date(endDateStr).getTime() : null;
      const isMarketClosed = (parsedEndDate && Date.now() >= parsedEndDate) || (primaryMid == null && secondaryMid == null);
      
      let displayHtml = "";
      if (cryptoSymbol && cryptoPrice) {
        let decimals = cryptoSymbol === "DOGE" ? 4 : 2;
        
        // Also extract price from question as fallback (e.g. $67,000)
        let fallbackOpen = cryptoOpen;
        if (!fallbackOpen) {
           const priceMatch = (parts[4] || "").match(/\$?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/);
           if (!(parts[4] || "").toLowerCase().includes("up or down") && priceMatch) {
              fallbackOpen = parseFloat(priceMatch[1].replace(/,/g, ""));
           }
        }

        let pBeatStr = fallbackOpen ? `$${fallbackOpen.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}` : "TBD";
        let isWinning = fallbackOpen ? cryptoPrice >= fallbackOpen : true;
        let color = fallbackOpen ? (isWinning ? "var(--neon-green)" : "var(--neon-amber)") : "var(--text-primary)";
        
        displayHtml += `<div style="font-size:13px; color:var(--text-primary); font-weight:bold; margin-bottom:4px; display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; justify-content:space-between;">
            <span style="color:var(--text-secondary); font-size:11px;">${isMarketClosed ? 'Final Price to Beat:' : `Price to Beat (${intervalLabel}):`}</span> 
            <span style="color:var(--text-primary);">${pBeatStr}</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span style="color:var(--text-secondary); font-size:11px;">${isMarketClosed ? `Ending ${cryptoSymbol} Price:` : `Live ${cryptoSymbol} Price:`}</span> 
            <span style="${color};">$${cryptoPrice.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}</span>
          </div>
          <div style="font-size:10px; color:var(--text-tertiary); margin-top:2px;">*Target: Pyth Oracle | Live: Pyth SSE Stream</div>
        </div>`;
      }
      
      displayHtml += `<div style="display:flex; justify-content:space-between; gap:10px; font-size:12px; margin-top:4px;">`;
      if (primaryMid != null) {
        displayHtml += `<div style="flex:1; background:var(--bg-surface); padding:6px; border-radius:4px; border:1px solid var(--border); text-align:center;">
          <div style="color:var(--text-tertiary); font-size:10px; margin-bottom:2px;">${primaryLabel}</div>
          <div style="color:var(--neon-cyan); font-weight:bold; font-size:14px;">${Math.round(primaryMid * 100)}¢</div>
        </div>`;
      }
      if (secondaryMid != null) {
        displayHtml += `<div style="flex:1; background:var(--bg-surface); padding:6px; border-radius:4px; border:1px solid var(--border); text-align:center;">
          <div style="color:var(--text-tertiary); font-size:10px; margin-bottom:2px;">${secondaryLabel}</div>
          <div style="color:var(--neon-purple); font-weight:bold; font-size:14px;">${Math.round(secondaryMid * 100)}¢</div>
        </div>`;
      }
      displayHtml += `</div>`;
      
      document.querySelectorAll(`.live-ticker[data-tokens="${payload}"]`).forEach(el => {
        el.innerHTML = displayHtml;
        if (isMarketClosed) {
          el.classList.remove("live-ticker"); // Stop polling!
        }
      });
      
      // Update the Polymarket Embed Overlay for the LATEST payload
      const tickersArr = Array.from(tickers);
      const latestPayload = tickersArr[tickersArr.length - 1].getAttribute('data-tokens');
      if (payload === latestPayload) {
        const polyLiveTicker = document.querySelector("#polyLiveTicker");
        const polyMidpoint = document.querySelector("#polyMidpoint");
        const polyBestBid = document.querySelector("#polyBestBid");
        const polyBestAsk = document.querySelector("#polyBestAsk");
        const polyEmpty = document.querySelector("#polyEmpty");
        
        if (polyLiveTicker && polyMidpoint && polyEmpty && polyEmpty.classList.contains("hidden")) {
          polyLiveTicker.style.display = "block";
          if (cryptoSymbol && cryptoPrice) {
            let decimals = cryptoSymbol === "DOGE" ? 4 : 2;
            let pBeatStr = cryptoOpen ? `$${cryptoOpen.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}` : "TBD";
            let isWinning = cryptoOpen ? cryptoPrice >= cryptoOpen : true;
            let color = cryptoOpen ? (isWinning ? "var(--neon-green)" : "var(--neon-amber)") : "var(--text-primary)";
            
            let statusBadge = isMarketClosed ? `<span style="background:var(--bg-surface); border:1px solid var(--border); padding:2px 6px; border-radius:4px; font-size:9px; color:var(--text-tertiary); text-transform:uppercase;">Closed</span>` : "";
            
            polyMidpoint.innerHTML = `<div><span style="font-size:11px; color:var(--text-tertiary);">Price to Beat:</span> <span style="color:white;">${pBeatStr}</span> ${statusBadge}</div>` +
                                     `<div style="margin-top:2px;"><span style="font-size:11px; color:var(--text-tertiary);">Current:</span> <span style="${color};">$${cryptoPrice.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}</span></div>`;
          } else {
            polyMidpoint.innerHTML = isMarketClosed ? `Live Market Data <span style="background:var(--bg-surface); border:1px solid var(--border); padding:2px 6px; border-radius:4px; font-size:9px; color:var(--text-tertiary); text-transform:uppercase;">Closed</span>` : "Live Market Data";
          }
          
          polyBestBid.innerHTML = `${primaryLabel}: <span style="color:var(--neon-cyan); font-size:16px;">${primaryMid != null ? Math.round(primaryMid*100) + '¢' : '-'}</span>`;
          polyBestAsk.innerHTML = `${secondaryLabel}: <span style="color:var(--neon-amber); font-size:16px;">${secondaryMid != null ? Math.round(secondaryMid*100) + '¢' : '-'}</span>`;
        } else if (polyLiveTicker) {
          polyLiveTicker.style.display = "none";
        }
      }
    } catch (e) {
      // ignore
    }
  }
}, 2000);

function addMessage(message, tabId = activeTabId) {
  const tab = ensureTab(tabId ? outputTabs.get(tabId) || { id: tabId, label: "Console" } : { id: "console", label: "Console" });
  if (!activeTabId) activeTabId = tab.id;
  tab.messages.push(message);
  renderTabs();

  if (tab.id === activeTabId) {
    if (emptyState) emptyState.classList.add("hidden");
    appendMessageElement(message);
    if (message.role === "user") {
      requestAnimationFrame(() => { messagesEl.scrollTop = 0; });
    }
    syncPolymarketEmbedFromText(message.text, "From result");
  }
  
  if (message.role === "assistant" || message.role === "system") {
    if (message.text && (message.text.includes('"verdict": "VALUE CANDIDATE"') || message.text.includes('"verdict": "HIGH RISK UNDERDOG"'))) {
      playAlertSound();
    }
  }
  
  saveState();
}

function addUserInput(text, tabId) { addMessage({ role: "user", text }, tabId); }

function showToast(text, type = "error", durationMs = 8000) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  const isError = type === "error";
  toast.style.cssText = `
    pointer-events: all;
    background: ${isError ? "rgba(20,5,5,0.96)" : "rgba(5,15,10,0.96)"};
    border: 1px solid ${isError ? "rgba(239,68,68,0.5)" : "rgba(16,185,129,0.5)"};
    border-radius: 8px;
    padding: 10px 14px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    line-height: 1.5;
    color: ${isError ? "#fca5a5" : "#6ee7b7"};
    max-width: 100%;
    word-break: break-word;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    opacity: 0;
    transform: translateX(12px);
    transition: opacity 0.25s ease, transform 0.25s ease;
    cursor: pointer;
  `;
  
  const icon = document.createElement("span");
  icon.style.cssText = "flex-shrink:0; font-size:12px;";
  icon.textContent = isError ? "!" : "OK";
  const message = document.createElement("span");
  message.style.whiteSpace = "pre-line";
  message.textContent = String(text || "");
  toast.append(icon, message);
  toast.title = "Click to dismiss";
  toast.addEventListener("click", () => removeToast(toast));
  
  container.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(0)";
    });
  });

  // Auto dismiss
  const timer = setTimeout(() => removeToast(toast), durationMs);
  toast._timer = timer;
  
  function removeToast(t) {
    clearTimeout(t._timer);
    t.style.opacity = "0";
    t.style.transform = "translateX(12px)";
    setTimeout(() => t.remove(), 280);
  }
}

function addError(text, tabId) { 
  // Show as a visible toast so errors are never silently swallowed in the hidden console feed
  showToast(text, "error", 10000);
  // Also store in messages for tab history
  addMessage({ role: "error", text }, tabId); 
}

function warnIfServerVersionMismatch(data = {}, tabId = activeTabId) {
  if (!data.version || data.version === CLIENT_VERSION || versionWarningShown) return;
  versionWarningShown = true;
  addError(`Server masih jalan versi lama (${data.version}). Stop proses npm lama, lalu jalankan npm.cmd start lagi.`, tabId);
}

function syncRateLimit(data = {}) {
  const limits = data.rateLimit || {};
  if (Number.isFinite(limits.commandCooldownMs)) commandCooldownMs = limits.commandCooldownMs;
  if (Number.isFinite(limits.qwenCommandCooldownMs)) qwenCommandCooldownMs = limits.qwenCommandCooldownMs;
  if (Number.isFinite(limits.duplicateCommandCooldownMs)) duplicateCommandCooldownMs = limits.duplicateCommandCooldownMs;

  const cWaitMs = limits.commandWaitMs || 0;
  if (cWaitMs > 0) {
    setCooldown(cWaitMs, false);
  }

  const qWaitMs = limits.qwenWaitMs || 0;
  if (qWaitMs > 0) {
    setCooldown(qWaitMs, true);
  }
}

function isQwenCommand(commandText) {
  const lower = String(commandText || "").trim().toLowerCase();
  const QWEN_COMMANDS = ["/analyze", "/shortanalyze", "/analyzebest", "/analyzeall", "/analyzequeue", "/eventmarket", "/eventbest", "/eventall"];
  const [cmdName, ...args] = lower.split(/\s+/);
  return QWEN_COMMANDS.includes(cmdName) && args.length > 0;
}

/* --- Execute Command --- */
function markQueueItemsFailed(cmdText) {
  if (typeof analysisQueue === 'undefined' || !analysisQueue.length) return;
  const urls = [];
  if (cmdText.startsWith("/analyze ")) urls.push(cmdText.replace("/analyze ", "").trim());
  if (cmdText.startsWith("/analyzequeue ")) urls.push(...cmdText.replace("/analyzequeue ", "").split(",").map(s => s.trim()));
  let changed = false;
  urls.forEach(target => {
    const item = analysisQueue.find(m => m.url === target || String(m.id) === target);
    if (item) {
      item.isFailed = true;
      changed = true;
    }
  });
  if (changed && typeof renderQueue === 'function') renderQueue();
}

async function executeCommand(commandText, isBackground = false) {
  if (busy) return { ok: false, deferred: true };
  const text = String(commandText || "").trim();
  if (!text) return { ok: false, deferred: false };

  const remMs = getCooldownRemaining(text);
  if (remMs > 0) {
    const tabInfo = tabInfoForCommand(text, "auto");
    if (!isBackground) setActiveTab(tabInfo);
    if (!isBackground) addError(`ANTI-SPAM: Command ini masih dalam cooldown ${Math.ceil(remMs / 1000)} detik lagi.`, tabInfo.id);
    return { ok: false, deferred: true };
  }

  const tabInfo = tabInfoForCommand(text, "auto");
  if (!isBackground) setActiveTab(tabInfo, { reset: true });
  
  // CLEAR messages so only 1 analysis shows up in the tab
  const tab = ensureTab(tabInfo.id);
  if (tab) {
    tab.messages = [];
    renderMessages();
  }

  // Panel short market stays visible in sidebar (no hide on command)

  addUserInput(text, tabInfo.id);
  syncPolymarketEmbedFromText(text, "From input");
  activeRequest = new AbortController();
  setBusy(true);

  const fetchStart = Date.now();

  let data = null;
  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, mode: "auto", language: "Indonesia" }),
      signal: activeRequest.signal,
    });
    data = await response.json();
    const latency = Date.now() - fetchStart;
    if (sbLatency) sbLatency.textContent = `${latency}ms`;

    syncRateLimit(data);
    warnIfServerVersionMismatch(data, tabInfo.id);

    if (!data.ok) {
      addError(data.error || "Request gagal.", tabInfo.id);
      for (const msg of data.messages || []) {
        if (!msg.deleted) addMessage(msg, tabInfo.id);
      }
      if (!isBackground) markQueueItemsFailed(text);
      return { ok: false, deferred: false, data };
    }

    if (data.result?.status === "rejected") {
      return { ok: false, deferred: true, data };
    }
    for (const msg of data.messages || []) {
      if (!msg.deleted) addMessage(msg, tabInfo.id);
    }
    return { ok: true, deferred: false, data };
  } catch (error) {
    if (error.name === "AbortError") {
      addError("Prompt dibatalkan.", tabInfo.id);
    } else {
      let errorMsg = error.message || String(error);
      if (errorMsg === "Failed to fetch") {
        errorMsg = "❌ Failed to fetch: Gagal menghubungi server backend.\n\nKemungkinan penyebab:\n1. Server backend mati (pastikan 'npm start' sedang berjalan)\n2. Port backend berubah atau tidak ter-expose\n3. Jaringan internet atau lokal terputus\n4. Ekstensi browser (adblocker/cors) memblokir request";
      }
      addError(errorMsg, tabInfo.id);
      if (!isBackground) markQueueItemsFailed(text);
    }
    return { ok: false, deferred: false, error };
  } finally {
    activeRequest = null;
    // Refresh history so that recent analysis is shown in the History tab
    await fetchHistoryEvents();
    await Promise.all([fetchStats(), fetchDashboardMetrics()]);
    
    setBusy(false);
    if (isBackground) playQueueDoneSound();
    
    // Jika fetch sukses, state udah disync via syncRateLimit.
    // Jika gagal network, set local fallback cooldown.
    if (!data || !data.rateLimit) {
      const isQwen = isQwenCommand(commandText);
      const ms = isQwen ? qwenCommandCooldownMs : commandCooldownMs;
      setCooldown(ms, isQwen);
    }
  }
}

/* --- Real-Time WS Status Polling --- */
function getSnifferUiStatus(health, isActive = null) {
  if (isActive === false) return { label: 'Offline', tone: 'offline' };
  if (!health) return isActive === true ? { label: 'Live', tone: 'live' } : { label: 'Offline', tone: 'offline' };

  const state = String(typeof health === 'string' ? health : health.state || '').toUpperCase();
  const expected = Number(typeof health === 'object' ? health.expectedShards : NaN);
  const connected = Number(typeof health === 'object' ? health.connectedShards : NaN);
  const hasPartialShards = Number.isFinite(expected) && expected > 0 && Number.isFinite(connected) && connected < expected;

  if (state === 'CONNECTING' || state === 'RECONNECTING' || state === 'STARTING') {
    return { label: 'Connecting', tone: 'connecting' };
  }
  if (state === 'DEGRADED' || state === 'PARTIAL' || hasPartialShards) {
    return { label: 'Degraded', tone: 'degraded' };
  }
  if (state === 'CONNECTED' || state === 'LIVE' || (Number.isFinite(connected) && connected > 0 && connected === expected)) {
    return { label: 'Live', tone: 'live' };
  }
  if (Number.isFinite(connected) && connected > 0) return { label: 'Degraded', tone: 'degraded' };
  if (isActive === true) return { label: 'Connecting', tone: 'connecting' };
  return { label: 'Offline', tone: 'offline' };
}

function describeSnifferHealth(health, status) {
  if (!health || typeof health === 'string') return status.label;
  const details = [status.label];
  if (health.expectedShards != null || health.connectedShards != null) {
    details.push(`shards ${health.connectedShards ?? 0}/${health.expectedShards ?? '?'}`);
  }
  if (health.subscribedTokens != null) {
    const tokenCount = Array.isArray(health.subscribedTokens) ? health.subscribedTokens.length : health.subscribedTokens;
    details.push(`tokens ${tokenCount}`);
  }
  if (health.lastMessageAt) details.push(`last message ${new Date(health.lastMessageAt).toLocaleTimeString()}`);
  return details.join(' | ');
}

async function fetchWsStatus() {
  try {
    const res = await fetch('/api/ws-status');
    const data = await res.json();
    
    const updateDot = (id, status) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (status === 'CONNECTED') el.style.background = 'var(--neon-green)';
      else if (status === 'CONNECTING' || status === 'RECONNECTING') el.style.background = 'var(--neon-amber)';
      else el.style.background = 'var(--neon-red)';
    };

    const snifferHealth = data.snifferHealth || data.sniffer;
    const snifferStatus = getSnifferUiStatus(snifferHealth);
    const snifferDot = document.getElementById('wsStatusSniffer');
    if (snifferDot) {
      snifferDot.style.background = snifferStatus.tone === 'live'
        ? 'var(--neon-green)'
        : snifferStatus.tone === 'offline' ? 'var(--neon-red)' : 'var(--neon-amber)';
      const polygonState = data.polygon?.state ? ` | wallet ${String(data.polygon.state).toLowerCase()}` : "";
      snifferDot.title = describeSnifferHealth(snifferHealth, snifferStatus) + polygonState;
    }
    updateDot('wsStatusLiq', data.binance?.liquidation);
    updateDot('wsStatusDepth', data.binance?.depth);
  } catch (e) {
    // If backend is down, mark all as red
    const els = ['wsStatusSniffer', 'wsStatusLiq', 'wsStatusDepth'];
    els.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.background = 'var(--neon-red)';
    });
  }
}
setInterval(fetchWsStatus, 2000);
fetchWsStatus(); // Initial call

/* --- Health Check --- */
async function loadHealth() {
  const fetchStart = Date.now();
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    const latency = Date.now() - fetchStart;

    syncRateLimit(data);
    const version = data.version || "Engine ready";
    versionText.textContent = version;
    warnIfServerVersionMismatch(data);

    const serverOutdated = data.version && data.version !== CLIENT_VERSION;

    const qwenLabel = data.qwen?.qwenLabel;
    const qwenConfigured = data.qwen?.qwenConfigured;
    
    if (qwenStatus) {
      qwenStatus.classList.toggle("warn", !qwenConfigured || serverOutdated);
      qwenStatus.classList.toggle("ai", qwenConfigured && !serverOutdated);
      
      const isError = !qwenConfigured || serverOutdated;
      const baseText = serverOutdated ? "Server old" : qwenLabel || "Qwen ?";
      qwenStatus.innerHTML = isError ? `<span style="display:flex; align-items:center; gap:4px; cursor:pointer;" title="Click to reconnect"><i data-lucide="refresh-cw" style="width:10px; height:10px;"></i> ${escapeHtml(baseText)}</span>` : escapeHtml(baseText);
      if (isError && typeof lucide !== 'undefined') lucide.createIcons();
      qwenStatus.style.cursor = isError ? "pointer" : "default";
    }

    // Dynamic engine count
    const btnToggleEngines = document.getElementById("btnToggleEngines");
    if (btnToggleEngines) {
      let activeCount = 2; // Assuming Gamma and CLOB are always loaded for now, as they have no explicit health check in app.js
      if (qwenConfigured && !serverOutdated) activeCount++;
      btnToggleEngines.innerHTML = `${activeCount} Engines Loaded`;
    }

    if (connDot) connDot.className = "status-bar-dot";
    if (connLabel) connLabel.textContent = "Connected";
    if (sbEngine) sbEngine.textContent = `Engine: ${shortLabel(version, 40)}`;
    if (sbLatency) {
      sbLatency.textContent = `${latency}ms`;
      if (latency < 100) sbLatency.style.color = 'var(--neon-green)';
      else if (latency < 300) sbLatency.style.color = 'var(--neon-amber)';
      else sbLatency.style.color = 'var(--neon-red)';
    }
    if (sbQwenDot) sbQwenDot.className = qwenConfigured ? "status-bar-dot ai" : "status-bar-dot warn";
    if (sbQwenLabel) sbQwenLabel.textContent = qwenConfigured ? "Qwen: • loaded" : "Qwen: ? missing";

    // Update AI Token display from health (lightweight, token-only)
    if (data.totalAITokensUsed) {
      const tokenUsageObj = data.totalAITokensUsed;
      let totalUsed = 0;
      let tokenHtml = '';
      for (const [model, tokens] of Object.entries(tokenUsageObj)) {
        totalUsed += tokens;
        tokenHtml += `
          <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:4px 8px; border-radius:4px; font-size:10px; gap:8px;">
             <span style="color:var(--text-primary); font-family:var(--font-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px;" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
            <span style="color:var(--neon-green); font-weight:bold; white-space:nowrap;">${tokens.toLocaleString()}</span>
          </div>
        `;
      }
      const aiPercentLabel = document.getElementById('aiTokenPercent');
      if (aiPercentLabel) aiPercentLabel.innerText = totalUsed.toLocaleString();
      const modelList = document.getElementById('aiTokenModelList');
      if (modelList) modelList.innerHTML = tokenHtml || '<div style="font-size:10px; color:var(--text-tertiary); text-align:center;">No tokens used yet</div>';
    }
  } catch {
    versionText.textContent = "Engine offline";
    if (qwenStatus) {
      qwenStatus.classList.add("warn");
      qwenStatus.classList.remove("ai");
      qwenStatus.innerHTML = `<span style="display:flex; align-items:center; gap:4px; cursor:pointer;" title="Click to reconnect"><i data-lucide="refresh-cw" style="width:10px; height:10px;"></i> Offline</span>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      qwenStatus.style.cursor = "pointer";
    }
    if (connDot) connDot.className = "status-bar-dot error";
    if (connLabel) connLabel.textContent = "Disconnected";
    if (sbEngine) sbEngine.textContent = "Engine: offline";
    if (sbQwenDot) sbQwenDot.className = "status-bar-dot error";
    if (sbQwenLabel) sbQwenLabel.textContent = "Qwen: offline";
    if (sbLatency) {
      sbLatency.textContent = "--ms";
      sbLatency.style.color = 'inherit';
    }
  }
}

async function detectDns() {
  const sbDns = document.querySelector("#sbDns");
  if (!sbDns) return;
  try {
    const res = await fetch("https://edns.ip-api.com/json");
    if (!res.ok) throw new Error("EDNS failed");
    const data = await res.json();
    if (data.dns && data.dns.geo) {
      sbDns.textContent = `DNS: ${data.dns.geo}`;
    } else {
      sbDns.textContent = "DNS: Unknown";
    }
  } catch(e) {
    sbDns.textContent = "DNS: Not Detected";
  }
}

/* --- Event Listeners --- */

if (qwenStatus) {
  qwenStatus.addEventListener("click", () => {
    if (qwenStatus.classList.contains("warn")) {
      qwenStatus.innerHTML = `<span style="display:flex; align-items:center; gap:4px;"><i data-lucide="refresh-cw" style="width:10px; height:10px;"></i> Reconnecting...</span>`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      loadHealth();
    }
  });
}

// Discover chips (no input needed, run immediately)
document.querySelectorAll("[data-command]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const command = btn.dataset.command;
    if (command) {
      executeCommand(command);
    }
  });
});

// Toggle Polymarket panel explicitly
const polyMenuDropdown = document.querySelector("#polyMenuDropdown");
const menuBtnPoly = document.querySelector("#menuBtnPoly");
const menuBtnX = document.querySelector("#menuBtnX");
const xPanelContainer = document.querySelector("#xPanelContainer");
const currentPanelLabel = document.querySelector("#currentPanelLabel");
let activeRightPanel = null;

if (togglePolyBtn) {
  togglePolyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    
    // If a panel is active, clicking the main button closes it
    const consoleBody = document.querySelector(".console-body");
    if (consoleBody && consoleBody.classList.contains("has-embed") && activeRightPanel !== null) {
      consoleBody.classList.remove("has-embed");
      activeRightPanel = null;
      if (currentPanelLabel) currentPanelLabel.textContent = "Select Panel";
      return;
    }
    
    if (polyMenuDropdown) {
      const isHidden = polyMenuDropdown.style.display === "none";
      polyMenuDropdown.style.display = isHidden ? "flex" : "none";
    }
  });
  
  document.addEventListener("click", (e) => {
    if (polyMenuDropdown && togglePolyBtn && !togglePolyBtn.contains(e.target) && !polyMenuDropdown.contains(e.target)) {
      polyMenuDropdown.style.display = "none";
    }
  });
}

function showPanel(panelType) {
  const consoleBody = document.querySelector(".console-body");
  if (!consoleBody) return;
  
  if (polyMenuDropdown) polyMenuDropdown.style.display = "none";
  
  if (activeRightPanel === panelType) {
     activeRightPanel = null;
     if (currentPanelLabel) currentPanelLabel.textContent = "Select Panel";
     return;
  }
  
  activeRightPanel = panelType;
  
  if (panelType === 'poly') {
    if (polyPanelContainer) polyPanelContainer.style.display = "flex";
    if (xPanelContainer) xPanelContainer.style.display = "none";
    if (currentPanelLabel) currentPanelLabel.textContent = "Polymarket";
    
    // If turning on but empty, show default empty state
    if (typeof polyEmpty !== 'undefined' && polyEmpty && document.querySelector("#polyLiveTicker") && document.querySelector("#polyLiveTicker").style.display === "none") {
      polyEmpty.classList.remove("hidden");
    }
  } else if (panelType === 'x') {
    if (polyPanelContainer) polyPanelContainer.style.display = "none";
    if (xPanelContainer) xPanelContainer.style.display = "flex";
    if (currentPanelLabel) currentPanelLabel.textContent = "X (Twitter)";
  }
}

if (menuBtnPoly) {
  menuBtnPoly.addEventListener("click", () => showPanel('poly'));
}

if (menuBtnX) {
  menuBtnX.addEventListener("click", () => showPanel('x'));
}

/* --- Short Market Events (sidebar) --- */
const shortMarketPanel = document.querySelector("#shortMarketPanel");
const btnRefreshShortMarket = document.querySelector("#btnRefreshShortMarket");
const shortMarketList = document.querySelector("#shortMarketList");
const shortMarketStatus = document.querySelector("#shortMarketStatus");

const tabAssetBtc = document.querySelector("#tabAssetBtc");
const tabAssetEth = document.querySelector("#tabAssetEth");
const tabAssetDoge = document.querySelector("#tabAssetDoge");

let shortMarketTimer = null;
let shortMarketRealtimeInterval = null;
let currentShortMarkets = [];
let activeShortAsset = 'btc';
let activeShortDuration = '5m';

function updateActiveAssetTab() {
  if (tabAssetBtc) {
    tabAssetBtc.style.color = activeShortAsset === 'btc' ? 'var(--neon-amber)' : 'var(--text-tertiary)';
    tabAssetBtc.style.background = activeShortAsset === 'btc' ? 'rgba(245,158,11,0.1)' : 'transparent';
  }
  if (tabAssetEth) {
    tabAssetEth.style.color = activeShortAsset === 'eth' ? 'var(--neon-amber)' : 'var(--text-tertiary)';
    tabAssetEth.style.background = activeShortAsset === 'eth' ? 'rgba(245,158,11,0.1)' : 'transparent';
  }
  if (tabAssetDoge) {
    tabAssetDoge.style.color = activeShortAsset === 'doge' ? 'var(--neon-amber)' : 'var(--text-tertiary)';
    tabAssetDoge.style.background = activeShortAsset === 'doge' ? 'rgba(245,158,11,0.1)' : 'transparent';
  }
}

function updateActiveDurationTab() {
  const tabs = {
    '5m': document.getElementById('tabDuration5m'),
    '15m': document.getElementById('tabDuration15m'),
    '1h': document.getElementById('tabDuration1h'),
    '4h': document.getElementById('tabDuration4h'),
    '1d': document.getElementById('tabDuration1d')
  };

  Object.keys(tabs).forEach(dur => {
    const tab = tabs[dur];
    if (!tab) return;
    if (dur === activeShortDuration) {
      tab.style.color = '#ccc';
      tab.style.background = 'rgba(255,255,255,0.05)';
    } else {
      tab.style.color = '#555';
      tab.style.background = 'transparent';
    }
  });
}

// Auto-load short markets on page start
(function initShortMarket() {
  activeShortAsset = "btc";
  activeShortDuration = "5m";
  updateActiveAssetTab();
  updateActiveDurationTab();
  fetchShortMarkets();
  startShortRealtimeTimer();
})();

if (tabAssetBtc) tabAssetBtc.addEventListener("click", () => { activeShortAsset = 'btc'; updateActiveAssetTab(); fetchShortMarkets(); });
if (tabAssetEth) tabAssetEth.addEventListener("click", () => { activeShortAsset = 'eth'; updateActiveAssetTab(); fetchShortMarkets(); });
if (tabAssetDoge) tabAssetDoge.addEventListener("click", () => { activeShortAsset = 'doge'; updateActiveAssetTab(); fetchShortMarkets(); });

const setDurationTab = (dur) => {
  activeShortDuration = dur;
  updateActiveDurationTab();
  renderShortMarkets(currentShortMarkets);
};
const t5 = document.getElementById('tabDuration5m');
if (t5) t5.addEventListener("click", () => setDurationTab('5m'));
const t15 = document.getElementById('tabDuration15m');
if (t15) t15.addEventListener("click", () => setDurationTab('15m'));
const t1h = document.getElementById('tabDuration1h');
if (t1h) t1h.addEventListener("click", () => setDurationTab('1h'));
const t4h = document.getElementById('tabDuration4h');
if (t4h) t4h.addEventListener("click", () => setDurationTab('4h'));
const t1d = document.getElementById('tabDuration1d');
if (t1d) t1d.addEventListener("click", () => setDurationTab('1d'));

if (btnRefreshShortMarket) {
  btnRefreshShortMarket.addEventListener("click", () => {
    fetchShortMarkets();
  });
}

async function fetchShortMarkets() {
  if (shortMarketStatus) shortMarketStatus.textContent = "Updating...";
  try {
    const res = await fetch(`/api/short-term?asset=${activeShortAsset}`);
    const data = await res.json();
    if (data.ok) {
      currentShortMarkets = data.markets || [];
      renderShortMarkets(currentShortMarkets);
      if (shortMarketStatus) {
        const now = new Date();
        shortMarketStatus.textContent = `Last update: ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      }
    } else {
      if (shortMarketStatus) shortMarketStatus.textContent = "Error updating";
    }
  } catch (error) {
    console.error("Failed to fetch short markets:", error);
    if (shortMarketStatus) shortMarketStatus.textContent = "Network error";
    if (shortMarketList) {
      shortMarketList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--neon-red);"><i data-lucide="wifi-off" style="width:24px; height:24px; margin-bottom:8px;"></i><br><b>Gagal memuat data.</b><br><br><span style="font-size:10px; color:var(--text-tertiary);">Error: ${escapeHtml(error.message)}<br>Kemungkinan penyebab:<br>1. Jaringan terputus<br>2. Server backend mati/restart<br>3. Blocked by browser extension</span></div>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  // Auto refresh panel every 60 seconds (SSE handles live prices)
  if (shortMarketTimer) clearTimeout(shortMarketTimer);
  shortMarketTimer = setTimeout(fetchShortMarkets, 60000);
}

const queueBtnStyle = document.createElement('style');
queueBtnStyle.textContent = `
  body:not(.queue-open) .btn-add-to-queue { display: none !important; }
  body.queue-open .btn-add-to-queue { display: flex !important; }
`;
document.head.appendChild(queueBtnStyle);

window.handleDragStart = function(event, element) {
  const id = element.getAttribute("data-id");
  const url = element.getAttribute("data-url");
  const question = element.getAttribute("data-question");
  const endDate = element.getAttribute("data-end-date") || element.querySelector(".short-market-timer")?.getAttribute("data-end-date");
  const duration_type = element.getAttribute("data-duration-type") || activeShortDuration || "5m";
  event.dataTransfer.setData("text/plain", JSON.stringify({ id, url, question, endDate, duration_type }));
  element.style.opacity = "0.5";
};

window.handleDragEnd = function(event) {
  event.currentTarget.style.opacity = "1";
};

window.addCardToQueue = function(card) {
  if (!card) return;
  const id = card.getAttribute("data-id");
  const url = card.getAttribute("data-url");
  const question = card.getAttribute("data-question");
  const endDate = card.getAttribute("data-end-date") || card.querySelector(".short-market-timer")?.getAttribute("data-end-date");
  const duration_type = card.getAttribute("data-duration-type") || activeShortDuration || "5m";
  if (id) addToQueue({ id, url, question, endDate, duration_type });
};

// Bulk Add Dropdown & Selection Panel Logic
function populateBulkStartOptions() {
  const customBulkStartOptions = document.querySelector("#customBulkStartOptions");
  if (!customBulkStartOptions || !shortMarketList) return;
  const cards = Array.from(shortMarketList.querySelectorAll(".btc5m-card"));
  const activeCards = cards.filter(card => {
    const timerText = card.querySelector(".short-market-timer")?.textContent || "";
    return !timerText.includes("Closed") && !timerText.includes("Won:");
  });

  if (!activeCards.length) {
    customBulkStartOptions.innerHTML = `<div style="padding:6px 8px; font-size:10px; color:var(--text-tertiary);">Tidak ada market aktif</div>`;
    return;
  }

  customBulkStartOptions.innerHTML = activeCards.map((card, idx) => {
    const title = (card.getAttribute("data-question") || card.querySelector("span")?.textContent || `Market ${idx + 1}`).trim();
    const timeText = card.querySelector(".short-market-timer")?.textContent || "";
    return `<div class="bulk-start-item" data-index="${idx}" data-title="${escapeHtml(title)}" style="padding:6px 8px; font-size:10px; cursor:pointer; color:var(--text-primary); border-bottom:1px solid rgba(255,255,255,0.03); display:flex; justify-content:space-between; align-items:center;">
      <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:130px;">${idx + 1}. ${escapeHtml(title)}</span>
      <span style="font-size:9px; color:var(--neon-green); font-weight:bold;">${escapeHtml(timeText)}</span>
    </div>`;
  }).join("");
}

window.selectBulkStartItem = function(index, title) {
  const selectBulkStart = document.querySelector("#selectBulkStart");
  const customBulkStartText = document.querySelector("#customBulkStartText");
  const customBulkStartOptions = document.querySelector("#customBulkStartOptions");
  if (selectBulkStart) selectBulkStart.value = index;
  if (customBulkStartText) customBulkStartText.textContent = `${index + 1}. ${title}`;
  if (customBulkStartOptions) customBulkStartOptions.style.display = "none";
};

document.addEventListener("DOMContentLoaded", () => {
  const btnBulkAddShort = document.querySelector("#btnBulkAddShort");
  const bulkAddDropdown = document.querySelector("#bulkAddDropdown");
  const customBulkStartDisplay = document.querySelector("#customBulkStartDisplay");
  const customBulkStartText = document.querySelector("#customBulkStartText");
  const customBulkStartOptions = document.querySelector("#customBulkStartOptions");
  const selectBulkStart = document.querySelector("#selectBulkStart");
  const inputBulkCount = document.querySelector("#inputBulkCount");
  const btnConfirmBulkAdd = document.querySelector("#btnConfirmBulkAdd");

  if (btnBulkAddShort && bulkAddDropdown) {
    btnBulkAddShort.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = bulkAddDropdown.style.display === "flex" || bulkAddDropdown.style.display === "block";
      if (!isVisible) {
        populateBulkStartOptions();
        const firstItem = customBulkStartOptions?.querySelector(".bulk-start-item");
        if (firstItem) {
          firstItem.click();
        } else {
          if (customBulkStartText) customBulkStartText.textContent = "Pilih market...";
          if (selectBulkStart) selectBulkStart.value = "0";
        }
        bulkAddDropdown.style.display = "flex";
      } else {
        bulkAddDropdown.style.display = "none";
      }
    });

    document.addEventListener("click", (e) => {
      if (bulkAddDropdown.style.display !== "none" && !bulkAddDropdown.contains(e.target) && e.target !== btnBulkAddShort && !btnBulkAddShort.contains(e.target)) {
        bulkAddDropdown.style.display = "none";
      }
    });
  }

  if (customBulkStartDisplay && customBulkStartOptions) {
    customBulkStartDisplay.addEventListener("click", (e) => {
      e.stopPropagation();
      customBulkStartOptions.style.display = customBulkStartOptions.style.display === "flex" || customBulkStartOptions.style.display === "block" ? "none" : "flex";
    });
  }

  customBulkStartOptions?.addEventListener("click", (event) => {
    const item = event.target.closest(".bulk-start-item");
    if (!item) return;
    window.selectBulkStartItem(Number(item.dataset.index), item.dataset.title || "");
  });

  if (btnConfirmBulkAdd) {
    btnConfirmBulkAdd.addEventListener("click", () => {
      if (!shortMarketList) return;
      const cards = Array.from(shortMarketList.querySelectorAll(".btc5m-card"));
      const activeCards = cards.filter(card => {
        const timerText = card.querySelector(".short-market-timer")?.textContent || "";
        return !timerText.includes("Closed") && !timerText.includes("Won:");
      });

      if (!activeCards.length) {
        showCustomAlert("Tidak ada market aktif untuk ditambahkan.");
        if (bulkAddDropdown) bulkAddDropdown.style.display = "none";
        return;
      }

      const startIndex = parseInt(selectBulkStart?.value || "0", 10) || 0;
      const countVal = inputBulkCount?.value || "all";
      const numToTake = countVal === "all" ? activeCards.length : parseInt(countVal, 10);

      const sliceToTake = activeCards.slice(startIndex, startIndex + numToTake);
      let addedCount = 0;
      sliceToTake.forEach(card => {
        window.addCardToQueue(card);
        addedCount++;
      });

      if (bulkAddDropdown) bulkAddDropdown.style.display = "none";

      if (addedCount > 0) {
        showCustomAlert(`🎯 Bulk Add: ${addedCount} market berhasil dimasukkan ke antrean!`);
      } else {
        showCustomAlert("Market yang dipilih sudah ada di antrean.");
      }
    });
  }
});

function renderShortMarkets(markets) {
  if (!shortMarketList) return;
  if (!markets || !markets.length) {
    shortMarketList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-tertiary);">No active ${activeShortAsset.toUpperCase()} markets found right now.</div>`;
    return;
  }

  const renderCard = (m) => {
    const timeToClose = new Date(m.endDate).getTime() - Date.now();

    let durationLimit = 5 * 60 * 1000;
    if (activeShortDuration === '15m') durationLimit = 15 * 60 * 1000;
    else if (activeShortDuration === '1h') durationLimit = 60 * 60 * 1000;
    else if (activeShortDuration === '4h') durationLimit = 4 * 60 * 60 * 1000;
    else if (activeShortDuration === '1d') durationLimit = 24 * 60 * 60 * 1000;

    const isFuture = timeToClose > (durationLimit + 30000);
    const isClosed = timeToClose <= 0;
    const isLockedOut = !isFuture && !isClosed && timeToClose <= 60 * 1000; // Under 1 min
    const isClosingSoon = !isFuture && !isClosed && !isLockedOut && timeToClose < 2 * 60 * 1000;

    const pYes = m.outcomePrices[0] ? Math.round(m.outcomePrices[0] * 100) : 0;
    const pNo = m.outcomePrices[1] ? Math.round(m.outcomePrices[1] * 100) : 0;

    const labelYes = m.outcomes[0] || "Up";
    const labelNo = m.outcomes[1] || "Down";

    let timeColor = isClosed ? "var(--text-tertiary)" : (isFuture ? "var(--text-tertiary)" : (isLockedOut ? "var(--neon-red)" : (isClosingSoon ? "var(--neon-amber)" : "var(--neon-green)")));
    let timeText = isClosed ? "Closed" : (isFuture ? "Wait " + Math.floor((timeToClose - durationLimit) / 60000) + "m" : Math.floor(timeToClose / 60000) + "m " + Math.floor((timeToClose % 60000) / 1000) + "s");

    if (isClosed) {
      if (pYes >= 90) {
        timeText = `Won: ${labelYes.toUpperCase()} 📈`;
        timeColor = "var(--neon-green)";
      } else if (pNo >= 90) {
        timeText = `Won: ${labelNo.toUpperCase()} 📉`;
        timeColor = "var(--neon-red)";
      } else {
        timeText = "Resolving ⏳";
        timeColor = "var(--neon-cyan)";
      }
    }

    const cardOpacity = (isFuture || isLockedOut) ? "0.5" : "1";
    const cardCursor = (isFuture || isLockedOut) ? "not-allowed" : "pointer";
    const cardBg = isFuture ? "rgba(0,0,0,0.3)" : (isLockedOut ? "rgba(220,38,38,0.1)" : "rgba(0,0,0,0.15)");
    const cardBorder = isFuture ? "rgba(255,255,255,0.02)" : (isLockedOut ? "rgba(220,38,38,0.2)" : "rgba(255,255,255,0.05)");
    const cardState = isClosed ? "closed" : isFuture ? "future" : isLockedOut ? "locked" : "active";
    const safeId = escapeHtml(m.id);
    const safeUrl = escapeHtml(sanitizeHttpUrl(m.url) || "");
    const safeQuestion = escapeHtml(m.question || "");
    const safeTitle = escapeHtml((m.groupItemTitle || m.question || "").trim());
    const safeEndDate = escapeHtml(m.endDate || "");
    const safeDuration = escapeHtml(m.duration_type || activeShortDuration || "5m");
    const safeLabelYes = escapeHtml(labelYes);
    const safeLabelNo = escapeHtml(labelNo);

    const isSnipeBtn = isFuture;
    const btnClass = isSnipeBtn ? "btn-snipe-market" : "btn-add-to-queue";
    const btnDisplay = isSnipeBtn ? "flex" : "none";
    const btnIcon = isSnipeBtn ? "crosshair" : "plus";
    const btnTitle = isSnipeBtn ? "Snipe Market (Auto-Analyze when active)" : "Add to Queue";
    const btnColor = isSnipeBtn ? "var(--neon-amber)" : "var(--text-secondary)";

    const addBtnHtml = !isClosed ? `<button class="${btnClass}" data-short-action="add" style="display:${btnDisplay}; height:20px; width:20px; padding:0; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.05); color:${btnColor}; cursor:pointer; align-items:center; justify-content:center; margin-left:8px; flex-shrink:0; transition:all 0.2s;" title="${btnTitle}"><i data-lucide="${btnIcon}" style="width:12px; height:12px;"></i></button>` : '';

    return `
      <div class="btc5m-card" draggable="${!isClosed && !isLockedOut}" data-card-state="${cardState}" data-id="${safeId}" data-url="${safeUrl}" data-question="${safeQuestion}" data-end-date="${safeEndDate}" data-duration-type="${safeDuration}" style="padding:8px 10px; border:1px solid ${cardBorder}; border-radius:4px; background:${cardBg}; opacity:${cardOpacity}; cursor:${cardCursor}; transition:all 0.2s;">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px; align-items:flex-start;">
          <span style="font-weight:600; color:var(--text-primary); font-size:11px; flex:1; min-width:0; word-wrap:break-word;">${safeTitle}</span>
          <div style="display:flex; align-items:center;">
            <span class="short-market-timer" data-end-date="${safeEndDate}" data-p-yes="${pYes}" data-p-no="${pNo}" data-l-yes="${safeLabelYes}" data-l-no="${safeLabelNo}" data-is-future="${isFuture}" style="color:${timeColor}; font-weight:700; font-size:10px; white-space:nowrap; flex-shrink:0; text-align:right; margin-left:8px;">${escapeHtml(timeText)}</span>
            ${addBtnHtml}
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; gap:8px;">
            <span style="color:var(--neon-green); font-size:10px;">${safeLabelYes}: ${pYes}c</span>
            <span style="color:var(--neon-red); font-size:10px;">${safeLabelNo}: ${pNo}c</span>
          </div>
        </div>
      </div>
    `;
  };

  let targetMarkets = markets.filter(m => m.duration_type === activeShortDuration);

  // Fallback if the active duration is '5m' but the market doesn't have duration_type explicit
  if (activeShortDuration === '5m' && targetMarkets.length === 0) {
     targetMarkets = markets.filter(m => m.duration_type === '5m' || !m.duration_type);
  }

  let html = "";

  if (targetMarkets.length) {
    html += targetMarkets.map(renderCard).join("");
  } else {
    html = `<div style="text-align:center; padding:20px; color:var(--text-tertiary);">No active ${activeShortAsset.toUpperCase()} ${activeShortDuration} markets right now.</div>`;
  }

  shortMarketList.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons({ root: shortMarketList });
}

shortMarketList?.addEventListener("click", (event) => {
  const card = event.target.closest(".btc5m-card");
  if (!card) return;

  const addButton = event.target.closest('[data-short-action="add"]');
  if (addButton) {
    event.stopPropagation();
    window.addCardToQueue(card);
    if (addButton.classList.contains("btn-snipe-market")) {
      addButton.innerHTML = '<i data-lucide="loader" style="width:12px; height:12px; animation:spin 2s linear infinite;"></i>';
      addButton.style.pointerEvents = "none";
      addButton.style.color = "var(--neon-green)";
      addButton.style.borderColor = "rgba(16,185,129,0.5)";
      if (typeof lucide !== "undefined") lucide.createIcons({ root: addButton });
      showCustomAlert("Market dimasukkan ke antrean Sniper.");
    }
    return;
  }

  const messages = {
    closed: "Event sudah ditutup dan tidak dapat dianalisis lagi.",
    future: "Market belum aktif. Tambahkan ke antrean Sniper untuk dianalisis otomatis nanti.",
    locked: "Waktu tersisa kurang dari 1 menit. Market dikunci karena risikonya terlalu tinggi.",
  };
  if (messages[card.dataset.cardState]) {
    showCustomAlert(messages[card.dataset.cardState]);
    return;
  }
  window.analyzeShortMarket(card.dataset.id, card.dataset.url);
});

shortMarketList?.addEventListener("dragstart", (event) => {
  const card = event.target.closest('.btc5m-card[draggable="true"]');
  if (card) window.handleDragStart(event, card);
});

shortMarketList?.addEventListener("dragend", (event) => {
  const card = event.target.closest(".btc5m-card");
  if (card) card.style.opacity = card.dataset.cardState === "future" ? "0.5" : "1";
});

function startShortRealtimeTimer() {
  if (shortMarketRealtimeInterval) clearInterval(shortMarketRealtimeInterval);
  shortMarketRealtimeInterval = setInterval(() => {
    document.querySelectorAll(".short-market-timer").forEach(el => {
      const endDate = el.getAttribute("data-end-date");
      if (!endDate) return;

      const timeToClose = new Date(endDate).getTime() - Date.now();

      let durationLimit = 5 * 60 * 1000;
      if (activeShortDuration === '15m') durationLimit = 15 * 60 * 1000;
      else if (activeShortDuration === '1h') durationLimit = 60 * 60 * 1000;
      else if (activeShortDuration === '4h') durationLimit = 4 * 60 * 60 * 1000;
      else if (activeShortDuration === '1d') durationLimit = 24 * 60 * 60 * 1000;

      const isFuture = timeToClose > (durationLimit + 30000);
      const isClosingSoon = timeToClose > 0 && timeToClose < 2 * 60 * 1000 && !isFuture;
      const isClosed = timeToClose <= 0;

      let timeColor = isClosed ? "var(--text-tertiary)" : (isFuture ? "var(--text-tertiary)" : (isClosingSoon ? "var(--neon-amber)" : "var(--neon-green)"));
      let timeText = isClosed ? "Closed" : (isFuture ? "Wait " + Math.floor((timeToClose - durationLimit) / 60000) + "m" : Math.floor(timeToClose / 60000) + "m " + Math.floor((timeToClose % 60000) / 1000) + "s");

      if (isClosed) {
        const pYes = parseInt(el.getAttribute("data-p-yes")) || 0;
        const pNo = parseInt(el.getAttribute("data-p-no")) || 0;
        const lYes = el.getAttribute("data-l-yes") || "UP";
        const lNo = el.getAttribute("data-l-no") || "DOWN";

        if (pYes >= 90) {
          timeText = `Won: ${lYes.toUpperCase()} 📈`;
          timeColor = "var(--neon-green)";
        } else if (pNo >= 90) {
          timeText = `Won: ${lNo.toUpperCase()} 📉`;
          timeColor = "var(--neon-red)";
        } else {
          timeText = "Resolving ⏳";
          timeColor = "var(--neon-cyan)";
        }
      }

      const prevIsFuture = el.getAttribute("data-is-future") === "true";
      if (prevIsFuture !== isFuture && currentShortMarkets && currentShortMarkets.length > 0) {
        // State has changed from future to active!
        // We must re-render so that buttons and click handlers are updated.
        renderShortMarkets(currentShortMarkets);
        return; // Break out of this interval tick since we just re-rendered the whole list
      }

      el.style.color = timeColor;
      el.textContent = timeText;
    });
  }, 1000);
}

function stopShortRealtimeTimer() {
  if (shortMarketRealtimeInterval) {
    clearInterval(shortMarketRealtimeInterval);
    shortMarketRealtimeInterval = null;
  }
}

window.analyzeShortMarket = function(marketId, url) {
  if (busy) {
    showCustomAlert("⚠️ Analisis sedang berjalan. Mohon tunggu sampai selesai, atau masukkan ke antrean (Queue).");
    return;
  }
  executeCommand(`/shortanalyze ${url || marketId}`);
};

const SNIPER_CONFIG_VERSION = 3;

function defaultSniperConfig() {
  return {
    version: SNIPER_CONFIG_VERSION,
    m5: {
      scanStartSeconds: DEFAULT_ENTRY_SCANNER_CONFIG.scanStartSeconds,
      scanStopSeconds: DEFAULT_ENTRY_SCANNER_CONFIG.scanStopSeconds,
      minFairProbability: DEFAULT_ENTRY_SCANNER_CONFIG.minFairProbability,
      minNetEvCents: DEFAULT_ENTRY_SCANNER_CONFIG.minNetEvCents,
      maxAsk: DEFAULT_ENTRY_SCANNER_CONFIG.maxAsk,
      confirmations: DEFAULT_ENTRY_SCANNER_CONFIG.confirmations,
    },
    m15: { min: 6, sec: 0 },
    h1: { min: 24, sec: 0 },
    h4: { hour: 1, min: 36 },
    d1: { hour: 9, min: 36 },
  };
}

function sniperInputNumber(id, fallback) {
  const value = Number.parseInt(document.querySelector(`#${id}`)?.value, 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function sniperInputDecimal(id, fallback) {
  const value = Number.parseFloat(document.querySelector(`#${id}`)?.value);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function currentEntryScannerConfig() {
  return {
    ...DEFAULT_ENTRY_SCANNER_CONFIG,
    minFairProbability: Math.min(90, Math.max(60, sniperInputDecimal('set5mMinFair', 60))),
    minNetEvCents: Math.min(30, Math.max(8, sniperInputDecimal('set5mMinEv', 8))),
    maxAsk: Math.min(0.65, Math.max(0.4, sniperInputDecimal('set5mMaxAsk', 0.65))),
    confirmations: Math.min(4, Math.max(2, sniperInputNumber('set5mConfirmations', 2))),
  };
}

function sniperTriggerSeconds(durationType) {
  if (durationType === '15m') return sniperInputNumber('set15mMin', 6) * 60 + sniperInputNumber('set15mSec', 0);
  if (durationType === '1h') return sniperInputNumber('set1hMin', 24) * 60 + sniperInputNumber('set1hSec', 0);
  if (durationType === '4h') return sniperInputNumber('set4hHour', 1) * 3600 + sniperInputNumber('set4hMin', 36) * 60;
  if (durationType === '1d') return sniperInputNumber('set1dHour', 9) * 3600 + sniperInputNumber('set1dMin', 36) * 60;
  return sniperInputNumber('set5mScanStart', 4) * 60;
}

function formatSniperCountdown(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

/* --- Queue Panel Logic --- */
const btnToggleQueue = document.querySelector("#btnToggleQueue");
const queuePanel = document.querySelector("#queuePanel");
const btnClearQueue = document.querySelector("#btnClearQueue");
const btnCloseQueue = document.querySelector("#btnCloseQueue");
const btnRunQueue = document.querySelector("#btnRunQueue");
const queueDropzone = document.querySelector("#queueDropzone");
const queueEmpty = document.querySelector("#queueEmpty");

let analysisQueue = [];
let isSniperActive = false;
let sniperInterval = null;

if (btnToggleQueue && queuePanel) {
  document.body.appendChild(queuePanel); // Escape stacking context
  btnToggleQueue.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = queuePanel.style.display === "none";
    if (isHidden) {
      // Jika belum punya left inline (belum pernah didrag), posisikan relatif ke layar
      if (!queuePanel.style.left || queuePanel.style.left === "") {
        const rect = btnToggleQueue.getBoundingClientRect();
        queuePanel.style.top = (rect.bottom + 8) + "px";
        queuePanel.style.right = (window.innerWidth - rect.right) + "px";
      }
      queuePanel.style.display = "flex";
      document.body.classList.add("queue-open");
    } else {
      queuePanel.style.display = "none";
      document.body.classList.remove("queue-open");
    }
  });
}

if (btnCloseQueue && queuePanel) {
  btnCloseQueue.addEventListener("click", () => {
    if (isSniperActive) {
      showCustomAlert("Tidak bisa menutup antrian saat Sniper sedang berjalan.");
      return;
    }
    queuePanel.style.display = "none";
    document.body.classList.remove("queue-open");
  });
}

// Minimize Panel
const btnMinimizeQueue = document.querySelector("#btnMinimizeQueue");
const queuePanelContent = document.querySelector("#queuePanelContent");
const queueProgressText = document.querySelector("#queueProgressText");
const queueResizeHandleSW = document.querySelector("#queueResizeHandleSW");

if (btnMinimizeQueue && queuePanelContent) {
  btnMinimizeQueue.addEventListener("click", () => {
    const isMinimized = queuePanelContent.style.display === "none";
    if (isMinimized) {
      queuePanelContent.style.display = "flex";
      queuePanel.style.height = queuePanel.dataset.lastHeight || "400px";
      queuePanel.style.minHeight = queuePanel.dataset.lastMinHeight || "200px";
      btnMinimizeQueue.innerHTML = '<i data-lucide="minus" style="width:14px; height:14px;"></i>';
      if (queueProgressText) queueProgressText.style.display = "none";
      if (queueResizeHandleSW) queueResizeHandleSW.style.display = "block";
    } else {
      queuePanel.dataset.lastHeight = queuePanel.style.height || "400px";
      queuePanel.dataset.lastMinHeight = queuePanel.style.minHeight || "200px";
      queuePanelContent.style.display = "none";
      queuePanel.style.height = "auto";
      queuePanel.style.minHeight = "0";
      btnMinimizeQueue.innerHTML = '<i data-lucide="maximize-2" style="width:14px; height:14px;"></i>';
      if (isSniperActive && queueProgressText) queueProgressText.style.display = "inline";
      if (queueResizeHandleSW) queueResizeHandleSW.style.display = "none";
    }
    lucide.createIcons();
  });
}

// Draggable Panel
const queuePanelHeader = document.querySelector("#queuePanelHeader");
if (queuePanel && queuePanelHeader) {
  let isDragging = false;
  let offsetX, offsetY;

  queuePanelHeader.addEventListener("mousedown", (e) => {
    // Stop dragging if clicking interactive control elements inside header (e.g. trash icon, buttons)
    if (e.target.closest("button, input, select, a, [role='button']")) return;
    
    // A docked queue does not use free-drag offsets.
    if (queuePanel.closest("#queueRail")) {
      queuePanel.style.left = "";
      queuePanel.style.top = "";
      queuePanel.style.right = "";
      return;
    }

    isDragging = true;
    offsetX = e.clientX - queuePanel.getBoundingClientRect().left;
    offsetY = e.clientY - queuePanel.getBoundingClientRect().top;
    queuePanelHeader.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    if (queuePanel.closest("#queueRail")) {
      isDragging = false;
      queuePanel.style.left = "";
      queuePanel.style.top = "";
      queuePanel.style.right = "";
      return;
    }
    
    let parentLeft = 0;
    let parentTop = 0;
    if (queuePanel.offsetParent) {
      const parentRect = queuePanel.offsetParent.getBoundingClientRect();
      parentLeft = parentRect.left;
      parentTop = parentRect.top;
    }

    const calculatedLeft = e.clientX - parentLeft - offsetX;
    const calculatedTop = e.clientY - parentTop - offsetY;
    queuePanel.style.left = `${Math.max(0, calculatedLeft)}px`;
    queuePanel.style.top = `${Math.max(0, calculatedTop)}px`;
    queuePanel.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      queuePanelHeader.style.cursor = "grab";
      document.body.style.userSelect = "";
    }
  });
}


// Resizable Panel (Bottom-Left)

if (queuePanel && queueResizeHandleSW) {
  let isResizing = false;
  let startX, startY, startWidth, startHeight, startLeft;

  queueResizeHandleSW.addEventListener("mousedown", (e) => {
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    
    const rect = queuePanel.getBoundingClientRect();
    startWidth = rect.width;
    startHeight = rect.height;
    
    if (queuePanel.style.left && queuePanel.style.left !== "auto") {
      startLeft = parseFloat(queuePanel.style.left) || 0;
    }

    document.body.style.cursor = "sw-resize";
    document.body.style.userSelect = "none";
    e.stopPropagation();
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    let newWidth = startWidth - dx;
    let newHeight = startHeight + dy;
    
    if (newWidth < 300) newWidth = 300;
    if (newWidth > 800) newWidth = 800;
    
    if (newHeight >= 200) {
      queuePanel.style.height = `${newHeight}px`;
    }
    
    if (queuePanel.style.left && queuePanel.style.left !== "auto") {
      const actualDx = startWidth - newWidth;
      queuePanel.style.width = `${newWidth}px`;
      queuePanel.style.left = `${startLeft + actualDx}px`;
    } else {
      queuePanel.style.width = `${newWidth}px`;
    }
  });

  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = "default";
      document.body.style.userSelect = "";
    }
  });
}

if (queueDropzone) {
  queueDropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    queueDropzone.style.borderColor = "var(--neon-green)";
  });

  queueDropzone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    queueDropzone.style.borderColor = "transparent";
  });

  queueDropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    queueDropzone.style.borderColor = "transparent";
    try {
      const data = JSON.parse(event.dataTransfer.getData("text/plain"));
      if (data && data.id) addToQueue(data);
    } catch (e) {
      console.error("Invalid drop data");
    }
  });
}

function addToQueue(marketData) {
  if (analysisQueue.some(m => m.id === marketData.id)) return;
  if (analysisQueue.length >= 50) {
    showCustomAlert("Antrian maksimal 50 market.");
    return;
  }
  
  analysisQueue.push(marketData);
  renderQueue();
}

window.addToQueue = addToQueue;

function hasScannerNumber(value) {
  return value != null && value !== "" && Number.isFinite(Number(value));
}

function formatScannerPrice(value) {
  return hasScannerNumber(value) ? `$${Number(value).toFixed(2)}` : "-";
}

function formatScannerPercent(value) {
  return hasScannerNumber(value) ? `${Number(value).toFixed(1)}%` : "-";
}

function formatScannerCents(value) {
  if (!hasScannerNumber(value)) return "-";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}c`;
}

function scannerGateMessages(result) {
  const messages = (result?.failedGates || [])
    .map(failure => failure?.message)
    .filter(Boolean);
  if (messages.length === 0 && result?.reason) messages.push(result.reason);
  return messages;
}

function scannerObservationText(result) {
  const observed = result?.outcome === "ENTRY" ? result.issuedSignal || result.bestObserved : result?.bestObserved;
  if (!observed) return "No complete observation";
  return `${observed.direction} | Fair ${formatScannerPercent(observed.fairProbability)} | Ask ${formatScannerPrice(observed.ask)} | Gross EV ${formatScannerCents(observed.grossEvCents)} | Net EV ${formatScannerCents(observed.netEvCents)}`;
}

function scannerDirectionLabel(direction) {
  return direction === "UP" || direction === "DOWN" ? direction : "NO SIGNAL";
}

function scannerOutcomeLabel(outcome) {
  return {
    ENTRY: "Experimental Candidate",
    NO_ENTRY: "Not selected",
    NO_CHASE: "Candidate withdrawn",
    INCOMPLETE: "Awaiting observation",
  }[outcome] || "Experimental Candidate";
}

function scannerStatusLabel(status, direction) {
  if (status === "candidate" || status === "entry") {
    return `Experimental Candidate${direction ? ` · ${direction}` : ""}`;
  }
  if (status === "no_chase") return "Candidate withdrawn";
  if (status === "skipped") return "Not selected";
  return status === "waiting" ? "Waiting" : "Watching";
}

function historyPredictionLabel(prediction) {
  const value = String(prediction || "").trim().toUpperCase();
  return ["=", "SKIP", "NETRAL", "NEUTRAL", "WATCHLIST"].includes(value) ? "NO SIGNAL" : value || "-";
}

function historyResultLabel(result) {
  const value = String(result || "").trim().toUpperCase();
  return ["NETRAL", "NEUTRAL"].includes(value) ? "Not selected" : value || "-";
}

function scannerResultReportLines(item, result) {
  const gates = scannerGateMessages(result);
  return [
    `- ${item.groupItemTitle || item.question || item.id || "Unknown market"}`,
    `  Outcome: ${scannerOutcomeLabel(result.outcome || "INCOMPLETE")}`,
    `  Diagnostic lean: ${scannerDirectionLabel(result.diagnosticLean)}`,
    `  Experimental candidates / best observed: ${scannerObservationText(result)}`,
    `  Confirmations: ${result.maxConfirmationCount}/${result.requiredConfirmations}`,
    `  Data: ${result.dataStatus}`,
    `  Gates: ${gates.length ? gates.join(" | ") : "None"}`,
  ];
}

function scannerOutcomeClass(outcome) {
  if (outcome === "ENTRY") return "is-entry";
  if (outcome === "NO_CHASE") return "is-no-chase";
  return "is-no-entry";
}

function buildDynamicScannerResultHtml(item) {
  const result = normalizeEntryScannerResult(item?.entryScanner);
  const observed = result.bestObserved;
  const gates = scannerGateMessages(result);
  const question = escapeHtml(item?.groupItemTitle || item?.question || item?.id || "Unknown market");
  const outcome = escapeHtml(scannerOutcomeLabel(result.outcome || "INCOMPLETE"));
  const lean = escapeHtml(scannerDirectionLabel(result.diagnosticLean));
  const observedDirection = escapeHtml(observed?.direction || "-");
  const dataStatus = escapeHtml(result.dataStatus);
  const timingPhase = escapeHtml(result?.timingPhase || "SWEET_SPOT");
  const asymmetricEdge = formatScannerCents(observed?.grossEvCents);
  const gateHtml = gates.length
    ? gates.map(message => `<li>${escapeHtml(message)}</li>`).join("")
    : "<li>None</li>";

  return `
    <article class="dynamic-ev-result ${scannerOutcomeClass(result.outcome)}">
      <div class="dynamic-ev-result-head">
        <div>
          <span class="dynamic-ev-kicker">DETERMINISTIC DYNAMIC EV</span>
          <h3>${question}</h3>
        </div>
        <span class="dynamic-ev-outcome">${outcome}</span>
      </div>
      <div class="dynamic-ev-grid">
        <div><span>Diagnostic Lean</span><strong>${lean}</strong></div>
        <div><span>Best Observed</span><strong>${observedDirection}</strong></div>
        <div><span>Fair</span><strong>${formatScannerPercent(observed?.fairProbability)}</strong></div>
        <div><span>Ask</span><strong>${formatScannerPrice(observed?.ask)}</strong></div>
        <div><span>Asymmetric Edge</span><strong style="color:var(--neon-green);">${asymmetricEdge}</strong></div>
        <div><span>Net EV</span><strong>${formatScannerCents(observed?.netEvCents)}</strong></div>
        <div><span>Timing Window</span><strong style="color:var(--neon-cyan);">${timingPhase}</strong></div>
        <div><span>Data</span><strong>${dataStatus}</strong></div>
      </div>
      <div class="dynamic-ev-gates"><span>Exact Gates</span><ul>${gateHtml}</ul></div>
      <div class="dynamic-ev-manual">${result.outcome === "ENTRY" ? "Experimental review only" : "Not selected"}</div>
    </article>`;
}

function populateStaticScannerContent(html) {
  const panel = document.getElementById("staticResultPanel");
  const content = document.getElementById("staticResultContent");
  if (!panel || !content) return;
  marketSummaryClosed = false;
  panel.classList.remove("hidden");
  content.style.overflowY = "auto";
  content.innerHTML = html;
}

function showDynamicScannerResult(item) {
  populateStaticScannerContent(`
    <div class="dynamic-ev-static-head">
      <span>Dynamic EV Result</span>
      <button type="button" data-static-action="close" aria-label="Close Dynamic EV result"><i data-lucide="x"></i></button>
    </div>
    ${buildDynamicScannerResultHtml(item)}`);
  const content = document.getElementById("staticResultContent");
  if (window.lucide && content) window.lucide.createIcons({ root: content });
}

function showDynamicScannerSessionSummary() {
  const summary = summarizeEntryScannerSession(analysisQueue);
  const completedItems = analysisQueue.filter(item => normalizeEntryScannerResult(item?.entryScanner).completed);
  populateStaticScannerContent(`
    <div class="dynamic-ev-static-head">
      <span>Dynamic EV Session Summary</span>
      <button type="button" data-static-action="close" aria-label="Close Dynamic EV session summary"><i data-lucide="x"></i></button>
    </div>
    <div class="dynamic-ev-summary-counts">
      <div><span>Completed</span><strong>${summary.completed}</strong></div>
      <div><span>Entries Issued</span><strong>${summary.entries}</strong></div>
      <div><span>No Entry</span><strong>${summary.noEntry}</strong></div>
      <div><span>No Chase</span><strong>${summary.noChase}</strong></div>
      <div><span>Lean Up</span><strong>${summary.up}</strong></div>
      <div><span>Lean Down</span><strong>${summary.down}</strong></div>
    </div>
    <div class="dynamic-ev-session-results">${completedItems.map(buildDynamicScannerResultHtml).join("")}</div>`);
  const content = document.getElementById("staticResultContent");
  if (window.lucide && content) window.lucide.createIcons({ root: content });
}

function showDynamicScannerTransition(item, previousStatus) {
  const result = normalizeEntryScannerResult(item?.entryScanner);
  if (result.completed && item.entryScanner?.status !== previousStatus) renderEVPanel();
}

function renderEVPanel() {
  const panel = document.getElementById("dynamicEVPanel");
  const statusEl = document.getElementById("evStatus");
  const grid = document.getElementById("evGrid");
  if (!panel || !statusEl || !grid) return;

  if (!isSniperActive) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "block";

  const dynamicItems = analysisQueue.filter(isDynamicEntryItem);
  const newest = selectNewestEntryScannerItem(dynamicItems);

  if (!newest) {
    statusEl.textContent = "WATCHING";
    statusEl.className = "ev-scan-status watching";
    grid.innerHTML = '<span style="color:var(--text-tertiary)">Waiting for market in scan window...</span>';
    return;
  }

  const result = normalizeEntryScannerResult(newest.entryScanner);
  const observed = result.bestObserved;
  const phase = result.timingPhase || "UNKNOWN";
  const statusMap = {
    entry: ["Experimental Candidate", "entry"],
    no_chase: ["Candidate withdrawn", "no_chase"],
    skipped: ["Not selected", "no_entry"],
  };
  const entryStatus = newest.entryScanner?.status;
  const [label, cls] = statusMap[entryStatus] || ["WATCHING", "watching"];
  statusEl.textContent = `${label} · ${phase}`;
  statusEl.className = `ev-scan-status ${cls}`;

  const gates = scannerGateMessages(result);
  grid.innerHTML = `
    <div><span>Direction</span><strong>${escapeHtml(observed?.direction || result.diagnosticLean || "-")}</strong></div>
    <div><span>Fair</span><strong>${formatScannerPercent(observed?.fairProbability)}</strong></div>
    <div><span>Ask</span><strong>${formatScannerPrice(observed?.ask)}</strong></div>
    <div><span>Edge</span><strong>${formatScannerCents(observed?.grossEvCents)}</strong></div>
    <div><span>Net EV</span><strong>${formatScannerCents(observed?.netEvCents)}</strong></div>
    <div><span>Phase</span><strong style="color:var(--neon-cyan)">${escapeHtml(phase)}</strong></div>
    <div><span>Data</span><strong>${escapeHtml(result.dataStatus)}</strong></div>
    <div><span>Conf</span><strong>${result.maxConfirmationCount}/${result.requiredConfirmations}</strong></div>
    ${gates.length ? `<div style="grid-column:1/-1"><span>Failed Gates</span><strong style="color:var(--neon-red);font-size:9px;font-weight:600">${escapeHtml(gates.join(" · "))}</strong></div>` : ""}`;
}

function getMarketEndDate(m) {
  const dateVal = m.endDate || m.end_date_iso || m.endDateIso || m.end_date;
  if (dateVal) {
    const t = new Date(dateVal).getTime();
    if (!isNaN(t)) return t;
  }
  const text = (m.question || m.title || "").toString();
  const match = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (match) {
    let endHour = parseInt(match[4], 10);
    const endMin = parseInt(match[5], 10);
    const ampm = (match[6] || match[3] || "").toUpperCase();
    if (ampm === "PM" && endHour < 12) endHour += 12;
    if (ampm === "AM" && endHour === 12) endHour = 0;
    
    const now = new Date();
    const endUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endHour, endMin, 0));
    
    let diffMs = endUtc.getTime() - now.getTime();
    if (diffMs < -12 * 3600 * 1000) {
      endUtc.setUTCDate(endUtc.getUTCDate() + 1);
    } else if (diffMs > 12 * 3600 * 1000) {
      endUtc.setUTCDate(endUtc.getUTCDate() - 1);
    }
    return endUtc.getTime();
  }
  return null;
}

function renderQueue() {
  if (!queueDropzone || !queueEmpty) return;

  if (btnRunQueue) {
    btnRunQueue.disabled = analysisQueue.length === 0;
    btnRunQueue.setAttribute("aria-disabled", String(btnRunQueue.disabled));
  }

  renderEntrySignalPanel();
  renderEVPanel();
  const completed = analysisQueue.filter(m => isDynamicEntryItem(m)
    ? normalizeEntryScannerResult(m.entryScanner).completed
    : m.analysisCompleted || m.isFailed || m.isTooLate).length;
  const queueProgressText = document.querySelector("#queueProgressText");
  const queuePanelContent = document.querySelector("#queuePanelContent");
  
  if (queueProgressText) {
    if (analysisQueue.length > 0 && isSniperActive) {
      queueProgressText.textContent = `(${completed}/${analysisQueue.length} Selesai)`;
    } else {
      queueProgressText.textContent = "";
    }
    
    if (isSniperActive && queuePanelContent && queuePanelContent.style.display === "none") {
      queueProgressText.style.display = "inline";
    } else {
      queueProgressText.style.display = "none";
    }
  }

  if (analysisQueue.length === 0) {
    queueDropzone.innerHTML = "";
    queueDropzone.appendChild(queueEmpty);
    queueEmpty.style.display = "block";
    return;
  }

  queueEmpty.style.display = "none";
  let html = "";
  analysisQueue.forEach((m, index) => {
    const targetSec = sniperTriggerSeconds(m.duration_type);
    const targetLabel = formatSniperCountdown(targetSec);
    const firedLabel = Number.isFinite(m.snipeFiredAtRemainingSeconds)
      ? formatSniperCountdown(m.snipeFiredAtRemainingSeconds)
      : null;
    
    let timeToCloseMs = 0;
    let timeToCloseSec = 0;
    let timeHtml = "";
    const endMs = getMarketEndDate(m);
    if (endMs) {
      timeToCloseMs = endMs - Date.now();
      timeToCloseSec = Math.max(0, Math.floor(timeToCloseMs / 1000));
      const isClosingSoon = timeToCloseMs > 0 && timeToCloseMs < 2 * 60 * 1000;
      const isClosed = timeToCloseMs <= 0;
      let timeColor = isClosed ? "var(--text-tertiary)" : (isClosingSoon ? "var(--neon-amber)" : "var(--neon-green)");
      let timeText = isClosed ? "Closed" : formatSniperCountdown(timeToCloseSec);
      
      const pYes = m.outcomePrices && m.outcomePrices[0] ? Math.round(m.outcomePrices[0] * 100) : 0;
      const pNo = m.outcomePrices && m.outcomePrices[1] ? Math.round(m.outcomePrices[1] * 100) : 0;
      const lYes = m.outcomes && m.outcomes[0] ? m.outcomes[0] : "UP";
      const lNo = m.outcomes && m.outcomes[1] ? m.outcomes[1] : "DOWN";

      timeHtml = `<span class="btc5m-timer" data-end-date="${escapeHtml(m.endDate || new Date(endMs).toISOString())}" data-p-yes="${pYes}" data-p-no="${pNo}" data-l-yes="${escapeHtml(lYes)}" data-l-no="${escapeHtml(lNo)}" style="color:${timeColor}; font-weight:bold; font-size:9px; margin-left:8px; flex-shrink:0;">${timeText}</span>`;
    }

    let sniperStatus = "";
    let evMetrics = "";
    let dynamicDetails = "";
    if (isDynamicEntryItem(m)) {
      const state = m.entryScanner || { status: "waiting", confirmationCount: 0, requiredConfirmations: currentEntryScannerConfig().confirmations };
      const result = normalizeEntryScannerResult(state);
      const statusStyles = {
        waiting: [isSniperActive ? "WAITING 05→02:30" : "WINDOW 05→02:30", "var(--text-tertiary)"],
        watching: [state.degraded ? "WATCH DEGRADED" : "WATCHING", "var(--neon-cyan)"],
        candidate: [scannerStatusLabel("candidate", state.candidateDirection), "var(--neon-amber)"],
        entry: [scannerStatusLabel("entry", state.signal?.direction), "var(--neon-green)"],
        no_chase: [scannerStatusLabel("no_chase"), "var(--neon-red)"],
        skipped: [scannerStatusLabel("skipped"), "var(--text-tertiary)"],
      };
      const [label, color] = statusStyles[state.status] || statusStyles.waiting;
      sniperStatus = `<span title="${escapeHtml(result.reason || label)}" style="color:${color}; font-size:9px; border:1px solid ${color}; border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; font-weight:700;">${escapeHtml(label)}</span>`;
      evMetrics = `<span class="dynamic-queue-lean">DIAGNOSTIC ${escapeHtml(scannerDirectionLabel(result.diagnosticLean))}</span>`;
      const observed = result.bestObserved;
      const gateMessages = scannerGateMessages(result);
      dynamicDetails = `
        <div class="dynamic-queue-details">
          <span>BEST ${escapeHtml(observed?.direction || "-")}</span>
          <span>FAIR ${formatScannerPercent(observed?.fairProbability)}</span>
          <span>ASK ${formatScannerPrice(observed?.ask)}</span>
          <span>GROSS ${formatScannerCents(observed?.grossEvCents)}</span>
          <span>NET ${formatScannerCents(observed?.netEvCents)}</span>
          <span>CONF ${result.maxConfirmationCount}/${result.requiredConfirmations}</span>
          <span>DATA ${escapeHtml(result.dataStatus)}</span>
        </div>
        ${gateMessages.length ? `<div class="dynamic-queue-gates"><b>FAILED GATES</b>${gateMessages.map(message => `<span>${escapeHtml(message)}</span>`).join("")}</div>` : ""}`;
    } else if (m.isFailed) {
      sniperStatus = `<span title="Analisis Gagal" style="color:var(--neon-red); font-size:9px; border:1px solid var(--neon-red); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="alert-triangle" style="width:8px; height:8px; margin-right:4px;"></i> Failed</span>`;
    } else if (m.isTooLate) {
      sniperStatus = `<span title="Terlewat (Sisa <= 30 detik)" style="color:var(--neon-red); font-size:9px; border:1px solid var(--neon-red); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="x-circle" style="width:8px; height:8px; margin-right:4px;"></i> Skipped${firedLabel ? ` @ ${firedLabel}` : ''}</span>`;
    } else if (m.analysisCompleted) {
      sniperStatus = `<span title="Analisis selesai" style="color:var(--neon-green); font-size:9px; border:1px solid var(--neon-green); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">Done</span>`;
    } else if (m.isAnalyzing) {
      sniperStatus = `<span title="Sedang dianalisis" style="color:var(--neon-cyan); font-size:9px; border:1px solid var(--neon-cyan); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">Analyzing</span>`;
    } else if (!m.snipeFired) {
      const targetColor = isSniperActive ? 'var(--neon-amber)' : 'var(--text-tertiary)';
      const secToTrigger = (timeToCloseSec > targetSec) ? (timeToCloseSec - targetSec) : 0;
      let targetText = `Target ${targetLabel}`;
      if (secToTrigger > 0) {
        targetText += ` (${formatSniperCountdown(secToTrigger)})`;
      } else if (timeToCloseSec > 0 && timeToCloseSec <= targetSec) {
        targetText += ` (Ready)`;
      }
      sniperStatus = `<span title="Sniper akan menganalisis saat hitung mundur ${targetLabel}" style="color:${targetColor}; font-size:9px; border:1px solid ${targetColor}; border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">${escapeHtml(targetText)}</span>`;
    } else {
      if (m.isLateFired) {
        sniperStatus = `<span title="Target ${targetLabel}; menunggu giliran setelah terlambat" style="color:var(--neon-cyan); font-size:9px; border:1px solid var(--neon-cyan); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="clock-4" style="width:8px; height:8px; margin-right:4px;"></i> Queued${firedLabel ? ` @ ${firedLabel}` : ''}</span>`;
      } else {
        sniperStatus = `<span title="Menunggu giliran analisis" style="color:var(--text-tertiary); font-size:9px; border:1px solid var(--border-bright); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">Queued${firedLabel ? ` @ ${firedLabel}` : ''}</span>`;
      }
    }

    // Ambil hasil dari history jika ada
    const historyItem = allHistoryEvents ? allHistoryEvents.find(e => e.market_id === m.id) : null;
    let predictionBadge = "";
    let resultBadge = "";
    if (!isDynamicEntryItem(m) && historyItem) {
      if (historyItem.prediction) {
        const p = historyItem.prediction.toUpperCase();
        const pColor = (p === 'UP' || p === 'YES') ? 'var(--neon-green)' : ((p === 'DOWN' || p === 'NO') ? 'var(--neon-red)' : 'var(--text-tertiary)');
        predictionBadge = `<span title="Prediksi AI" style="color:${pColor}; font-weight:bold; font-size:9px; border:1px solid ${pColor}; border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="bot" style="width:10px; height:10px; margin-right:4px;"></i> ${historyPredictionLabel(p)}</span>`;
      }
      if (historyItem.result && historyItem.result !== 'menunggu hasil') {
        const r = historyItem.result.toUpperCase();
        const rColor = (r === 'MENANG') ? 'var(--neon-green)' : ((r === 'KALAH') ? 'var(--neon-red)' : ((r === 'NETRAL') ? 'var(--neon-amber)' : 'var(--text-tertiary)'));
        resultBadge = `<span title="Hasil Aktual" style="color:${rColor}; font-weight:bold; font-size:9px; border:1px solid ${rColor}; border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="flag" style="width:10px; height:10px; margin-right:4px;"></i> ${historyResultLabel(r)}</span>`;
        // Jika sudah ada hasil, timer tidak perlu muncul lagi
        timeHtml = "";
      }
    }

    const safeQuestion = escapeHtml(m.question || m.id || "Unknown market");
    html += `
      <div style="display:flex; flex-direction:column; padding:6px 8px; background:rgba(0,0,0,0.2); border:1px solid rgba(16,185,129,0.2); border-radius:4px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex:1; overflow:hidden;">
          <span style="font-size:10px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">[${index+1}] ${safeQuestion}</span>
          ${sniperStatus}
          ${evMetrics}
          ${predictionBadge}
          ${resultBadge}
          ${timeHtml}
        </div>
        <button type="button" data-queue-action="remove" data-queue-id="${escapeHtml(m.id)}" style="background:none; border:none; color:var(--neon-red); cursor:pointer; padding:2px; margin-left:8px;"><i data-lucide="x" style="width:10px; height:10px;"></i></button>
        </div>
        ${dynamicDetails}
      </div>
    `;
  });
  
  if (queueDropzone.dataset.lastHtml !== html) {
    queueDropzone.innerHTML = html;
    queueDropzone.dataset.lastHtml = html;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

window.removeFromQueue = function(id) {
  analysisQueue = analysisQueue.filter(m => String(m.id) !== String(id));
  sniperExecutionQueue = sniperExecutionQueue.filter(queuedId => queuedId !== String(id));
  renderQueue();
};

queueDropzone?.addEventListener("click", (event) => {
  const removeButton = event.target.closest('[data-queue-action="remove"]');
  if (removeButton) window.removeFromQueue(removeButton.dataset.queueId);
});

if (btnClearQueue) {
  btnClearQueue.addEventListener("click", (e) => {
    e.stopPropagation();
    analysisQueue = [];
    sniperExecutionQueue = [];
    if (isSniperActive) toggleSniper();
    renderQueue();
  });
  btnClearQueue.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });
}

// Resizer logic
const queueResizer = document.querySelector("#queueResizer");
if (queueResizer && queuePanel) {
  let isResizingQueue = false;
  
  queueResizer.addEventListener("mousedown", (e) => {
    isResizingQueue = true;
    e.preventDefault();
  });
  
  document.addEventListener("mousemove", (e) => {
    if (!isResizingQueue) return;
    const rect = queuePanel.getBoundingClientRect();
    // Lebar = posisi tepi kanan panel - posisi kursor mouse
    const newWidth = rect.right - e.clientX;
    if (newWidth > 300 && newWidth < 800) {
      queuePanel.style.width = newWidth + "px";
    }
  });
  
  document.addEventListener("mouseup", () => {
    isResizingQueue = false;
  });
}

let sniperExecutionQueue = [];
let sniperBatchInFlight = false;
let dynamicScanInFlightCount = 0;
let dynamicScanCursor = 0;
let sniperSessionId = 0;
const MAX_SNIPER_ATTEMPTS = 3;
const MAX_DYNAMIC_SCAN_CONCURRENCY = 3;

async function processSniperExecutionQueue() {
  if (sniperBatchInFlight || busy || sniperExecutionQueue.length === 0) return;

  const ids = sniperExecutionQueue.slice(0, 10);
  const items = ids.map(id => analysisQueue.find(m => String(m.id) === id)).filter(Boolean);
  if (items.length === 0) {
    sniperExecutionQueue.splice(0, ids.length);
    return;
  }

  sniperBatchInFlight = true;
  items.forEach(item => { item.isAnalyzing = true; });
  renderQueue();

  const command = "/analyzequeue " + ids.join(",");
  const outcome = await executeCommand(command, true);

  items.forEach(item => { item.isAnalyzing = false; });
  if (outcome?.deferred) {
    sniperBatchInFlight = false;
    renderQueue();
    return;
  }

  sniperExecutionQueue.splice(0, ids.length);
  const resultItems = outcome?.data?.result?.type === "analysis_queue"
    ? outcome.data.result.items || []
    : [];

  for (const item of items) {
    const itemResult = resultItems.find(result =>
      String(result.input) === String(item.id) || String(result.marketId) === String(item.id)
    );
    if (outcome?.ok && itemResult?.status === "success") {
      item.analysisCompleted = true;
      item.isFailed = false;
      continue;
    }

    item.queueAttempts = (item.queueAttempts || 0) + 1;
    if (item.queueAttempts < MAX_SNIPER_ATTEMPTS && analysisQueue.includes(item)) {
      sniperExecutionQueue.push(String(item.id));
    } else {
      item.isFailed = true;
      item.queueError = itemResult?.error || outcome?.error?.message || "Request analisis gagal.";
    }
  }

  sniperBatchInFlight = false;
  renderQueue();
}

function isDynamicEntryItem(item) {
  return (item?.duration_type || item?.durationType) === "5m";
}

function finishDynamicScan(item, remainingSeconds) {
  const previousStatus = item.entryScanner?.status;
  item.entryScanner = terminalizeEntryScannerState(
    item.entryScanner,
    remainingSeconds,
    new Date().toISOString(),
    currentEntryScannerConfig(),
  );
  if (item.entryScanner.status === "skipped") {
    item.isEvSkipped = true;
    item.snipeFired = true;
  }
  showDynamicScannerTransition(item, previousStatus);
  renderEVPanel();
}

async function scanDynamicEntryItem(item, sessionId = sniperSessionId) {
  const now = Date.now();
  const state = item.entryScanner || {};
  const previousStatus = state.status;
  const intervalMs = state.status === "entry" ? 2_000 : 5_000;
  if (item.dynamicScanInFlight || dynamicScanInFlightCount >= MAX_DYNAMIC_SCAN_CONCURRENCY || now - Number(item.dynamicLastScanAt || 0) < intervalMs) return;

  item.dynamicScanInFlight = true;
  dynamicScanInFlightCount += 1;
  item.dynamicLastScanAt = now;
  try {
    const response = await fetch("/api/short-entry-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketId: String(item.id) }),
      signal: AbortSignal.timeout(5_000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.snapshot) throw new Error(data.error || "Snapshot entry gagal.");
    if (!isSniperActive || sessionId !== sniperSessionId || !analysisQueue.includes(item)) return;

    item.entryScanner = advanceEntryScannerState(item.entryScanner, data.snapshot, currentEntryScannerConfig());
    showDynamicScannerTransition(item, previousStatus);
    if (item.entryScanner.status === "entry" && !item.entrySignalTriggered) {
      item.entrySignalTriggered = true;
      item.snipeFired = true;
      item.snipeFiredAtRemainingSeconds = Math.floor(data.snapshot.remainingSeconds);
      showToast(`Experimental Candidate ${item.entryScanner.signal.direction}: ask $${item.entryScanner.signal.ask.toFixed(2)}, EV +${item.entryScanner.signal.netEvCents.toFixed(1)}c`, "success", 10000);
      playAlertSound();
    } else if (previousStatus === "entry" && item.entryScanner.status === "no_chase") {
      showToast(`${item.entryScanner.signal.direction} berubah: candidate withdrawn — ${item.entryScanner.reason}`, "error", 10000);
    }
  } catch (error) {
    if (isSniperActive && sessionId === sniperSessionId && analysisQueue.includes(item)) {
      item.entryScanner = advanceEntryScannerState(item.entryScanner, {
        error: error.message,
        capturedAt: new Date().toISOString(),
      }, currentEntryScannerConfig());
      showDynamicScannerTransition(item, previousStatus);
    }
  } finally {
    if (sessionId === sniperSessionId) item.dynamicScanInFlight = false;
    dynamicScanInFlightCount = Math.max(0, dynamicScanInFlightCount - 1);
    renderQueue();
    renderEVPanel();
  }
}

function renderEntrySignalPanel() {
  const panel = document.querySelector("#entrySignalPanel");
  if (!panel) return;
  const item = selectNewestEntryScannerItem(analysisQueue.filter(isDynamicEntryItem));
  if (!item) {
    panel.hidden = true;
    document.querySelector("#entrySignalStatus")?.removeAttribute("data-lifecycle");
    return;
  }

  const result = normalizeEntryScannerResult(item.entryScanner);
  const observed = result.outcome === "ENTRY" ? result.issuedSignal || result.bestObserved : result.bestObserved;
  const latestSide = result.outcome === "ENTRY"
    ? item.entryScanner?.latestSnapshot?.sides?.[result.issuedSignal?.direction] || {}
    : {};
  const ttlSeconds = result.issuedSignal
    ? Math.max(0, Math.ceil((result.issuedSignal.expiresAt - Date.now()) / 1000))
    : 0;
  const isNoTrade = result.outcome !== "ENTRY";
  panel.hidden = false;
  panel.classList.toggle("no-chase", isNoTrade);
  const signalStatus = document.querySelector("#entrySignalStatus");
  const lifecycle = item.entryScanner?.status || result.outcome || "watching";
  signalStatus.dataset.lifecycle = lifecycle;
  signalStatus.textContent = lifecycle === "entry" || lifecycle === "candidate"
    ? scannerStatusLabel(lifecycle, result.diagnosticLean)
    : scannerOutcomeLabel(result.outcome || "INCOMPLETE");
  document.querySelector("#entrySignalExpiry").textContent = isNoTrade ? "REVIEW ONLY / NOT SELECTED" : `REVIEW ONLY · ${ttlSeconds}s observation window`;
  document.querySelector("#entrySignalMarket").textContent = item.groupItemTitle || item.question || item.id || "Unknown market";
  const lean = document.querySelector("#entrySignalDirection");
  lean.textContent = scannerDirectionLabel(result.diagnosticLean);
  lean.style.color = result.diagnosticLean === "UP" ? "var(--neon-green)" : result.diagnosticLean === "DOWN" ? "var(--neon-red)" : "var(--neon-amber)";
  document.querySelector("#entrySignalObserved").textContent = observed?.direction || "-";
  document.querySelector("#entrySignalAsk").textContent = formatScannerPrice(hasScannerNumber(latestSide.ask) ? latestSide.ask : observed?.ask);
  document.querySelector("#entrySignalGrossEv").textContent = formatScannerCents(observed?.grossEvCents);
  document.querySelector("#entrySignalEv").textContent = formatScannerCents(observed?.netEvCents);
  document.querySelector("#entrySignalFair").textContent = formatScannerPercent(observed?.fairProbability);
  document.querySelector("#entrySignalConfirmations").textContent = `${result.maxConfirmationCount}/${result.requiredConfirmations}`;
  document.querySelector("#entrySignalData").textContent = result.dataStatus;
  document.querySelector("#entrySignalGates").textContent = scannerGateMessages(result).join(" · ") || "No failed gates.";
}

function dynamicEntryItemFinished(item) {
  return normalizeEntryScannerResult(item.entryScanner).completed;
}

const btnSniperSettings = document.querySelector("#btnSniperSettings");
const sniperSettingsPanel = document.querySelector("#sniperSettingsPanel");
const btnMuteAudio = document.querySelector("#btnMuteAudio");
const iconMute = document.querySelector("#iconMute");

if (btnSniperSettings && sniperSettingsPanel) {
  btnSniperSettings.addEventListener("click", () => {
    sniperSettingsPanel.style.display = sniperSettingsPanel.style.display === "none" ? "block" : "none";
  });
}

// Global timer to update queue countdown visually
setInterval(() => {
  if (analysisQueue.length > 0) {
    renderQueue();
  }
}, 1000);

if (btnMuteAudio && iconMute) {
  btnMuteAudio.addEventListener("click", () => {
    isAudioMuted = !isAudioMuted;
    if (isAudioMuted) {
      iconMute.setAttribute("data-lucide", "volume-x");
      btnMuteAudio.style.color = "var(--neon-red)";
    } else {
      iconMute.setAttribute("data-lucide", "volume-2");
      btnMuteAudio.style.color = "var(--text-secondary)";
    }
    lucide.createIcons();
  });
}

const SNIPER_MIN_REMAINING_MS = 30_000;

function runSniperTick() {
  if (!isSniperActive) return;
  let triggered = false;

  // 1. Cek market mana saja yang sudah masuk sweet spot
  const queueLength = analysisQueue.length;
  const queueForTick = queueLength
    ? analysisQueue.slice(dynamicScanCursor).concat(analysisQueue.slice(0, dynamicScanCursor))
    : [];
  if (queueLength) dynamicScanCursor = (dynamicScanCursor + 1) % queueLength;
  queueForTick.forEach(m => {
    if (!m.endDate) return;
    const timeToClose = new Date(m.endDate).getTime() - Date.now();

    if (isDynamicEntryItem(m)) {
      const remainingSeconds = timeToClose / 1000;
      const config = currentEntryScannerConfig();
      if (!m.entryScanner) m.entryScanner = { status: "waiting", confirmationCount: 0, requiredConfirmations: config.confirmations };
      if (remainingSeconds <= 0) {
        finishDynamicScan(m, 0);
        triggered = true;
      } else if (m.entryScanner.status === "entry") {
        if (Date.now() > m.entryScanner.signal.expiresAt) {
          const previousStatus = m.entryScanner.status;
          m.entryScanner = advanceEntryScannerState(m.entryScanner, {
            error: "Signal TTL elapsed.",
            capturedAt: new Date().toISOString(),
          }, config);
          showDynamicScannerTransition(m, previousStatus);
          triggered = true;
        } else {
          scanDynamicEntryItem(m);
        }
      } else if (!["no_chase", "skipped"].includes(m.entryScanner.status)) {
        if (remainingSeconds <= config.scanStopSeconds) {
          finishDynamicScan(m, remainingSeconds);
          triggered = true;
        } else if (remainingSeconds <= config.scanStartSeconds) {
          scanDynamicEntryItem(m);
        } else if (m.entryScanner.status !== "waiting") {
          m.entryScanner = { status: "waiting", confirmationCount: 0, requiredConfirmations: config.confirmations };
          triggered = true;
        }
      }
      return;
    }

    if (!m.snipeFired) {
      const durationLimit = sniperTriggerSeconds(m.duration_type) * 1000;
      if (timeToClose <= 0) {
        m.snipeFiredAtRemainingSeconds = 0;
        m.snipeFired = true;
        m.isTooLate = true;
        triggered = true;
      } else if (timeToClose <= durationLimit) {
        m.snipeFiredAtRemainingSeconds = Math.floor(timeToClose / 1000);
        if (timeToClose <= SNIPER_MIN_REMAINING_MS) {
          m.snipeFired = true;
          m.isTooLate = true;
          triggered = true;
          const title = m.groupItemTitle || m.question.replace(/Up or Down -? ?/i, '').trim();
          showCustomAlert(`Analisis dibatalkan: Sisa waktu "${title}" tinggal 30 detik atau kurang.`);
        } else {
          // Tandai terlambat untuk informasi, tetapi tetap analisis selama masih aman.
          if (timeToClose < durationLimit - 10000) {
            m.isLateFired = true;
          }
          m.snipeFired = true;
          sniperExecutionQueue.push(String(m.id));
          triggered = true;
        }
      }
    }
  });

  if (triggered) renderQueue();

  // 2. Eksekusi tembakan jika UI tidak sedang sibuk
  if (!busy && sniperExecutionQueue.length > 0) processSniperExecutionQueue();

  // 3. Auto-stop jika semua market di antrean sudah ditembak & dieksekusi
  if (analysisQueue.length > 0) {
    const allFinished = analysisQueue.every(m => isDynamicEntryItem(m)
      ? dynamicEntryItemFinished(m)
      : m.analysisCompleted || m.isFailed || m.isTooLate);
    if (allFinished && sniperExecutionQueue.length === 0 && !busy && !sniperBatchInFlight) {
      if (analysisQueue.some(isDynamicEntryItem)) showDynamicScannerSessionSummary();
      toggleSniper();
    }
  }
}

function startSniper() {
  if (sniperInterval) clearInterval(sniperInterval);
  sniperSessionId += 1;
  const config = currentEntryScannerConfig();
  analysisQueue.forEach(item => {
    if (!isDynamicEntryItem(item)) return;
    resetEntryScannerItem(item, config.confirmations);
  });
  dynamicScanInFlightCount = 0;
  dynamicScanCursor = 0;
  renderEVPanel();
  sniperInterval = setInterval(runSniperTick, 1000);
  runSniperTick();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) runSniperTick();
});
window.addEventListener("focus", runSniperTick);

function stopSniper() {
  if (sniperInterval) clearInterval(sniperInterval);
  sniperInterval = null;
  sniperSessionId += 1;
  const config = currentEntryScannerConfig();
  analysisQueue.forEach(item => {
    if (isDynamicEntryItem(item) && item.entryScanner?.status === "candidate") {
      item.entryScanner = { status: "waiting", confirmationCount: 0, requiredConfirmations: config.confirmations };
    }
  });
  const panel = document.getElementById("dynamicEVPanel");
  if (panel) panel.style.display = "none";
  renderQueue();
}

function toggleSniper() {
  isSniperActive = !isSniperActive;
  if (isSniperActive) {
    btnRunQueue.innerHTML = `<i data-lucide="square" class="btn-icon" style="width:12px; height:12px;"></i> Stop EV Scanner`;
    btnRunQueue.style.background = "rgba(245, 158, 11, 0.5)";
    btnRunQueue.style.color = "#fff";
    startSniper();
  } else {
    btnRunQueue.innerHTML = `<i data-lucide="play" class="btn-icon" style="width:12px; height:12px;"></i> Start EV Scanner`;
    btnRunQueue.style.background = "rgba(245, 158, 11, 0.2)";
    btnRunQueue.style.color = "var(--neon-amber)";
    stopSniper();
    if (analysisQueue.length > 0) {
      showSniperSummaryModal();
    }
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  
  if (btnCloseQueue) {
    btnCloseQueue.style.opacity = isSniperActive ? "0.3" : "1";
    btnCloseQueue.style.cursor = isSniperActive ? "not-allowed" : "pointer";
  }
  
  renderQueue();
}

function showSniperSummaryModal() {
  const modal = document.getElementById("sniperSummaryModal");
  const tbody = document.getElementById("sniperSummaryTableBody");
  const metrics = document.getElementById("sniperSummaryMetrics");
  if (!modal || !tbody) return;

  const summary = summarizeEntryScannerSession(analysisQueue);
  let html = "";

  analysisQueue.forEach(m => {
    const rawTitle = m.groupItemTitle || String(m.question || "").replace(new RegExp(`(Bitcoin|Ethereum|Dogecoin) Up or Down -? ?`, "i"), "").trim() || m.id;
    const title = escapeHtml(rawTitle);
    const marketId = escapeHtml(m.id);

    if (isDynamicEntryItem(m)) {
      const result = normalizeEntryScannerResult(m.entryScanner);
      const observed = result.outcome === "ENTRY" ? result.issuedSignal || result.bestObserved : result.bestObserved;
      const gates = scannerGateMessages(result);
      const outcome = result.outcome || "INCOMPLETE";
      const outcomeLabel = scannerOutcomeLabel(outcome);
      const outcomeColor = outcome === "ENTRY" ? "var(--neon-green)" : outcome === "NO_CHASE" ? "var(--neon-red)" : "var(--neon-amber)";
      const leanColor = result.diagnosticLean === "UP" ? "var(--neon-green)" : result.diagnosticLean === "DOWN" ? "var(--neon-red)" : "var(--neon-amber)";
      html += `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:10px 16px;">
            <div style="font-weight:600; color:#fff;">${title}</div>
            <div style="font-size:10px; color:var(--text-tertiary); margin-top:2px;">${marketId}</div>
          </td>
          <td style="padding:10px 16px; text-align:center;">
            <span style="color:${outcomeColor}; font-weight:800;">${escapeHtml(outcomeLabel)}</span>
          </td>
          <td style="padding:10px 16px; text-align:center; color:${leanColor}; font-weight:800;">${escapeHtml(scannerDirectionLabel(result.diagnosticLean))}</td>
          <td style="padding:10px 16px; font-family:'JetBrains Mono',monospace; font-size:10px; line-height:1.5;">
            <strong>${escapeHtml(observed?.direction || "-")}</strong> · Fair ${formatScannerPercent(observed?.fairProbability)} · Ask ${formatScannerPrice(observed?.ask)} · Gross ${formatScannerCents(observed?.grossEvCents)} · Net ${formatScannerCents(observed?.netEvCents)}
            <div style="color:var(--text-tertiary);">Confirmations ${result.maxConfirmationCount}/${result.requiredConfirmations} · Data ${escapeHtml(result.dataStatus)}</div>
            <div style="color:${gates.length ? 'var(--neon-amber)' : 'var(--text-tertiary)'};">Gates: ${gates.length ? gates.map(escapeHtml).join(" · ") : "None"}</div>
          </td>
        </tr>
      `;
      return;
    }

    const historyItem = allHistoryEvents.find(h => String(h.market_id) === String(m.id));
    const prediction = historyItem?.prediction || null;
    const confidence = historyItem?.qwen_confidence || null;
    const legacyOutcome = m.analysisCompleted ? "ANALYZED" : m.isFailed ? "FAILED" : m.isTooLate ? "SKIPPED" : "WAITING";
    if (prediction) {
      html += `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:10px 16px;">
            <div style="font-weight:600; color:#fff;">${title}</div>
            <div style="font-size:10px; color:var(--text-tertiary); margin-top:2px;">${marketId}</div>
          </td>
          <td style="padding:10px 16px; text-align:center;">${legacyOutcome}</td>
          <td style="padding:10px 16px; text-align:center; font-weight:800;">${escapeHtml(prediction)}</td>
          <td style="padding:10px 16px; text-align:center; font-family:monospace; color:var(--neon-amber);">${hasScannerNumber(confidence) ? `${Number(confidence).toFixed(1)}%` : "-"}</td>
        </tr>
      `;
    } else {
      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05); opacity:0.5;"><td style="padding:10px 16px;"><div style="font-weight:600; color:#fff;">${title}</div></td><td style="padding:10px 16px; text-align:center;">${legacyOutcome}</td><td style="padding:10px 16px; text-align:center;">-</td><td style="padding:10px 16px; text-align:center;">-</td></tr>`;
    }
  });

  if (html === "") {
    html = `<tr><td colspan="4" style="padding:20px; text-align:center; color:var(--text-tertiary);">Tidak ada data summary.</td></tr>`;
  }

  tbody.innerHTML = html;

  if (metrics) {
    metrics.innerHTML = `
      <div><span>Completed</span><strong>${summary.completed}</strong></div>
      <div><span>Entries Issued</span><strong>${summary.entries}</strong></div>
      <div><span>No Entry</span><strong>${summary.noEntry}</strong></div>
      <div><span>No Chase</span><strong>${summary.noChase}</strong></div>
      <div><span>Lean Up</span><strong>${summary.up}</strong></div>
      <div><span>Lean Down</span><strong>${summary.down}</strong></div>
    `;
  }

  modal.style.display = "flex";
  if (typeof lucide !== 'undefined') lucide.createIcons();

  const btnCopy = document.getElementById("btnCopySniperSummary");
  if (btnCopy) {
    btnCopy.onclick = () => {
      const lines = [
        "Sniper Session Summary:",
        `Completed: ${summary.completed} | Entries Issued: ${summary.entries} | No Entry: ${summary.noEntry} | No Chase: ${summary.noChase}`,
        `Diagnostic lean: UP ${summary.up} | DOWN ${summary.down}`,
        "",
      ];
      analysisQueue.forEach(m => {
        if (isDynamicEntryItem(m)) {
          lines.push(...scannerResultReportLines(m, normalizeEntryScannerResult(m.entryScanner)));
          return;
        }
        const historyItem = allHistoryEvents.find(h => String(h.market_id) === String(m.id));
        const title = m.groupItemTitle || m.question || m.id || "Unknown market";
        lines.push(`- ${title}: ${historyItem?.prediction || "NO RESULT"}${hasScannerNumber(historyItem?.qwen_confidence) ? ` (${Number(historyItem.qwen_confidence).toFixed(1)}%)` : ""}`);
      });
      navigator.clipboard.writeText(lines.join("\n"));
      btnCopy.innerHTML = `<i data-lucide="check" style="width:14px; height:14px; margin-right:6px; color:var(--neon-green);"></i>Copied`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      setTimeout(() => {
        btnCopy.innerHTML = `<i data-lucide="copy" style="width:14px; height:14px; margin-right:6px;"></i>Copy Report`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }, 2000);
    };
  }
}

if (btnRunQueue) {
  btnRunQueue.addEventListener("click", () => {
    if (analysisQueue.length === 0 && !isSniperActive) {
      showCustomAlert("Antrian masih kosong. Drag & Drop market ke sini dulu.");
      return;
    }
    toggleSniper();
  });
}

/* --- Analyzed Events History --- */
const historyModal = document.querySelector("#historyModal");
const btnHistory = document.querySelector("#btnHistory");
const btnManual = document.querySelector("#btnManual");
const closeHistoryModal = document.querySelector("#closeHistoryModal");
const manualModal = document.querySelector("#manualModal");
const closeManualModal = document.querySelector("#closeManualModal");
const historyTableBody = document.querySelector("#historyTableBody");
const btnCheckAllHistory = document.querySelector("#btnCheckAllHistory");
let allHistoryEvents = [];
let currentHistoryAsset = "all";
let currentHistoryDuration = "all";

document.addEventListener("click", (clickEvent) => {
  const target = clickEvent.target.closest("[data-history-action]");
  if (!target) return;
  const action = target.dataset.historyAction;
  if (action === "show") window.showHistoryChat(target.dataset.eventId);
  else if (action === "check") window.checkHistoryEvent(target.dataset.eventId, target.dataset.marketId, target.dataset.prediction);
  else if (action === "reason") window.showReasonModal(target.dataset.eventId);
});

if (btnHistory && historyModal && closeHistoryModal) {
  btnHistory.addEventListener("click", () => {
    historyModal.style.display = "flex";
    fetchHistoryEvents();
  });

  closeHistoryModal.addEventListener("click", () => {
    historyModal.style.display = "none";
  });

  if (btnCheckAllHistory) {
    btnCheckAllHistory.addEventListener("click", async () => {
      const pendingEvents = allHistoryEvents.filter(e => e.status !== 'selesai' || e.result === 'menunggu hasil');
      if (pendingEvents.length === 0) {
        showCustomAlert("Tidak ada market yang perlu diperiksa.");
        return;
      }
      
      btnCheckAllHistory.disabled = true;
      const originalText = btnCheckAllHistory.innerHTML;
      btnCheckAllHistory.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px; height:14px;"></i> Memeriksa ${pendingEvents.length}...`;
      if (typeof lucide !== 'undefined') lucide.createIcons();

      let checkedCount = 0;
      for (const event of pendingEvents) {
        try {
          await fetch("/api/history/events/check", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: event.id, market_id: event.market_id, prediction: event.prediction })
          });
          checkedCount++;
          btnCheckAllHistory.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px; height:14px;"></i> Memeriksa ${pendingEvents.length - checkedCount}...`;
          if (typeof lucide !== 'undefined') lucide.createIcons();
        } catch (err) {
          console.error("Error checking event", event.id, err);
        }
      }
      
      btnCheckAllHistory.innerHTML = originalText;
      btnCheckAllHistory.disabled = false;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      
      fetchHistoryEvents();
      showCustomAlert(`Selesai memeriksa ${checkedCount} market.`);
    });
  }

  historyModal.addEventListener("click", (e) => {
    if (e.target === historyModal) {
      historyModal.style.display = "none";
    }
  });
}

// Manual Modal Listeners
if (btnManual && manualModal && closeManualModal) {
  btnManual.addEventListener("click", () => {
    manualModal.style.display = "flex";
  });

  closeManualModal.addEventListener("click", () => {
    manualModal.style.display = "none";
  });

  manualModal.addEventListener("click", (e) => {
    if (e.target === manualModal) {
      manualModal.style.display = "none";
    }
  });
}

document.querySelectorAll(".history-asset-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".history-asset-btn").forEach(b => {
      b.classList.remove("active");
      b.style.background = "transparent";
      b.style.color = "var(--text-secondary)";
    });
    const target = e.currentTarget;
    target.classList.add("active");
    target.style.background = "var(--neon-amber)";
    target.style.color = "#000";
    
    currentHistoryAsset = target.getAttribute("data-asset");
    applyHistoryFilter();
  });
});

// Event Listeners for filters
if (document.getElementById("btnFilterHistoryDate")) {
  document.getElementById("btnFilterHistoryDate").addEventListener("click", fetchHistoryEvents);
}
if (document.getElementById("btnResetHistoryFilters")) {
  document.getElementById("btnResetHistoryFilters").addEventListener("click", () => {
    document.getElementById("historyStartDate").value = "";
    document.getElementById("historyEndDate").value = "";
    document.getElementById("historyLimit").value = "1000";
    currentHistoryAsset = "all";
    currentHistoryDuration = "all";
    document.querySelectorAll(".history-asset-btn").forEach(b => b.classList.toggle("active", b.dataset.asset === "all"));
    document.querySelectorAll(".history-duration-btn").forEach(b => b.classList.toggle("active", b.dataset.duration === "all"));
    fetchHistoryEvents();
  });
}
if (document.getElementById("historyLimit")) {
  document.getElementById("historyLimit").addEventListener("change", applyHistoryFilter);
  document.getElementById("historyLimit").addEventListener("keyup", (e) => {
    if (e.key === "Enter") applyHistoryFilter();
  });
}
if (document.getElementById("btnSetHistoryLimit")) {
  document.getElementById("btnSetHistoryLimit").addEventListener("click", applyHistoryFilter);
}

document.querySelectorAll(".history-duration-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".history-duration-btn").forEach(b => {
      b.classList.remove("active");
      b.style.background = "transparent";
      b.style.color = "var(--text-secondary)";
    });
    const target = e.currentTarget;
    target.classList.add("active");
    target.style.background = "var(--neon-purple)";
    target.style.color = "#fff";
    
    currentHistoryDuration = target.getAttribute("data-duration");
    applyHistoryFilter();
  });
});

function getFilteredHistoryEvents() {
  let filtered = allHistoryEvents || [];
  
  // 1. Filter by Asset
  if (currentHistoryAsset !== "all") {
    filtered = filtered.filter(e => {
      const q = (e.question || "").toLowerCase();
      const u = (e.url || "").toLowerCase();
      if (currentHistoryAsset === "btc") return q.includes("bitcoin") || q.includes("btc") || u.includes("btc");
      if (currentHistoryAsset === "eth") return q.includes("ethereum") || q.includes("eth") || u.includes("eth");
      if (currentHistoryAsset === "doge") return q.includes("dogecoin") || q.includes("doge") || u.includes("doge");
      return true;
    });
  }

  // 2. Filter by Duration
  if (currentHistoryDuration !== "all") {
    filtered = filtered.filter(e => {
      const q = (e.question || "").toLowerCase();
      const u = (e.url || "").toLowerCase();
      if (currentHistoryDuration === "5m") return u.includes("5m") || q.includes("5 min") || q.includes("5-min");
      if (currentHistoryDuration === "15m") return u.includes("15m") || q.includes("15 min") || q.includes("15-min");
      if (currentHistoryDuration === "1h") return u.includes("hourly") || u.includes("1h") || q.includes("1 hour") || q.includes("1-hour");
      return true;
    });
  }

  // 3. Client-side Date Filter fallback
  const startDate = document.getElementById("historyStartDate")?.value || document.getElementById("archiveFilterDate")?.value;
  const endDate = document.getElementById("historyEndDate")?.value || document.getElementById("archiveFilterDate")?.value;
  if (startDate) {
    filtered = filtered.filter(e => (e.created_at || "").slice(0, 10) >= startDate);
  }
  if (endDate) {
    filtered = filtered.filter(e => (e.created_at || "").slice(0, 10) <= endDate);
  }
  
  return filtered;
}

function applyHistoryFilter() {
  const filtered = getFilteredHistoryEvents();
  renderHistoryEvents(filtered);
  renderHistoryListPanel(filtered);
}

async function fetchHistoryEvents() {
  try {
    let url = "/api/history/events";
    const startDate = document.getElementById("historyStartDate")?.value;
    const endDate = document.getElementById("historyEndDate")?.value;
    if (startDate && endDate) {
      url += `?startDate=${startDate}&endDate=${endDate}`;
    } else if (startDate) {
      url += `?startDate=${startDate}`;
    } else if (endDate) {
      url += `?endDate=${endDate}`;
    }
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok) {
      allHistoryEvents = data.events;
      applyHistoryFilter();
      renderQueue(); // Refresh queue badges
      renderHistoryListPanel();
    }
  } catch (error) {
    console.error("Failed to fetch history events:", error);
    const container = document.querySelector("#historyListContainer");
    if (container) {
      container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--neon-red);"><i data-lucide="wifi-off" style="width:24px; height:24px; margin-bottom:8px;"></i><br><b>Gagal memuat riwayat.</b><br><br><span style="font-size:10px; color:var(--text-tertiary);">Error: ${escapeHtml(error.message)}<br>Kemungkinan penyebab:<br>1. Jaringan terputus<br>2. Server backend mati/restart<br>3. Adblocker memblokir request</span></div>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Relocate modals to body to escape z-index and overflow clipping
  const modalsToMove = ["historyModal", "manualModal"];
  modalsToMove.forEach(id => {
    const el = document.getElementById(id);
    if (el) document.body.appendChild(el);
  });

  // Init lucide icons in Polymarket panel (it's a direct body child, added last)
  if (typeof lucide !== 'undefined') lucide.createIcons();

  const btnFilterHistoryDate = document.getElementById("btnFilterHistoryDate");
  if (btnFilterHistoryDate) {
    btnFilterHistoryDate.addEventListener("click", () => {
      fetchHistoryEvents();
    });
  }

  const archiveFilterDate = document.getElementById("archiveFilterDate");
  const btnResetArchiveDate = document.getElementById("btnResetArchiveDate");
  
  if (archiveFilterDate) {
    archiveFilterDate.addEventListener("change", () => {
      const val = archiveFilterDate.value;
      const sd = document.getElementById("historyStartDate");
      const ed = document.getElementById("historyEndDate");
      if (sd) sd.value = val;
      if (ed) ed.value = val;
      fetchHistoryEvents();
    });
  }

  if (btnResetArchiveDate) {
    btnResetArchiveDate.addEventListener("click", () => {
      if (archiveFilterDate) archiveFilterDate.value = "";
      const sd = document.getElementById("historyStartDate");
      const ed = document.getElementById("historyEndDate");
      if (sd) sd.value = "";
      if (ed) ed.value = "";
      fetchHistoryEvents();
    });
  }

  const btnResetHistoryFilters = document.getElementById("btnResetHistoryFilters");
  if (btnResetHistoryFilters) {
    btnResetHistoryFilters.addEventListener("click", () => {
      const sd = document.getElementById("historyStartDate");
      const ed = document.getElementById("historyEndDate");
      if (sd) sd.value = "";
      if (ed) ed.value = "";
      if (archiveFilterDate) archiveFilterDate.value = "";
      
      // Reset Asset Filter to 'all'
      document.querySelectorAll(".history-asset-btn").forEach(b => {
        b.classList.remove("active");
        b.style.background = "transparent";
        b.style.color = "var(--text-secondary)";
        if (b.getAttribute("data-asset") === "all") {
          b.classList.add("active");
          b.style.background = "var(--neon-amber)";
          b.style.color = "#000";
        }
      });
      currentHistoryAsset = "all";
      
      // Reset Duration Filter to 'all'
      document.querySelectorAll(".history-duration-btn").forEach(b => {
        b.classList.remove("active");
        b.style.background = "transparent";
        b.style.color = "var(--text-secondary)";
        if (b.getAttribute("data-duration") === "all") {
          b.classList.add("active");
          b.style.background = "var(--neon-purple)";
          b.style.color = "#fff";
        }
      });
      currentHistoryDuration = "all";
      
      fetchHistoryEvents();
    });
  }
});

function renderHistoryListPanel(eventsToRender = null) {
  const container = document.querySelector("#historyListContainer");
  const events = eventsToRender || allHistoryEvents;
  if (!container || !events) return;
  
  if (events.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-tertiary);">Belum ada riwayat analisis untuk filter ini.</div>';
    return;
  }

  let html = "";
  for (const event of events.slice(0, 50)) {
    const d = new Date(event.created_at);
    const timeStr = d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    const dateStr = d.toLocaleDateString("id-ID", { month: "short", day: "numeric" });
    
    let resultBadge = "";
    if (event.result && event.result !== "menunggu hasil") {
      const r = String(event.result).toUpperCase();
      const rColor = (r === 'MENANG') ? 'var(--neon-green)' : ((r === 'KALAH') ? 'var(--neon-red)' : ((r === 'NETRAL') ? 'var(--neon-amber)' : 'var(--text-tertiary)'));
      resultBadge = `<span title="Hasil Aktual" style="color:${rColor}; font-weight:bold; font-size:9px; border:1px solid ${rColor}; border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="flag" style="width:10px; height:10px; margin-right:4px;"></i> ${escapeHtml(historyResultLabel(r))}</span>`;
    }

    const pColor = (event.prediction === 'UP' || event.prediction === 'YES') ? 'var(--neon-green)' : ((event.prediction === 'DOWN' || event.prediction === 'NO') ? 'var(--neon-red)' : 'var(--text-tertiary)');
    const predBadge = `<span title="Prediksi AI" style="color:${pColor}; font-weight:bold; font-size:9px; border:1px solid ${pColor}; border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="bot" style="width:10px; height:10px; margin-right:4px;"></i> ${escapeHtml(historyPredictionLabel(event.prediction || '?'))}</span>`;
    const safeEventId = escapeHtml(event.id);
    const safeQuestion = escapeHtml(String(event.question || "")
      .replace(/Bitcoin/gi, 'BTC')
      .replace(/Ethereum/gi, 'ETH')
      .replace(/Dogecoin/gi, 'DOGE')
      .replace(/Solana/gi, 'SOL')
      .replace(/ Up or Down/gi, ''));

    html += `
      <div class="history-list-item" role="button" tabindex="0" data-history-action="show" data-event-id="${safeEventId}" style="padding:10px; border:1px solid rgba(255,255,255,0.05); border-radius:6px; background:rgba(0,0,0,0.2); cursor:pointer; transition:all 0.2s;">
        <div style="display:flex; justify-content:flex-start; align-items:center; gap:12px; margin-bottom:6px;">
          <span style="font-size:10px; color:var(--text-tertiary); white-space:nowrap; min-width:max-content;">${dateStr} ${timeStr}</span>
          <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-start;">
            ${predBadge}
            ${resultBadge}
            ${event.qwen_confidence ? `<span title="Qwen Confidence" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;">Q: ${escapeHtml(event.qwen_confidence)}</span>` : ''}
            ${event.data_confidence ? `<span title="Data Confidence" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;">D: ${escapeHtml(event.data_confidence)}</span>` : ''}
            ${event.execution_time ? `<span title="Execution Time" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="timer" style="width:8px; height:8px; margin-right:4px;"></i>${escapeHtml(event.execution_time)}s</span>` : ''}
          </div>
        </div>
        <div style="font-size:11px; font-weight:600; color:var(--text-primary); line-height:1.3; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">
          ${safeQuestion}
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons({ root: container });
}

window.showHistoryChat = function(eventId) {
  const event = allHistoryEvents.find(e => String(e.id) === String(eventId));
  if (!event) return;
  marketSummaryClosed = false;
  
  // Set tab history-archive message log to this event's conclusion
  const tab = outputTabs.get("history-archive");
  if (tab) {
    tab.messages = []; // Clear
    tab.messages.push({ role: "user", text: `Analyze Market: ${event.question}\nURL: ${event.url}` });
    
    let aiText = event.analysis_conclusion || "No detailed conclusion available.";
    let formattedText = `## 🤖 ARCHIVED ANALYSIS\n\n**Market:** [${event.question}](${event.url})\n**Prediction:** ${event.prediction}\n**Result:** ${event.result}\n\n---\n\n${aiText}`;
    
    tab.messages.push({ role: "assistant", text: formattedText });
    
    renderMessages();
    saveState();
  }

  // Also populate the MARKET SUMMARY panel with the history content
  const staticPanel = document.getElementById("staticResultPanel");
  const staticContent = document.getElementById("staticResultContent");
  if (staticPanel) {
    staticPanel.classList.remove("hidden");
  }
  
  if (staticContent) {
    const aiText = event.analysis_conclusion || "";
    staticContent.style.overflowY = "auto";
    staticContent.innerHTML = buildMarketSummaryHtml(aiText, { isHistory: true });
    if (window.lucide) window.lucide.createIcons({ root: staticContent });
    
    // Store archive report HTML for the global modal opener
    const report = document.createElement("div");
    const heading = document.createElement("h3");
    const meta = document.createElement("p");
    const body = document.createElement("pre");
    heading.textContent = "Archived Analysis";
    meta.textContent = `${event.question} | Prediction: ${historyPredictionLabel(event.prediction)} | Result: ${historyResultLabel(event.result)}`;
    body.textContent = aiText;
    body.style.whiteSpace = "pre-wrap";
    body.style.fontFamily = "inherit";
    report.append(heading, meta, body);
    window._currentReportHtml = report.outerHTML;
  }
}

function renderHistoryEvents(events) {
  const limitInput = document.getElementById('historyLimit');
  const limit = limitInput ? (parseInt(limitInput.value) || 1000) : 1000;
  const displayEvents = events.slice(0, limit);

  const statsEvents = events;
  let total = events.length;
  let wins = 0;
  let losses = 0;
  let neutrals = 0;
  let pending = 0;

  let html = "";
  for (const event of statsEvents) {
    const r = (event.result || "").toLowerCase();
    const p = (event.prediction || "").trim().toUpperCase();
    const isNeutral = r === 'netral' || p === '=' || p === 'SKIP' || p === 'NETRAL' || p === 'WATCHLIST';

    if (event.result === 'menang') wins++;
    else if (event.result === 'kalah') losses++;
    else if (isNeutral) neutrals++;
    else pending++;
  }

  for (const event of displayEvents) {
    const statusColor = event.status === 'selesai' 
      ? (event.result === 'menang' ? 'var(--neon-green)' : (event.result === 'kalah' ? 'var(--neon-red)' : 'var(--neon-amber)')) 
      : 'var(--text-tertiary)';
    const safeEventId = escapeHtml(event.id);
    const safeMarketId = escapeHtml(event.market_id);
    const safePrediction = escapeHtml(event.prediction || "-");
    const safePredictionLabel = escapeHtml(historyPredictionLabel(event.prediction));
    const safeQuestion = escapeHtml(event.question || "");
    const safeEventUrl = sanitizeHttpUrl(event.url);
    const questionHtml = safeEventUrl
      ? `<a href="${escapeHtml(safeEventUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--text-primary); text-decoration:none;">${safeQuestion}</a>`
      : `<span style="color:var(--text-primary);">${safeQuestion}</span>`;
    html += `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
        <td style="padding:10px 0;">
          ${questionHtml}
        </td>
        <td style="padding:10px 0; color:var(--text-secondary); font-weight:bold;">
          ${safePredictionLabel}
          ${event.actual_outcome ? `<div style="font-size:10px; color:var(--text-tertiary); margin-top:4px; font-weight:normal;">Realita: <span style="color:var(--text-primary);">${escapeHtml(event.actual_outcome)}</span></div>` : ''}
        </td>
        <td style="padding:10px 0; color:var(--text-tertiary); text-transform:capitalize;">${escapeHtml(event.status)}</td>
        <td style="padding:10px 0;">
          <span style="color:${statusColor}; font-weight:bold; text-transform:capitalize;">${escapeHtml(historyResultLabel(event.result))}</span>
          ${event.qwen_confidence ? `<div style="font-size:9px; color:var(--text-tertiary); margin-top:4px;">Qwen Conf: ${escapeHtml(event.qwen_confidence)}/100</div>` : ''}
          ${event.data_confidence ? `<div style="font-size:9px; color:var(--text-tertiary);">Data Conf: ${escapeHtml(event.data_confidence)}/100</div>` : ''}
          ${event.execution_time ? `<div style="font-size:9px; color:var(--text-tertiary); display:flex; align-items:center; justify-content:center; gap:4px;"><i data-lucide="timer" style="width:10px; height:10px;"></i> ${escapeHtml(event.execution_time)}s</div>` : ''}
        </td>
        <td style="padding:10px 0; text-align:right;">
          <button class="action-chip" style="height:24px; font-size:10px; padding:0 8px; ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? 'opacity:0.5; cursor:not-allowed;' : ''}" 
                  data-history-action="check" data-event-id="${safeEventId}" data-market-id="${safeMarketId}" data-prediction="${safePrediction}"
                  ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? 'disabled' : ''}>
            Periksa
          </button>
          ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? `
          <button class="action-chip" style="height:24px; font-size:10px; padding:0 8px; margin-left:4px; background:rgba(6,182,212,0.1); color:var(--neon-cyan); border:1px solid rgba(6,182,212,0.3);" 
                  data-history-action="reason" data-event-id="${safeEventId}">
            Reason
          </button>
          ` : ''}
        </td>
      </tr>
    `;
  }

  historyTableBody.innerHTML = html || '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-tertiary);">Belum ada riwayat analisis.</td></tr>';
  if (typeof lucide !== 'undefined') lucide.createIcons({ root: historyTableBody });
  
  document.querySelector("#historyTotal").textContent = total;
  
  // Also update the footer counter and new panel stats
  const totalAnalyzedCount = document.querySelector("#totalAnalyzedCount");
  if (totalAnalyzedCount) {
    totalAnalyzedCount.textContent = total;
  }
  
  const panelTotal = document.querySelector("#panelTotalAnalyzed");
  if (panelTotal) panelTotal.textContent = total;
  
  document.querySelector("#historyWins").textContent = wins;
  document.querySelector("#historyLosses").textContent = losses;
  document.querySelector("#historyPending").textContent = pending;

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Math.round((wins / resolved) * 100) : 0;
  
  const winRateEl = document.querySelector("#historyWinRate");
  winRateEl.textContent = `${winRate}%`;
  winRateEl.style.color = winRate >= 50 ? 'var(--neon-green)' : (winRate > 0 ? 'var(--neon-amber)' : 'var(--text-secondary)');

  const panelWinRate = document.querySelector("#panelWinRate");
  if (panelWinRate) {
    panelWinRate.textContent = `${winRate}%`;
    panelWinRate.style.color = winRate >= 50 ? 'var(--neon-green)' : (winRate > 0 ? 'var(--neon-amber)' : 'var(--text-secondary)');
  }
}

const alertModal = document.querySelector("#alertModal");
const alertModalText = document.querySelector("#alertModalText");
const closeAlertModal = document.querySelector("#closeAlertModal");

function showCustomAlert(text) {
  if (window.playAlertSound) window.playAlertSound();
  if (alertModal && alertModalText) {
    alertModalText.textContent = text;
    alertModal.style.display = "flex";
  } else {
    alert(text);
  }
}

if (closeAlertModal && alertModal) {
  closeAlertModal.addEventListener("click", () => {
    alertModal.style.display = "none";
  });
}

window.checkHistoryEvent = async function(id, marketId, prediction) {
  try {
    const res = await fetch("/api/history/events/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, market_id: marketId, prediction })
    });
    const data = await res.json();
    if (data.ok) {
      if (data.status === 'belum selesai') {
        showCustomAlert("Event belum selesai (Market masih aktif).");
      } else if (data.status === 'resolving') {
        showCustomAlert("Waktu event sudah habis, namun hasil resmi (oracle) Polymarket belum keluar. Silakan periksa lagi sebentar.");
      }
      fetchHistoryEvents(); // refresh list
    } else {
      showCustomAlert("Gagal memeriksa market: " + data.error);
    }
  } catch (error) {
    console.error("Error checking history event:", error);
    showCustomAlert("Terjadi kesalahan jaringan.");
  }
}

/* --- Reason & Outcome Modal --- */
const reasonModal = document.querySelector("#reasonModal");
const closeReasonModal = document.querySelector("#closeReasonModal");
const reasonModalContent = document.querySelector("#reasonModalContent");

const reasonPrediction = document.querySelector("#reasonPrediction");
const reasonActualOutcome = document.querySelector("#reasonActualOutcome");
const reasonStatusBadge = document.querySelector("#reasonStatusBadge");

if (closeReasonModal && reasonModal) {
  closeReasonModal.addEventListener("click", () => {
    reasonModal.style.display = "none";
  });
  reasonModal.addEventListener("click", (e) => {
    if (e.target === reasonModal) reasonModal.style.display = "none";
  });
}

window.showReasonModal = function(eventId) {
  const event = allHistoryEvents.find(e => e.id === eventId);
  if (!event) return;
  
  reasonModalContent.textContent = event.analysis_conclusion || "Tidak ada detail analisis tersimpan.";
  
  // Populate Event Result Details
  reasonPrediction.textContent = historyPredictionLabel(event.prediction);
  reasonPrediction.style.color = (event.prediction === 'UP' || event.prediction === 'YES') ? 'var(--neon-green)' : ((event.prediction === 'DOWN' || event.prediction === 'NO') ? 'var(--neon-red)' : 'var(--text-primary)');
  
  reasonActualOutcome.textContent = event.actual_outcome || "-";
  
  if (event.result === 'menang') {
    reasonStatusBadge.textContent = "MENANG";
    reasonStatusBadge.style.color = "var(--neon-green)";
    reasonStatusBadge.style.borderColor = "var(--neon-green)";
    reasonStatusBadge.style.background = "rgba(16, 185, 129, 0.1)";
  } else if (event.result === 'kalah') {
    reasonStatusBadge.textContent = "KALAH";
    reasonStatusBadge.style.color = "var(--neon-red)";
    reasonStatusBadge.style.borderColor = "var(--neon-red)";
    reasonStatusBadge.style.background = "rgba(239, 68, 68, 0.1)";
  } else if (event.result === 'netral' || event.result === 'neutral') {
    reasonStatusBadge.textContent = "NOT SELECTED";
    reasonStatusBadge.style.color = "var(--neon-amber)";
    reasonStatusBadge.style.borderColor = "var(--neon-amber)";
    reasonStatusBadge.style.background = "rgba(245, 158, 11, 0.1)";
  } else {
    reasonStatusBadge.textContent = (event.result || "-").toUpperCase();
    reasonStatusBadge.style.color = "var(--text-tertiary)";
    reasonStatusBadge.style.borderColor = "var(--text-tertiary)";
    reasonStatusBadge.style.background = "transparent";
  }
  
  reasonModal.style.display = "flex";
};

/* --- Settings Modal --- */
const settingsModal = document.querySelector("#settingsModal");
const btnSettings = document.querySelector("#btnSettings");
const closeSettingsModal = document.querySelector("#closeSettingsModal");
const btnSaveSettings = document.querySelector("#btnSaveSettings");
const toggleAudioBtn = document.querySelector("#toggleAudioBtn");
const settingsTabs = document.querySelectorAll(".settings-tab");
const settingsPanes = document.querySelectorAll(".settings-pane");

// Sniper Settings Inputs
const set5mScanStart = document.querySelector("#set5mScanStart");
const set5mScanStop = document.querySelector("#set5mScanStop");
const set5mMinFair = document.querySelector("#set5mMinFair");
const set5mMinEv = document.querySelector("#set5mMinEv");
const set5mMaxAsk = document.querySelector("#set5mMaxAsk");
const set5mConfirmations = document.querySelector("#set5mConfirmations");
const set15mMin = document.querySelector("#set15mMin");
const set15mSec = document.querySelector("#set15mSec");
const set1hMin = document.querySelector("#set1hMin");
const set1hSec = document.querySelector("#set1hSec");
const set4hHour = document.querySelector("#set4hHour");
const set4hMin = document.querySelector("#set4hMin");
const set1dHour = document.querySelector("#set1dHour");
const set1dMin = document.querySelector("#set1dMin");

async function fetchStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    if (data.ok && data.stats) {
      const statTotal = document.querySelector("#statTotal");
      const statWinRate = document.querySelector("#statWinRate");
      if (statTotal) statTotal.textContent = data.stats.totalAnalyzed;
      if (statWinRate) statWinRate.textContent = data.stats.winRate + "%";
    }
  } catch (err) {
    console.error("Failed to load stats:", err);
  }
}

async function fetchDashboardMetrics() {
  try {
    const res = await fetch("/api/dashboard-metrics");
    const data = await res.json();
    if (data.ok && data.metrics) {
      const m = data.metrics;
      const dPF = document.getElementById("dashProfitFactor");
      const dExp = document.getElementById("dashExpectancy");
      const dMDD = document.getElementById("dashMaxDd");
      const dWR = document.getElementById("dashWinRate");
      if (dPF) dPF.innerText = m.profitFactor;
      if (dExp) dExp.innerText = m.expectancy === "N/A" ? "N/A" : m.expectancy + "%";
      if (dMDD) dMDD.innerText = m.maxDrawdown === "N/A" ? "N/A" : m.maxDrawdown + "%";
      if (dWR) dWR.innerText = m.winRate + "%";

      const playStats = m.playStats || {};
      const sampleSize = playStats.sampleSize ?? m.sampleSize ?? 0;
      const wins = playStats.wins ?? 0;
      const losses = playStats.losses ?? 0;
      const winRate = playStats.winRate ?? m.winRate ?? 0;
      const safeCount = value => Number.isFinite(Number(value)) ? String(value) : "0";
      const safePercent = value => {
        if (value == null || value === "" || !Number.isFinite(parseFloat(value))) return "0%";
        const text = String(value);
        return text.endsWith("%") ? text : `${text}%`;
      };
      const dSample = document.getElementById("dashPlaySampleSize");
      const dWins = document.getElementById("dashPlayWins");
      const dLosses = document.getElementById("dashPlayLosses");
      const dPlayWinRate = document.getElementById("dashPlayWinRate");
      if (dSample) dSample.innerText = safeCount(sampleSize);
      if (dWins) dWins.innerText = safeCount(wins);
      if (dLosses) dLosses.innerText = safeCount(losses);
      if (dPlayWinRate) dPlayWinRate.innerText = safePercent(winRate);

      const sig = m.latestSignal;
      if (sig) {
        const dAsset = document.getElementById("dashSignalAsset");
        const dDir = document.getElementById("dashSignalDir");
        const dConc = document.getElementById("dashConclusionText");
        const dScore = document.getElementById("dashConfluenceScore");
        const dFill = document.getElementById("dashConfluenceFill");
        
        if (dAsset) dAsset.innerText = sig.asset;
        if (dDir) {
           dDir.innerText = sig.direction;
           if (sig.direction === 'LONG') {
               dDir.style.color = "var(--neon-green)";
               dDir.style.background = "rgba(16, 185, 129, 0.15)";
           } else if (sig.direction === 'SHORT') {
               dDir.style.color = "var(--neon-red)";
               dDir.style.background = "rgba(239, 68, 68, 0.15)";
           } else {
               dDir.style.color = "var(--text-secondary)";
               dDir.style.background = "rgba(255, 255, 255, 0.1)";
           }
        }
        // dConc diupdate via pipeline simulation, bukan dari m.latestSignal
        if (dScore) dScore.innerText = sig.confluenceScore;
        if (dFill) {
            let widthNum = parseFloat(sig.confluenceScore);
            if (!isNaN(widthNum)) dFill.style.width = widthNum + "%";
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch dashboard metrics:", err);
  }
}

// Fetch periodically
setInterval(fetchDashboardMetrics, 30000);

if (btnSettings && settingsModal) {
  btnSettings.addEventListener("click", () => {
    fetchStats();
    settingsModal.style.display = "flex";
  });
  
  closeSettingsModal.addEventListener("click", () => {
    settingsModal.style.display = "none";
  });
  
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.style.display = "none";
  });
  
  // (Old theme toggle logic removed, handled by Padre Theme Modal)

  settingsTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      // Deactivate all tabs and panes
      settingsTabs.forEach(t => {
        t.classList.remove("active");
        t.style.background = "transparent";
        t.style.color = "var(--text-secondary)";
      });
      settingsPanes.forEach(p => p.style.display = "none");
      
      // Activate clicked tab
      tab.classList.add("active");
      tab.style.background = "rgba(255,255,255,0.05)";
      tab.style.color = "var(--text-primary)";
      
      // Show corresponding pane
      const targetId = tab.dataset.target;
      const targetPane = document.getElementById(targetId);
      if (targetPane) {
        targetPane.style.display = "block";
      }
    });
  });
  
  
  
  btnSaveSettings.addEventListener("click", () => {
    // Save sniper settings
    const sniperConf = {
      version: SNIPER_CONFIG_VERSION,
      m5: {
        scanStartSeconds: (Number(set5mScanStart?.value) || 4) * 60,
        scanStopSeconds: (Number(set5mScanStop?.value) || 2) * 60,
        minFairProbability: Number(set5mMinFair?.value) || 60,
        minNetEvCents: Number(set5mMinEv?.value) || 8,
        maxAsk: Number(set5mMaxAsk?.value) || 0.65,
        confirmations: Number(set5mConfirmations?.value) || 2,
      },
      m15: { min: set15mMin?.value || 6, sec: set15mSec?.value || 0 },
      h1: { min: set1hMin?.value || 24, sec: set1hSec?.value || 0 },
      h4: { hour: set4hHour?.value || 1, min: set4hMin?.value || 36 },
      d1: { hour: set1dHour?.value || 9, min: set1dMin?.value || 36 }
    };
    localStorage.setItem("sniperConfig", JSON.stringify(sniperConf));

    settingsModal.style.display = "none";
    showCustomAlert("Settings tersimpan!");
  });
}

function loadSniperConfig() {
  let conf = defaultSniperConfig();
  try {
    const saved = localStorage.getItem("sniperConfig");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed?.version === SNIPER_CONFIG_VERSION) {
        conf = parsed;
      } else if (parsed?.version === 2) {
        conf = {
          ...conf,
          m15: parsed.m15 || conf.m15,
          h1: parsed.h1 || conf.h1,
          h4: parsed.h4 || conf.h4,
          d1: parsed.d1 || conf.d1,
        };
      }
    }
  } catch (err) {
    conf = defaultSniperConfig();
  }

  localStorage.setItem("sniperConfig", JSON.stringify(conf));
  if (conf.m5) {
    if (set5mScanStart) set5mScanStart.value = conf.m5.scanStartSeconds / 60;
    if (set5mScanStop) set5mScanStop.value = conf.m5.scanStopSeconds / 60;
    if (set5mMinFair) set5mMinFair.value = conf.m5.minFairProbability;
    if (set5mMinEv) set5mMinEv.value = conf.m5.minNetEvCents;
    if (set5mMaxAsk) set5mMaxAsk.value = conf.m5.maxAsk;
    if (set5mConfirmations) set5mConfirmations.value = conf.m5.confirmations;
  }
  if (set15mMin && conf.m15) { set15mMin.value = conf.m15.min; set15mSec.value = conf.m15.sec; }
  if (set1hMin && conf.h1) { set1hMin.value = conf.h1.min; set1hSec.value = conf.h1.sec; }
  if (set4hHour && conf.h4) { set4hHour.value = conf.h4.hour; set4hMin.value = conf.h4.min; }
  if (set1dHour && conf.d1) { set1dHour.value = conf.d1.hour; set1dMin.value = conf.d1.min; }
}

/* --- Init --- */
if (typeof lucide !== "undefined") {
  lucide.createIcons();
}
loadState();
loadSniperConfig();

// Panggil fetchHistoryEvents untuk mengambil data histori dari database di awal
fetchHistoryEvents();
fetchDashboardMetrics();

// Gunakan setActiveTab untuk memastikan state panel dan UI disinkronkan di awal
if (activeTabId) {
  setActiveTab(activeTabId);
} else {
  renderTabs();
  renderMessages();
}

// Queue polling handled by the sniper interval above
setTimeout(loadHealth, 100);
setTimeout(detectDns, 100);
setInterval(loadHealth, 5000); // Keep ms latency live in status bar


function updateTrackerConfig(minUsd, wallets) {
    // Send settings to backend
    fetch('/api/tracker-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minUsd, wallets })
    }).catch(console.error);
  }

  let currentTrackerAsset = "all";
  
  const assetTabs = document.querySelectorAll('.tracker-asset-tab');
  assetTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Update UI classes
      assetTabs.forEach(t => {
        t.classList.remove('active');
        t.style.background = 'transparent';
        t.style.color = '#aaa';
      });
      tab.classList.add('active');
      tab.style.background = 'rgba(255,255,255,0.1)';
      tab.style.color = '#fff';
      currentTrackerAsset = tab.dataset.asset;
      // Force immediate UI update instead of waiting for the 5s interval
      updateSnifferUI();
    });
  });

  // AI Token Popup Logic — use fixed positioning to escape footer overflow clipping
  const aiTokenBtn = document.getElementById('aiTokenBtn');
  const aiTokenPopup = document.getElementById('aiTokenPopup');
  if (aiTokenBtn && aiTokenPopup) {
    // Move popup to body so it's never clipped by any parent overflow
    document.body.appendChild(aiTokenPopup);
    aiTokenPopup.style.position = 'fixed';
    aiTokenPopup.style.zIndex = '9999';
    aiTokenPopup.style.display = 'none';

    const positionPopup = () => {
      const rect = aiTokenBtn.getBoundingClientRect();
      aiTokenPopup.style.left = rect.left + 'px';
      aiTokenPopup.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      aiTokenPopup.style.top = 'auto';
    };

    aiTokenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (aiTokenPopup.style.display === 'none') {
        positionPopup();
        aiTokenPopup.style.display = 'block';
      } else {
        aiTokenPopup.style.display = 'none';
      }
    });
    document.addEventListener('click', (e) => {
      if (!aiTokenPopup.contains(e.target) && !aiTokenBtn.contains(e.target)) {
        aiTokenPopup.style.display = 'none';
      }
    });
  }

/* --- Whale Sniffer UI Toggle --- */
let currentSnifferStartTime = 0;
let lastSeenWhaleTimestamp = Date.now();
let lastSeenTrackedTimestamp = Date.now();
let isFirstLoad = true;
let currentSnifferUiState = 'Offline';

  // Toast Function for New Whales
  function showWhaleToast(whale) {
  window.playSnifferSound();
    const toast = document.createElement("div");
    toast.style.position = "fixed";
    toast.style.bottom = "20px";
    toast.style.right = "20px";
    toast.style.background = "var(--bg-elevated)";
    toast.style.border = "1px solid var(--neon-cyan)";
    toast.style.borderRadius = "var(--radius-md)";
    toast.style.padding = "12px 16px";
    toast.style.color = "var(--text-primary)";
    toast.style.boxShadow = "0 8px 32px rgba(0,0,0,0.6)";
    toast.style.zIndex = "9999";
    toast.style.display = "flex";
    toast.style.flexDirection = "column";
    toast.style.gap = "4px";
    toast.style.transition = "opacity 0.5s ease";
    
    // Slide in effect
    toast.animate([
      { transform: 'translateX(100%)', opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 }
    ], { duration: 300, easing: 'ease-out' });
    
    const icon = whale.side === "BUY" ? "🟢" : (whale.side === "SELL" ? "🔴" : "🔵");
    const sizeStr = whale.sizeUsdc != null && Number.isFinite(Number(whale.sizeUsdc))
      ? "$" + Number(whale.sizeUsdc).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
      : "N/A";
    const priceStr = whale.price != null && Number.isFinite(Number(whale.price)) ? `$${Number(whale.price).toFixed(3)}` : "price unavailable";
    
    const isTracked = whale.isTracked;
    const headerTitle = isTracked ? "Tracked Wallet Activity" : "Whale Ditemukan!";
    const headerColor = isTracked ? "var(--neon-amber)" : "var(--neon-cyan)";
    const borderGlow = isTracked ? "1px solid var(--neon-amber)" : "1px solid var(--neon-cyan)";
    const iconName = isTracked ? "target" : "radar";
    
    toast.style.border = borderGlow;
    if (isTracked) toast.style.boxShadow = "0 8px 32px rgba(245,158,11,0.4)";

    const header = document.createElement("div");
    header.style.cssText = `font-weight:bold; font-size:12px; color:${headerColor}; display:flex; align-items:center; gap:6px;`;
    const headerIcon = document.createElement("i");
    headerIcon.dataset.lucide = iconName;
    headerIcon.style.cssText = "width:14px; height:14px;";
    header.append(headerIcon, document.createTextNode(headerTitle));

    const details = document.createElement("div");
    details.style.fontSize = "11px";
    details.textContent = `${icon} ${sizeStr} (${String(whale.side || "UNKNOWN")} @ ${priceStr})`;

    const market = document.createElement("div");
    market.style.cssText = "font-size:10px; color:var(--text-secondary); max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    market.textContent = String(whale.market_question || "Unknown market");
    toast.append(header, details, market);
    
    document.body.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons({root: toast});
    
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 500);
    }, 5000);
  }

  // =========================================================
  // DASHBOARD TRACKER CARD LOGIC
  // =========================================================
  const dashTrackerCard = document.getElementById('dashTrackerCard');
  const dashTabSniffer = document.getElementById('trackerCardTabSniffer');
  const dashTabWallet = document.getElementById('trackerCardTabWallet');
  const dashPaneSniffer = document.getElementById('trackerCardPaneSniffer');
  const dashPaneWallet = document.getElementById('trackerCardPaneWallet');
  const dashStatusPill = document.getElementById('trackerCardStatusPill');
  const dashStatusText = document.getElementById('trackerCardStatusText');
  const dashTrackerPowerBtn = document.getElementById('dashTrackerPowerBtn');
  const dashTrackerMinSize = document.getElementById('dashTrackerMinSize');
  const dashTrackerFeed = document.getElementById('dashTrackerFeed');
  const dashTrackedFeed = document.getElementById('dashTrackedFeed');
  const dashWalletInput = document.getElementById('dashWalletInput');
  const dashWalletNick = document.getElementById('dashWalletNick');
  const dashWalletAddBtn = document.getElementById('dashWalletAddBtn');
  const dashWalletTags = document.getElementById('dashWalletTags');

  dashWalletTags?.addEventListener("click", (clickEvent) => {
    const target = clickEvent.target.closest("[data-wallet-action]");
    if (!target) return;
    if (target.dataset.walletAction === "view") {
      window.viewWalletPositions(target.dataset.address, target.dataset.nickname);
    } else if (target.dataset.walletAction === "remove") {
      window.removeDashWallet(target.dataset.address);
    }
  });

  // Tab Switching
  if (dashTabSniffer && dashTabWallet) {
    dashTabSniffer.addEventListener('click', () => {
      dashTabSniffer.classList.add('active');
      dashTabWallet.classList.remove('active');
      dashPaneSniffer.classList.add('active');
      dashPaneWallet.classList.remove('active');
      updateSnifferUI();
    });
    dashTabWallet.addEventListener('click', () => {
      dashTabWallet.classList.add('active');
      dashTabSniffer.classList.remove('active');
      dashPaneWallet.classList.add('active');
      dashPaneSniffer.classList.remove('active');
      updateSnifferUI();
    });
  }

  // Maximize Button Logic
  const trackerMaximizeBtn = document.getElementById('trackerMaximizeBtn');
  let dashTrackerOriginalParent = null;
  let dashTrackerNextSibling = null;
  if (trackerMaximizeBtn && dashTrackerCard) {
    trackerMaximizeBtn.addEventListener('click', () => {
      const isMax = dashTrackerCard.classList.toggle('maximized-tracker');
      if (isMax) {
        dashTrackerOriginalParent = dashTrackerCard.parentNode;
        dashTrackerNextSibling = dashTrackerCard.nextSibling;
        document.body.appendChild(dashTrackerCard);
      } else {
        if (dashTrackerOriginalParent) {
          dashTrackerOriginalParent.insertBefore(dashTrackerCard, dashTrackerNextSibling);
        }
      }
      trackerMaximizeBtn.innerHTML = isMax ? '<i data-lucide="minimize-2" style="width:14px; height:14px; color:var(--neon-green);"></i>' : '<i data-lucide="maximize-2" style="width:14px; height:14px; color:var(--text-secondary);"></i>';
      if (window.lucide) window.lucide.createIcons({root: trackerMaximizeBtn});
    });
  }

  // Dashboard Power Button Logic
  if (dashTrackerPowerBtn) {
    dashTrackerPowerBtn.addEventListener('click', async () => {
      const isCurrentlyOff = dashTrackerPowerBtn.innerText.toLowerCase().includes('turn on');
      dashTrackerPowerBtn.style.opacity = '0.5';
      dashTrackerPowerBtn.innerText = 'WAIT...';
      try {
        const res = await fetch('/api/sniffer-toggle', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({active: isCurrentlyOff})
        });
        const data = await res.json();
        currentSnifferStartTime = data.startTime || 0;
        await updateSnifferUI();
      } catch (e) {
        console.error(e);
      } finally {
        dashTrackerPowerBtn.style.opacity = '1';
      }
    });
  }

  // Power Button Logic (Modal)
  const panelSnifferPowerBtn = document.getElementById('panelSnifferPowerBtn');
  if (panelSnifferPowerBtn) {
    panelSnifferPowerBtn.addEventListener('click', async () => {
      const isCurrentlyOff = panelSnifferPowerBtn.innerText.includes('TURN ON');
      panelSnifferPowerBtn.style.opacity = '0.5';
      panelSnifferPowerBtn.innerText = 'WAIT...';
      try {
        const res = await fetch('/api/sniffer-toggle', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({active: isCurrentlyOff})
        });
        const data = await res.json();
        currentSnifferStartTime = data.startTime || 0;
        await updateSnifferUI();
      } catch (e) {
        console.error(e);
      } finally {
        panelSnifferPowerBtn.style.opacity = '1';
      }
    });
  }

  async function updateSnifferUI() {
    try {
      const res = await fetch('/api/sniffer-whales');
      const data = await res.json();
      
      currentSnifferStartTime = data.startTime || 0;
      
      const topBtnText = document.getElementById('snifferToggleText');
      const topBtnIcon = document.getElementById('snifferToggleIcon');
      const snifferStatus = getSnifferUiStatus(data.health, data.isSnifferActive);
      const walletTabActive = dashPaneWallet?.classList.contains('active');
      const polygonState = String(data.polygonHealth?.state || "OFFLINE").toUpperCase();
      const cardStatus = walletTabActive
        ? polygonState === "RUNNING"
          ? { label: "Live", tone: "live" }
          : polygonState === "CONNECTING" || polygonState === "WAITING_FOR_MARKETS"
            ? { label: "Connecting", tone: "connecting" }
            : polygonState === "OFFLINE" || polygonState === "STOPPED"
              ? { label: "Offline", tone: "offline" }
              : { label: "Degraded", tone: "degraded" }
        : snifferStatus;
      currentSnifferUiState = cardStatus.label;
      
      if (data.isSnifferActive) {
        // Force to ON state to ensure interval starts ticking
        if (topBtnText && !topBtnText.innerText.includes('(')) {
          topBtnText.innerText = 'TRACKER: ON';
        }
        if (topBtnIcon) topBtnIcon.classList.add('radar-anim');
        
        const dashTrackerPowerBtn = document.getElementById('dashTrackerPowerBtn');
        if (dashTrackerPowerBtn) {
          dashTrackerPowerBtn.classList.add('on');
          dashTrackerPowerBtn.innerHTML = '<i data-lucide="radar" style="width:9px;height:9px;"></i> Turn Off';
        }
        const dashStatusPill = document.getElementById('trackerCardStatusPill');
        const dashStatusText = document.getElementById('trackerCardStatusText');
        if (dashStatusPill && dashStatusText) {
          dashStatusPill.classList.remove('live', 'degraded', 'connecting');
          dashStatusPill.classList.add(cardStatus.tone);
          dashStatusText.innerText = cardStatus.label;
          const walletState = data.polygonHealth?.state
            ? ` | wallet ${String(data.polygonHealth.state).toLowerCase()}`
            : "";
          dashStatusPill.title = describeSnifferHealth(data.health, snifferStatus) + walletState;
        }
      } else {
        if (topBtnText) topBtnText.innerText = 'TRACKER: OFF';
        if (topBtnIcon) topBtnIcon.classList.remove('radar-anim');
        
        const dashTrackerPowerBtn = document.getElementById('dashTrackerPowerBtn');
        if (dashTrackerPowerBtn) {
          dashTrackerPowerBtn.classList.remove('on');
          dashTrackerPowerBtn.innerHTML = '<i data-lucide="radar" style="width:9px;height:9px;"></i> Turn On';
        }
        const dashStatusPill = document.getElementById('trackerCardStatusPill');
        const dashStatusText = document.getElementById('trackerCardStatusText');
        if (dashStatusPill && dashStatusText) {
          dashStatusPill.classList.remove('live', 'degraded', 'connecting');
          dashStatusText.innerText = 'Offline';
          dashStatusPill.title = 'Offline';
        }
      }

      // Update Accumulated Whale Volume Grid
      const grid = document.getElementById('dashAccumulatedVolumeGrid');
      if (grid && data.accumulatedWhaleVolume) {
        const timeframes = ["5m", "15m", "1h", "4h", "1d"];
        let gridHtml = '';
        
        const formatVol = (v) => {
          if (v === 0) return '-';
          if (v >= 1000) return `$${(v/1000).toFixed(1)}k`;
          return `$${Math.round(v)}`;
        };
        
        if (currentTrackerAsset === 'all') {
          grid.style.gridTemplateColumns = '30px repeat(5, 1fr)';
          // Headers
          gridHtml += `<div></div>`;
          for (const tf of timeframes) {
             gridHtml += `<div style="font-size:8px; color:#aaa; text-align:center; padding-bottom:2px;">${tf}</div>`;
          }
          const assets = ['btc', 'eth', 'doge'];
          for (const asset of assets) {
             gridHtml += `<div style="display:flex; align-items:center; justify-content:center; font-size:8px; font-weight:bold; color:#777; border-right:1px solid rgba(255,255,255,0.05);">${asset.toUpperCase()}</div>`;
             const volData = data.accumulatedWhaleVolume[asset] || {};
             for (const tf of timeframes) {
                const stats = volData[tf] || { UP: 0, DOWN: 0 };
                gridHtml += `
                  <div style="background:rgba(255,255,255,0.01); padding:2px; text-align:center; border-bottom:1px solid rgba(255,255,255,0.02);">
                    <div style="color:var(--neon-green); font-size:8px; font-weight:bold;">${formatVol(stats.UP)}</div>
                    <div style="color:var(--neon-red); font-size:8px; font-weight:bold;">${formatVol(stats.DOWN)}</div>
                  </div>
                `;
             }
          }
        } else {
          grid.style.gridTemplateColumns = 'repeat(5, 1fr)';
          const volData = data.accumulatedWhaleVolume[currentTrackerAsset] || {};
          for (const tf of timeframes) {
            const stats = volData[tf] || { UP: 0, DOWN: 0 };
            const upStr = stats.UP > 0 ? `$${Math.round(stats.UP).toLocaleString()}` : '-';
            const downStr = stats.DOWN > 0 ? `$${Math.round(stats.DOWN).toLocaleString()}` : '-';
            
            gridHtml += `
              <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:4px; padding:4px; text-align:center;">
                <div style="font-size:8px; color:#aaa; margin-bottom:2px;">${tf}</div>
                <div style="color:var(--neon-green); font-size:9px; font-weight:bold;">${upStr}</div>
                <div style="color:var(--neon-red); font-size:9px; font-weight:bold;">${downStr}</div>
              </div>
            `;
          }
        }
        grid.innerHTML = gridHtml;
      }

      // AI Token display is now updated by loadHealth() via /api/health — no longer fetched here

      // Update Whale List & Check for New Whales
      if (data.isSnifferActive && data.whales) {
        let newWhaleFound = null;
        
        // Filter logic based on config
        let currentMinSize = 1000;
        const dashTrackerMinSize = document.getElementById('dashTrackerMinSize');
        if (dashTrackerMinSize) currentMinSize = parseInt(dashTrackerMinSize.value, 10) || 0;
        
        const snifferFiltered = data.whales.filter(w => {
          if (w.isTracked) return false;
          if (w.sizeUsdc < currentMinSize) return false;
          if (currentTrackerAsset !== "all" && w.asset !== currentTrackerAsset) return false;
          return true;
        });
        const trackedFiltered = data.whales.filter(w => w.isTracked);

        // Render Trending Markets
        const trendingContainer = document.getElementById('trendingMarketsContainer');
        const trendingList = document.getElementById('trendingMarketsList');
        if (data.trending && data.trending.length > 0 && trendingContainer && trendingList) {
          trendingContainer.style.display = "flex";
          trendingList.innerHTML = data.trending.map(t => {
            const eventUrl = polymarketEventUrl(t.slug);
            const content = `${escapeHtml(t.count)} trades • ${escapeHtml(t.question)}`;
            const attributes = `style="text-decoration:none; background:rgba(6,182,212,0.1); border:1px solid rgba(6,182,212,0.3); color:var(--neon-cyan); padding:4px 8px; border-radius:4px; font-size:11px; white-space:nowrap; max-width:200px; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(t.question)} (${escapeHtml(t.count)} trades)"`;
            return eventUrl
              ? `<a href="${escapeHtml(eventUrl)}" target="_blank" rel="noopener noreferrer" ${attributes}>${content}</a>`
              : `<span ${attributes}>${content}</span>`;
          }).join("");
        } else if (trendingContainer) {
          trendingContainer.style.display = "none";
        }

        // Render Sniffer View
        const dashTrackerFeed = document.getElementById('dashTrackerFeed');
        if (snifferFiltered.length > 0) {
           let html = '';
           let dashHtml = '';
           let maxTs = lastSeenWhaleTimestamp;
           
           for (const w of snifferFiltered) {
             if (w.timestamp > maxTs) maxTs = w.timestamp;
             if (w.timestamp > lastSeenWhaleTimestamp) {
               newWhaleFound = w;
             }
             
             const size = w.sizeUsdc != null && Number.isFinite(Number(w.sizeUsdc))
               ? "$" + Number(w.sizeUsdc).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
               : "N/A";
             
              const maker = String(w.maker || "Hidden");
              let walletShort = "";
              if (w.wallet_nickname) {
                walletShort = `${String(w.wallet_nickname)} (${maker.slice(0, 6)}...${maker.slice(-4)})`;
              } else {
                walletShort = maker === "Hidden" ? "Anonymous" : `${maker.slice(0, 6)}...${maker.slice(-4)}`;
              }
             
             const timeAgo = Math.round((Date.now() - w.timestamp) / 1000);
             const timeFmt = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo/60)}m ago`;
             const icon = w.side === "BUY" ? "🟢" : (w.side === "SELL" ? "🔴" : "🔵");
             
              const eventUrl = polymarketEventUrl(w.market_slug);
              const marketQuestion = escapeHtml(w.market_question);
              const eventLinkHtml = eventUrl
                ? `<a class="tracker-market-link" href="${escapeHtml(eventUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit; text-decoration:none;">${marketQuestion}</a>`
                : marketQuestion;


              const side = String(w.side || "OTHER").toUpperCase();
              const sideClass = side === "BUY" ? "buy" : side === "SELL" ? "sell" : "other";
              const outcomeStr = w.outcome === "UP" ? `<span style="color:var(--neon-green)">UP</span>` : (w.outcome === "DOWN" ? `<span style="color:var(--neon-red)">DOWN</span>` : `<span style="color:var(--text-tertiary)">???</span>`);
              const durationStr = w.duration_type ? `<span style="background:rgba(255,255,255,0.05); padding:2px 4px; border-radius:3px;">${escapeHtml(w.duration_type)}</span>` : "";

             dashHtml += `
              <div class="tracker-whale-item">
                <div class="whale-row-top">
                  <span class="whale-side-badge ${sideClass}">${escapeHtml(side)} ${outcomeStr}</span>
                  <span class="whale-size">${size}</span>
                  <span class="whale-time">${timeFmt}</span>
                </div>
                <div class="whale-market">${eventLinkHtml} ${durationStr}</div>
                <div style="display:flex; align-items:center;">
                  <div style="color:var(--text-tertiary); font-family:var(--font-mono); font-size:9px; margin-top:2px;">${escapeHtml(walletShort)}</div>
                  ${w.isTracked ? `<div class="whale-tracked-badge"><i data-lucide="target" style="width:8px; height:8px;"></i> Tracked</div>` : ''}
                </div>
              </div>
             `;
           }
           if (dashTrackerFeed) {
             dashTrackerFeed.innerHTML = dashHtml;
             if (typeof lucide !== 'undefined') lucide.createIcons({root: dashTrackerFeed});
           }
           lastSeenWhaleTimestamp = maxTs;

           if (newWhaleFound && !isFirstLoad) {
             showWhaleToast(newWhaleFound);
           }
        } else {
          if (dashTrackerFeed) dashTrackerFeed.innerHTML = `<div class="tracker-empty"><i data-lucide="activity" class="tracker-empty-icon"></i><p>Listening for trades &ge; $${currentMinSize}...</p></div>`;
          if (dashTrackerFeed && typeof lucide !== 'undefined') lucide.createIcons({root: dashTrackerFeed});
        }

        // Render Tracked View
        const trackedWhaleList = document.getElementById('trackedWhaleList');
        const dashTrackedFeed = document.getElementById('dashTrackedFeed');
        if (trackedFiltered.length > 0) {
           const newestTracked = trackedFiltered.reduce((latest, whale) => whale.timestamp > (latest?.timestamp || 0) ? whale : latest, null);
           let html = '';
           let dashTrackedHtml = '';
           for (const w of trackedFiltered) {
             const size = w.sizeUsdc != null && Number.isFinite(Number(w.sizeUsdc))
               ? "$" + Number(w.sizeUsdc).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
               : "N/A";
             
              const maker = String(w.maker || "Hidden");
              let walletShort = "";
              if (w.wallet_nickname) {
                walletShort = `${String(w.wallet_nickname)} (${maker.slice(0, 6)}...${maker.slice(-4)})`;
              } else {
                walletShort = maker === "Hidden" ? "Anonymous" : `${maker.slice(0, 6)}...${maker.slice(-4)}`;
              }
             
             const timeAgo = Math.round((Date.now() - w.timestamp) / 1000);
             const timeFmt = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo/60)}m ago`;
             const icon = w.side === "BUY" ? "🟢" : (w.side === "SELL" ? "🔴" : "🔵");
             
              const eventUrl = polymarketEventUrl(w.market_slug);
              const marketQuestion = escapeHtml(w.market_question);
              const eventLinkHtml = eventUrl
                ? `<a class="tracker-market-link" href="${escapeHtml(eventUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit; text-decoration:none;">${marketQuestion}</a>`
                : marketQuestion;
                 

             
              const side = String(w.side || "OTHER").toUpperCase();
              const sideClass = side === "BUY" ? "buy" : side === "SELL" ? "sell" : "other";
             dashTrackedHtml += `
              <div class="tracker-whale-item" style="border-left: 2px solid var(--neon-amber); background: rgba(245,158,11,0.02);">
                <div class="whale-row-top">
                  <span class="whale-side-badge ${sideClass}">${escapeHtml(side)}</span>
                  <span class="whale-size">${size}</span>
                  <span class="whale-time">${timeFmt}</span>
                </div>
                <div class="whale-market">${eventLinkHtml}</div>
                <div style="display:flex; align-items:center;">
                  <div style="color:var(--text-tertiary); font-family:var(--font-mono); font-size:9px; margin-top:2px;">${escapeHtml(walletShort)}</div>
                  <div class="whale-tracked-badge"><i data-lucide="target" style="width:8px; height:8px;"></i> Target</div>
                </div>
              </div>
             `;
           }
           if (dashTrackedFeed) {
             dashTrackedFeed.innerHTML = dashTrackedHtml;
             if (typeof lucide !== 'undefined') lucide.createIcons({root: dashTrackedFeed});
           }
           if (newestTracked && newestTracked.timestamp > lastSeenTrackedTimestamp && !isFirstLoad) {
             showWhaleToast(newestTracked);
           }
           if (newestTracked) lastSeenTrackedTimestamp = Math.max(lastSeenTrackedTimestamp, newestTracked.timestamp);
        } else {
          if (dashTrackedFeed) {
            if (activeTrackedWallets.length > 0) {
               dashTrackedFeed.innerHTML = `<div class="tracker-empty"><i data-lucide="target" class="tracker-empty-icon"></i><p>Listening for token transfers from tracked wallets...</p></div>`;
            } else {
              dashTrackedFeed.innerHTML = `<div class="tracker-empty"><i data-lucide="target" class="tracker-empty-icon"></i><p>No wallets tracked.<br>Add an address to monitor token transfers.</p></div>`;
            }
            if (typeof lucide !== 'undefined') lucide.createIcons({root: dashTrackedFeed});
          }
        }
      } else {
        const dashTrackerFeed = document.getElementById('dashTrackerFeed');
        if (dashTrackerFeed) {
          dashTrackerFeed.innerHTML = `<div class="tracker-empty"><i data-lucide="activity" class="tracker-empty-icon"></i><p>Tracker offline.<br>Turn on to intercept whale trades.</p></div>`;
          if (typeof lucide !== 'undefined') lucide.createIcons({root: dashTrackerFeed});
        }
      }
      
      isFirstLoad = false;
    } catch (e) {
      console.error("Failed fetching whales:", e);
    }
  }

  setInterval(() => {
    const text = document.getElementById('snifferToggleText');
    const dashText = document.getElementById('trackerCardStatusText');
    const powerBtn = document.getElementById('dashTrackerPowerBtn');
    
    if (!currentSnifferStartTime) return;
    
    // Check if sniffer is off
    const isOff = text ? text.innerText.includes('OFF') : (powerBtn && !powerBtn.classList.contains('on'));
    if (isOff) return;
    
    const diff = Math.floor((Date.now() - currentSnifferStartTime) / 1000);
    const m = String(Math.floor(diff / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    let timeStr = `${m}:${s}`;
    
    if (diff >= 3600) {
      const h = String(Math.floor(diff / 3600)).padStart(2, '0');
      const m2 = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
      timeStr = `${h}:${m2}:${s}`;
    }
    
    if (text) text.innerText = `TRACKER: ON (${timeStr})`;
    if (dashText) dashText.innerText = `${currentSnifferUiState} (${timeStr})`;
  }, 1000);
  
  setInterval(updateSnifferUI, 5000);

  // Sidebar Toggles
  const tabSniffer = document.getElementById('tabSniffer');
  const tabTrackWallet = document.getElementById('tabTrackWallet');
  // Tracker Config Logic
  let activeTrackedWallets = [];

  function renderWalletTags() {
    if (dashWalletTags) {
      if (activeTrackedWallets.length === 0) {
        dashWalletTags.innerHTML = '';
      } else {
        dashWalletTags.innerHTML = activeTrackedWallets.map(w => {
          const address = String(w.address || "");
          const nickname = String(w.nickname || "");
          return `
            <div class="wallet-tag" title="${escapeHtml(address)}">
              <button class="wallet-tag-view" type="button" data-wallet-action="view" data-address="${escapeHtml(address)}" data-nickname="${escapeHtml(nickname)}" style="cursor:pointer; text-decoration:underline; text-underline-offset:2px; font-weight:600; color:var(--text-secondary); transition:color 0.2s; background:none; border:0; padding:0;">${escapeHtml(nickname || `${address.slice(0, 6)}...`)}</button>
              <button type="button" data-wallet-action="remove" data-address="${escapeHtml(address)}">
                <i data-lucide="x" style="width:10px; height:10px;"></i>
              </button>
            </div>
          `;
        }).join("");
        if (typeof lucide !== 'undefined') lucide.createIcons({root: dashWalletTags});
      }
    }
  }

  window.removeDashWallet = async (addressToRemove) => {
    activeTrackedWallets = activeTrackedWallets.filter(wallet => wallet.address !== addressToRemove);
    renderWalletTags();
    await saveConfig();
  };

  async function saveConfig() {
    const minUsd = parseInt(dashTrackerMinSize?.value, 10) || 0;
    try {
      await fetch('/api/tracker-config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ minUsd, wallets: activeTrackedWallets })
      });
    } catch (e) { console.error(e); }
  }

  if (dashWalletAddBtn) {
    dashWalletAddBtn.addEventListener('click', async () => {
      const w = dashWalletInput.value.trim().toLowerCase();
      const n = dashWalletNick ? dashWalletNick.value.trim() : "";
      if (!/^0x[a-f0-9]{40}$/.test(w)) {
        showCustomAlert("Masukkan alamat wallet EVM yang valid.");
        return;
      }
      if (!activeTrackedWallets.some(x => x.address === w)) {
        dashWalletAddBtn.innerText = 'Adding...';
        activeTrackedWallets.push({ address: w, nickname: n });
        dashWalletInput.value = "";
        if (dashWalletNick) dashWalletNick.value = "";
        renderWalletTags();
        await saveConfig();
        dashWalletAddBtn.innerText = 'Add';
      }
    });
  }

  if (dashTrackerMinSize) {
    dashTrackerMinSize.addEventListener('change', async () => {
      await saveConfig();
    });
  }

  async function loadTrackerConfig() {
    try {
      const res = await fetch('/api/tracker-config');
      const data = await res.json();
      if (dashTrackerMinSize) dashTrackerMinSize.value = data.minUsd;
      activeTrackedWallets = data.wallets || [];
      renderWalletTags();
    } catch (e) {
      console.error("Failed to load tracker config", e);
    }
  }

  // View Positions Logic
  const positionsModal = document.getElementById('positionsModal');
  const btnClosePositions = document.getElementById('btnClosePositions');
  
  // Dashboard Elements
  const walletDashboardNickname = document.getElementById('walletDashboardNickname');
  const walletDashboardAddress = document.getElementById('walletDashboardAddress');
  const walletDashboardValue = document.getElementById('walletDashboardValue');
  const walletDashboardAllTimePnl = document.getElementById('walletDashboardAllTimePnl');
  const btnViewOnPoly = document.getElementById('btnViewOnPoly');
  
  const tabWalletPositions = document.getElementById('tabWalletPositions');
  const tabWalletHistory = document.getElementById('tabWalletHistory');
  const positionsTabContent = document.getElementById('positionsTabContent');
  const historyTabContent = document.getElementById('historyTabContent');

  if (btnClosePositions && positionsModal) {
    btnClosePositions.addEventListener('click', () => {
      positionsModal.style.display = 'none';
    });
  }

  // Tab switching logic
  if (tabWalletPositions && tabWalletHistory) {
    tabWalletPositions.addEventListener('click', () => {
      tabWalletPositions.style.background = 'rgba(245,158,11,0.1)';
      tabWalletPositions.style.borderBottom = '2px solid var(--neon-amber)';
      tabWalletPositions.style.color = 'var(--text-primary)';
      
      tabWalletHistory.style.background = 'transparent';
      tabWalletHistory.style.borderBottom = '2px solid transparent';
      tabWalletHistory.style.color = 'var(--text-tertiary)';
      
      positionsTabContent.style.display = 'flex';
      historyTabContent.style.display = 'none';
    });

    tabWalletHistory.addEventListener('click', () => {
      tabWalletHistory.style.background = 'rgba(245,158,11,0.1)';
      tabWalletHistory.style.borderBottom = '2px solid var(--neon-amber)';
      tabWalletHistory.style.color = 'var(--text-primary)';
      
      tabWalletPositions.style.background = 'transparent';
      tabWalletPositions.style.borderBottom = '2px solid transparent';
      tabWalletPositions.style.color = 'var(--text-tertiary)';
      
      historyTabContent.style.display = 'flex';
      positionsTabContent.style.display = 'none';
    });
  }

  window.viewWalletPositions = async (address, nickname) => {
    if (!positionsModal || !positionsTabContent) return;
    const normalizedAddress = String(address || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalizedAddress)) {
      showCustomAlert("Alamat wallet tidak valid.");
      return;
    }
    positionsModal.style.display = 'flex';
    
    // Reset Tabs
    if (tabWalletPositions) tabWalletPositions.click();
    
    if (walletDashboardNickname) walletDashboardNickname.textContent = nickname || 'Unknown Wallet';
    if (walletDashboardAddress) walletDashboardAddress.textContent = normalizedAddress;
    if (walletDashboardValue) walletDashboardValue.textContent = '...';
    if (walletDashboardAllTimePnl) walletDashboardAllTimePnl.textContent = '...';
    if (btnViewOnPoly) btnViewOnPoly.href = `https://polymarket.com/profile/${encodeURIComponent(normalizedAddress)}`;

    positionsTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-tertiary);"><i data-lucide="loader" class="radar-anim" style="width:24px; height:24px; margin-bottom:10px;"></i><br>Fetching portfolio data...</div>`;
    historyTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-tertiary);"><i data-lucide="loader" class="radar-anim" style="width:24px; height:24px; margin-bottom:10px;"></i><br>Fetching history...</div>`;
    if (typeof lucide !== 'undefined') {
      lucide.createIcons({root: positionsTabContent});
      lucide.createIcons({root: historyTabContent});
    }

    try {
      const res = await fetch(`/api/wallet-profile/${encodeURIComponent(normalizedAddress)}`);
      const data = await res.json();
      
      if (walletDashboardValue) {
        walletDashboardValue.textContent = "$" + (data.totalValue || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      }
      
      if (walletDashboardAllTimePnl) {
        const atPnl = data.allTimePnl || 0;
        walletDashboardAllTimePnl.textContent = (atPnl >= 0 ? "+" : "-") + "$" + Math.abs(atPnl).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        walletDashboardAllTimePnl.style.color = atPnl >= 0 ? 'var(--neon-green)' : 'var(--neon-red)';
        walletDashboardAllTimePnl.style.textShadow = atPnl >= 0 ? '0 0 10px rgba(16,185,129,0.3)' : '0 0 10px rgba(239,68,68,0.3)';
      }
      
      // Render Positions
      if (!data.positions || data.positions.length === 0) {
        positionsTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-tertiary);">No active positions found for this wallet.</div>`;
      } else {
        let html = '';
        for (const p of data.positions) {
          const value = "$" + parseFloat(p.currentValue).toFixed(2);
          const pnl = parseFloat(p.percentPnl);
          const pnlColor = pnl > 0 ? '#10b981' : (pnl < 0 ? '#ef4444' : 'var(--text-tertiary)');
          const pnlBg = pnl > 0 ? 'rgba(16,185,129,0.1)' : (pnl < 0 ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)');
          const pnlText = (pnl > 0 ? "+" : "") + pnl.toFixed(1) + "%";
          
          html += `
            <div class="wallet-position-card" style="background:var(--bg-elevated); border:1px solid var(--border); padding:16px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; transition:border-color 0.2s; cursor:pointer;">
              <div style="display:flex; flex-direction:column; gap:8px; flex:1; padding-right:16px;">
                 <div style="font-weight:600; color:var(--text-primary); font-size:14px; line-height:1.4;">${escapeHtml(p.title)}</div>
                <div style="display:flex; gap:16px; font-family:var(--font-mono); font-size:11px;">
                   <span style="color:var(--text-secondary); background:rgba(0,0,0,0.2); padding:2px 6px; border-radius:4px;">Outcome: <span style="color:var(--neon-amber); font-weight:bold;">${escapeHtml(p.outcome)}</span></span>
                  <span style="color:var(--text-secondary); background:rgba(0,0,0,0.2); padding:2px 6px; border-radius:4px;">Size: ${parseFloat(p.size).toFixed(0)} shares</span>
                  <span style="color:var(--text-secondary); background:rgba(0,0,0,0.2); padding:2px 6px; border-radius:4px;">Avg Price: $${parseFloat(p.avgPrice).toFixed(3)}</span>
                </div>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; min-width:110px; background:${pnlBg}; padding:10px 16px; border-radius:8px; border:1px solid ${pnlColor}40;">
                <span style="font-weight:bold; font-size:16px; color:var(--text-primary); font-family:var(--font-mono);">${value}</span>
                <span style="font-size:12px; color:${pnlColor}; font-weight:bold;">${pnlText} PnL</span>
              </div>
            </div>
          `;
        }
        positionsTabContent.innerHTML = html;
      }

      // Render History
      if (!data.history || data.history.length === 0) {
        historyTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-tertiary);">No recent trade history found.</div>`;
      } else {
        let html = '';
        for (const t of data.history) {
          const sideColor = t.side === 'BUY' ? 'var(--neon-green)' : 'var(--neon-red)';
          const sideBg = t.side === 'BUY' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
          const date = new Date(t.timestamp * 1000).toLocaleString('id-ID', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
          
          html += `
            <div style="background:var(--bg-elevated); border:1px solid var(--border); padding:12px 16px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
              <div style="display:flex; align-items:center; gap:16px; flex:1; padding-right:16px;">
                <div style="background:${sideBg}; color:${sideColor}; border:1px solid ${sideColor}40; padding:4px 10px; border-radius:4px; font-weight:bold; font-size:11px; font-family:var(--font-mono); min-width:48px; text-align:center;">
                  ${escapeHtml(t.side)}
                </div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                  <div style="font-weight:500; color:var(--text-primary); font-size:13px;">${escapeHtml(t.title)}</div>
                  <div style="font-size:11px; color:var(--text-tertiary);">${escapeHtml(date)}</div>
                </div>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:90px; font-family:var(--font-mono); font-size:12px;">
                <span style="color:var(--text-secondary);">${parseFloat(t.size).toFixed(1)} shares</span>
                <span style="color:var(--text-primary);">@ $${parseFloat(t.price).toFixed(3)}</span>
              </div>
            </div>
          `;
        }
        historyTabContent.innerHTML = html;
      }
    } catch (e) {
      console.error(e);
      positionsTabContent.textContent = `Failed to load data: ${e.message}`;
      historyTabContent.textContent = `Failed to load history: ${e.message}`;
    }
  };

  // Initial load
  loadTrackerConfig();
  updateSnifferUI();

// --- LIVE PRICES SSE ---
const livePriceSource = new EventSource('/api/live-prices');
livePriceSource.onmessage = (event) => {
  try {
    const prices = JSON.parse(event.data);
    for (const [tokenId, price] of Object.entries(prices)) {
      if(!price) continue;
      const centPrice = Math.round(price * 100);
      
      const elYes = document.getElementById('price-yes-' + tokenId);
      if (elYes && !elYes.textContent.includes(centPrice + 'c')) {
        const label = elYes.textContent.split(':')[0];
        elYes.textContent = `${label}: ${centPrice}c`;
        // Flash animation
        elYes.style.color = '#ffffff';
        setTimeout(() => elYes.style.color = 'var(--neon-green)', 300);
      }
      
      const elNo = document.getElementById('price-no-' + tokenId);
      if (elNo && !elNo.textContent.includes(centPrice + 'c')) {
        const label = elNo.textContent.split(':')[0];
        elNo.textContent = `${label}: ${centPrice}c`;
        // Flash animation
        elNo.style.color = '#ffffff';
        setTimeout(() => elNo.style.color = 'var(--neon-red)', 300);
      }
    }
  } catch(e) {}
};

/* --- Engines Popup Toggle (Body-Level Fixed Positioning) --- */
setTimeout(() => {
  const btn = document.getElementById('btnToggleEngines');
  const popup = document.getElementById('enginesPopup');
  if (btn && popup) {
    function positionPopup() {
      const rect = btn.getBoundingClientRect();
      popup.style.left = rect.left + 'px';
      popup.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
      popup.style.top = 'auto';
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popup.style.display === 'none' || popup.style.display === '') {
        positionPopup();
        popup.style.display = 'flex';
        setTimeout(() => popup.classList.remove('engines-closed'), 10);
      } else {
        popup.classList.add('engines-closed');
        setTimeout(() => popup.style.display = 'none', 400);
      }
    });
    document.addEventListener('click', (e) => {
      if (popup.style.display === 'flex' && !btn.contains(e.target) && !popup.contains(e.target)) {
        popup.classList.add('engines-closed');
        setTimeout(() => popup.style.display = 'none', 400);
      }
    });
  }
}, 1000);


function closeStaticPanel() {
  marketSummaryClosed = true;
  const content = document.getElementById('staticResultContent');
  if (content) content.replaceChildren();
}
window.closeStaticPanel = closeStaticPanel;

function openFullReportModal() {
  const content = window._currentReportHtml;
  if (!content) return;
  // Detect if it's already HTML (archive, pre-parsed) or raw text (live analysis)
  const modalHtml = content.startsWith('<') 
    ? `<div style="padding:10px;">${content}</div>`
    : `<div style="padding:10px;">${content}</div>`;
  const modalContent = document.getElementById('summaryModalContent');
  const modal = document.getElementById('summaryModal');
  if (modalContent && modal) {
    modalContent.innerHTML = modalHtml;
    modal.style.display = 'flex';
    if (window.lucide) window.lucide.createIcons({ root: modalContent });
  }
}
window.openFullReportModal = openFullReportModal;

function toggleWhaleVolume() {
  const wrapper = document.getElementById('dashAccumulatedVolumeGridWrapper');
  const icon = document.getElementById('whaleVolumeToggleIcon');
  if (!wrapper || !icon) return;
  
  if (wrapper.style.maxHeight === '0px' || wrapper.style.maxHeight === '0') {
    wrapper.style.maxHeight = '200px';
    wrapper.style.opacity = '1';
    icon.style.transform = 'rotate(0deg)';
  } else {
    wrapper.style.maxHeight = '0px';
    wrapper.style.opacity = '0';
    icon.style.transform = 'rotate(180deg)';
  }
}
window.toggleWhaleVolume = toggleWhaleVolume;
