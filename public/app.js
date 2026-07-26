/* ============================================================
   MVPM Terminal — Smart Input App Logic
   v31: Unified input system
   ============================================================ */

/* --- DOM Elements --- */
const commandInput = document.querySelector("#commandInput");
const runButton = document.querySelector("#runButton");
const runLabel = document.querySelector("#runLabel");
const runIcon = document.querySelector("#runIcon");
const clearButton = document.querySelector("#clearButton");
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
const inputDetected = document.querySelector("#inputDetected");
const smartHint = document.querySelector("#smartHint");
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

// Smart action buttons
const btnAnalyze = document.querySelector("#btnAnalyze");
const btnSearch = document.querySelector("#btnSearch");
const btnBook = document.querySelector("#btnBook");
const btnQuickscan = document.querySelector("#btnQuickscan");
const btnTop3 = document.querySelector("#btnTop3");
const btnAnalyzeBest = document.querySelector("#btnAnalyzeBest");
const btnAnalyzeAll = document.querySelector("#btnAnalyzeAll");

const CLIENT_VERSION = "public-search-v2-event-wide-analysis-v14-top-market-discovery";
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

// Smart input state
let selectedAction = "analyze"; // default action

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
          
          if (window.updateChartRealtimePrice) {
            window.updateChartRealtimePrice(asset, priceVal);
          }
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

/* --- Light / Dark Mode Toggle --- */
/* --- Theme Panel (Padre Style) Logic --- */
(function initThemePanel() {
  const html = document.documentElement;
  const themeTrigger = document.querySelector("#btnThemePanelTrigger");
  const themeModal = document.querySelector("#themePanelModal");
  const closeBtn = document.querySelector("#closeThemeModalBtn");
  const applyBtn = document.querySelector("#applyThemeBtn");
  const themeGridItems = document.querySelectorAll(".theme-grid-item");
  const langBtns = document.querySelectorAll("#themeLangGroup .theme-btn");
  const fontBtns = document.querySelectorAll("#themeFontGroup .theme-btn");

  // Move modals to body to avoid stacking context issues with sidebars
  const modalIds = ['settingsModal', 'historyModal', 'manualModal', 'improvementModal', 'alertModal', 'reasonModal', 'agentModal', 'positionsModal', 'summaryModal', 'sniperSummaryModal'];
  modalIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) document.body.appendChild(el);
  });

  // Restore from localStorage
  const savedMode = localStorage.getItem("razorbot_mode") || "dark";
  const savedFont = localStorage.getItem("razorbot_font") || "padre";
  const savedLang = localStorage.getItem("razorbot_lang") || "Indonesia";
  
  applyMode(savedMode);
  applyFont(savedFont);

  if (themeTrigger && themeModal) {
    themeTrigger.addEventListener("click", () => {
      themeModal.style.display = "flex";
    });
  }

  function closeModal() {
    if (themeModal) themeModal.style.display = "none";
  }

  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (applyBtn) applyBtn.addEventListener("click", closeModal);
  
  if (themeModal) {
    themeModal.addEventListener("click", (e) => {
      if (e.target === themeModal) closeModal();
    });
  }

  themeGridItems.forEach(item => {
    if (item.dataset.theme === savedMode) {
      themeGridItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");
    }
    item.addEventListener("click", () => {
      themeGridItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      const next = item.dataset.theme;
      applyMode(next);
      localStorage.setItem("razorbot_mode", next);
    });
  });

  langBtns.forEach(btn => {
    if (btn.dataset.lang === savedLang) {
      langBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    }
    btn.addEventListener("click", () => {
      langBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const next = btn.dataset.lang;
      localStorage.setItem("razorbot_lang", next);
      
      const sysSelect = document.getElementById("botLanguageSelect");
      if(sysSelect) sysSelect.value = next;
      
      if (typeof applyLanguageUI === "function") applyLanguageUI(next);
    });
  });

  fontBtns.forEach(btn => {
    if (btn.dataset.font === savedFont) {
      fontBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    }
    btn.addEventListener("click", () => {
      fontBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const next = btn.dataset.font;
      localStorage.setItem("razorbot_font", next);
      applyFont(next);
    });
  });

  function applyMode(mode) {
    if (mode === "light") {
      html.setAttribute("data-mode", "light");
      html.removeAttribute("data-theme");
    } else {
      html.setAttribute("data-mode", "dark");
      if (mode === "dark") {
        html.removeAttribute("data-theme");
      } else {
        html.setAttribute("data-theme", mode);
      }
    }
  }

  function applyFont(font) {
    html.setAttribute("data-font", font);
  }
})();

/* --- Input Detection --- */
function detectInputType(value) {
  const text = String(value || "").trim();
  if (!text) return { type: "empty", label: "" };

  // Slash command
  if (text.startsWith("/")) {
    return { type: "command", label: `⌘ Command: ${text.split(/\s+/)[0]}` };
  }

  // Polymarket event URL
  if (/polymarket\.com\/event\//i.test(text)) {
    return { type: "event-url", label: "🔗 Polymarket event link detected" };
  }

  // Polymarket market URL
  if (/polymarket\.com\//i.test(text)) {
    return { type: "market-url", label: "🔗 Polymarket market link detected" };
  }

  // Any URL
  if (/^https?:\/\//i.test(text)) {
    return { type: "url", label: "🔗 URL detected" };
  }

  // Market ID (numeric)
  if (/^\d{1,10}$/.test(text)) {
    return { type: "market-id", label: `🆔 Market ID: ${text}` };
  }

  // Slug-like (event slug)
  if (/^[a-z0-9-]{5,}$/.test(text)) {
    return { type: "event-slug", label: `📂 Event slug: ${text}` };
  }

  // Keyword
  return { type: "keyword", label: `🔍 Keyword search: "${text}"` };
}

function updateInputDetection() {
  const value = commandInput.value;
  const detection = detectInputType(value);

  // Update detection label
  if (inputDetected) {
    inputDetected.textContent = detection.label;
  }

  // Update hint
  if (smartHint) {
    if (detection.type === "empty") {
      smartHint.textContent = "Paste link atau ketik keyword di atas, lalu pilih aksi:";
    } else if (detection.type === "command") {
      smartHint.textContent = "Command langsung akan dikirim apa adanya.";
    } else {
      smartHint.textContent = "Pilih aksi yang ingin dilakukan:";
    }
  }

  // Highlight relevant action groups
  const isEvent = ["event-url", "event-slug"].includes(detection.type);
  const isMarket = ["market-url", "market-id"].includes(detection.type);
  const isKeyword = detection.type === "keyword";
  const isEmpty = detection.type === "empty";
  const isCommand = detection.type === "command";

  // Update action chip visibility/relevance
  highlightRelevantActions(detection.type);
  if (cooldownTimerId) updateCooldownUI(); // Update UI in case the new intended command is blocked
}

function highlightRelevantActions(inputType) {
  // All action buttons
  const allActions = [btnAnalyze, btnSearch, btnBook, btnQuickscan, btnTop3, btnAnalyzeBest, btnAnalyzeAll];

  // Reset all
  allActions.forEach(btn => {
    if (btn) {
      btn.classList.remove("selected");
      btn.style.opacity = "";
    }
  });

  if (inputType === "empty" || inputType === "command") {
    // Dim all when empty or using raw command
    allActions.forEach(btn => {
      if (btn) btn.style.opacity = inputType === "empty" ? "0.4" : "0.5";
    });
    return;
  }

  // Highlight best action based on input type
  if (["event-url", "event-slug"].includes(inputType)) {
    // Event inputs → highlight event actions, dim market-only
    [btnSearch].forEach(btn => { if (btn) btn.style.opacity = "0.4"; });
    if (btnAnalyzeBest) btnAnalyzeBest.classList.add("selected");
    selectedAction = "analyzebest";
  } else if (["market-url", "market-id"].includes(inputType)) {
    // Market inputs → highlight market actions, dim event-only
    [btnQuickscan, btnTop3, btnAnalyzeBest, btnAnalyzeAll].forEach(btn => {
      if (btn) btn.style.opacity = "0.4";
    });
    if (btnAnalyze) btnAnalyze.classList.add("selected");
    selectedAction = "analyze";
  } else if (inputType === "keyword") {
    // Keywords → search first, analyze second
    if (btnSearch) btnSearch.classList.add("selected");
    selectedAction = "search";
  } else {
    if (btnAnalyze) btnAnalyze.classList.add("selected");
    selectedAction = "analyze";
  }
}

/* --- Build command from action + input --- */
function buildCommand(action, inputText) {
  const text = String(inputText || "").trim();

  // If input is already a slash command, send as-is
  if (text.startsWith("/")) return text;

  const commandMap = {
    analyze: "/analyze",
    search: "/search",
    book: "/book",
    quickscan: "/quickscan",
    top3: "/top3",
    analyzebest: "/analyzebest",
    analyzeall: "/analyzeall",
  };

  const prefix = commandMap[action] || "";
  return prefix ? `${prefix} ${text}` : text;
}

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
  runButton.disabled = false;
  commandInput.disabled = busy;
  loadingState.classList.toggle("hidden", !busy);
  runButton.classList.toggle("cancel", busy);
  runButton.classList.remove("cooldown");
  if (runLabel) runLabel.textContent = busy ? "Cancel" : "Run";
  if (runIcon) runIcon.textContent = busy ? "■" : "▶";
  runButton.setAttribute("aria-label", busy ? "Cancel" : "Run analysis");

  if (busy) {
    localStorage.removeItem("market_summary_closed");
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
    const staticBody = document.getElementById("staticResultBody");

    if (dConc || (staticPanel && staticBody)) {
      let stageIdx = 0;
      const initialText = pipelineStages[0];
      
      if (dConc) dConc.innerText = initialText;
      
      if (staticPanel && staticBody) {
        staticPanel.style.display = "flex";
        staticBody.innerHTML = `
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
  // Which command is the user about to run?
  const text = commandInput.value.trim();
  const command = text.startsWith("/") ? text : buildCommand(selectedAction, text);
  
  // Calculate remaining ms for the intended command
  const remainingMs = getCooldownRemaining(command);
  const remaining = Math.ceil(remainingMs / 1000);

  // We should also display if ANY cooldown is active on the Guard Rail
  const maxRemainingMs = Math.max(0, qwenCooldownUntil - now, commandCooldownUntil - now);
  const maxRemaining = Math.ceil(maxRemainingMs / 1000);

  if (remaining > 0) {
    runButton.disabled = true;
    runButton.classList.remove("cancel");
    runButton.classList.add("cooldown");
  } else if (!busy) {
    runButton.disabled = false;
    runButton.classList.remove("cooldown");
  }

  if (runLabel) runLabel.textContent = remaining > 0 ? `${remaining}s` : (busy ? "Cancel" : "Run");
  if (runIcon) runIcon.textContent = remaining > 0 ? "⏳" : (busy ? "■" : "▶");

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

function clearAll() {
  commandInput.value = "";
  const tab = activeTab();
  if (tab) tab.messages = [];
  renderMessages();
  updateInputDetection();
  commandInput.focus();
  saveState();
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
        currentSection = line.trim();
      } 
      else if (/^([A-Za-z0-9 \(\)-]+):(.*)$/.test(line) && !line.startsWith("http")) {
        const match = line.match(/^([A-Za-z0-9 \(\)-]+):(.*)$/);
        const key = match[1].trim();
        let val = match[2].trim();

        if (key === "Realtime Ticker" && val.length > 0) {
          const payload = val;
          sectionContent += `<div class="msg-kv realtime-ticker-kv"><span class="live-ticker" data-tokens="${payload}">⏳ Syncing CLOB & Crypto Feed...</span></div>`;
          continue;
        }

        // Visual progress bar handling
        if (key.startsWith("Confidence") && val.includes(" | ")) {
           let part1 = `${key}: ${val.split(" | ")[0]}`;
           let part2 = val.split(" | ")[1];
           let pct1 = part1.match(/(\d+(\.\d+)?)%/);
           let pct2 = part2.match(/(\d+(\.\d+)?)%/);
           if (pct1 && pct2) {
             let p1 = parseFloat(pct1[1]);
             let p2 = parseFloat(pct2[1]);
             sectionContent += `<div style="font-size:10px; color:var(--text-tertiary); margin-top:8px; display:flex; justify-content:space-between;"><span>${part1.split(':')[0]}</span><span>${part2.split(':')[0]}</span></div>`;
             sectionContent += `<div class="visual-bar-container">
               <div class="visual-bar-fill" style="width:${p1}%">${p1}%</div>
               <div class="visual-bar-fill secondary" style="width:${p2}%">${p2}%</div>
             </div>`;
             continue;
           }
        }

        // Highlight percentages and money
        val = val.replace(/(\$[\d,]+(\.\d+)?|\d+(\.\d+)?%)/g, '<span class="hl-val">$1</span>');
        
        if (currentSection === "SNAPSHOT DATA" && (key === "Liquidity" || key === "Gamma volume" || key.startsWith("Orderbook"))) {
          metricGrid += `<div class="dash-box"><div class="dash-label">${key}</div><div class="dash-val" style="font-size:12px; color:var(--text-primary); font-family:'JetBrains Mono', monospace;">${val}</div></div>`;
        } else {
           sectionContent += `
             <div class="dash-box" style="margin-bottom:2px;">
               <div class="dash-label">${key}</div>
               <div class="dash-val" style="font-size:12px; white-space:normal; line-height:1.4; color:var(--text-secondary); font-family:'JetBrains Mono', monospace;">${val}</div>
             </div>
           `;
        }
      } 
      // List items
      else if (line.startsWith("- ") || line.startsWith("* ")) {
        sectionContent += `<div style="font-size:11px; color:var(--text-secondary); margin-bottom:6px; line-height:1.5; padding-left:12px; position:relative;"><span style="position:absolute; left:0; color:var(--neon-purple);">&bull;</span> ${line.substring(2)}</div>`;
      } 
      // Normal text
      else {
        let htmlLine = line
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
          .replace(/_(.*?)_/g, '<em>$1</em>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
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
    const staticBody = document.getElementById("staticResultBody");
    if (staticPanel && staticBody) {
      if (html.includes('class="dash-agent-analysis"')) {
        // Real Qwen analysis result - show in static panel
        if (localStorage.getItem("market_summary_closed") === "true") {
          return wrapper; // Skip rendering if user closed it
        }
        
        if (message.text && message.text.includes("MARKET SUMMARY")) {
          const bentoHtml = typeof buildBentoGrid === "function" ? buildBentoGrid(message.text) : html;
          staticBody.innerHTML = bentoHtml;
          // Store the report HTML globally so openFullReportModal() can access it
          window._currentReportHtml = html;
          // Handler is now inline onclick="openFullReportModal()" on the span itself

        } else {
          staticBody.innerHTML = html;
        }
        
        staticPanel.style.display = "flex";
        if (window.lucide) window.lucide.createIcons({ root: staticBody });
        wrapper.style.display = "none";
      } else {
        // Raw text / errors: also show them in the static panel if the console feed is hidden
        staticBody.innerHTML = `<div style="display:flex; flex-direction:column; justify-content:center; padding: 24px; background:var(--bg-elevated); border-radius:12px; border:1px solid rgba(255,255,255,0.05); position:relative;">\n          <button onclick="closeStaticPanel()" style="position:absolute; top:12px; right:12px; background:none; border:none; color:var(--text-tertiary); cursor:pointer;"><i data-lucide="x" style="width:16px;height:16px;"></i></button>\n          ${html}\n        </div>`;
        staticPanel.style.display = "flex";
        if (window.lucide) window.lucide.createIcons({ root: staticBody });
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
  
  const icon = isError ? "⚠" : "✓";
  toast.innerHTML = `<span style="flex-shrink:0; font-size:12px;">${icon}</span><span>${text.replace(/\n/g, "<br>")}</span>`;
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
  const QWEN_COMMANDS = ["/analyze", "/analyzebest", "/analyzeall", "/eventmarket", "/eventbest", "/eventall"];
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
  if (busy) return;
  const text = String(commandText || "").trim();
  if (!text) return;

  const remMs = getCooldownRemaining(text);
  if (remMs > 0) {
    const tabInfo = tabInfoForCommand(text, "auto");
    if (!isBackground) setActiveTab(tabInfo);
    addError(`ANTI-SPAM: Command ini masih dalam cooldown ${Math.ceil(remMs / 1000)} detik lagi.`, tabInfo.id);
    return;
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
    const botLanguage = localStorage.getItem("botLanguage") || "Indonesia";
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, mode: "auto", language: botLanguage }),
      signal: activeRequest.signal,
    });
    data = await response.json();
    const latency = Date.now() - fetchStart;
    if (sbLatency) sbLatency.textContent = `${latency}ms`;

    syncRateLimit(data);
    warnIfServerVersionMismatch(data, tabInfo.id);

    if (!data.ok) {
      addError(data.error || "Request gagal.", tabInfo.id);
      for (const msg of data.messages || []) addMessage(msg, tabInfo.id);
      markQueueItemsFailed(text);
      return;
    }

    for (const msg of data.messages || []) addMessage(msg, tabInfo.id);
  } catch (error) {
    if (error.name === "AbortError") {
      addError("Prompt dibatalkan.", tabInfo.id);
    } else {
      let errorMsg = error.message || String(error);
      if (errorMsg === "Failed to fetch") {
        errorMsg = "❌ Failed to fetch: Gagal menghubungi server backend.\n\nKemungkinan penyebab:\n1. Server backend mati (pastikan 'npm start' sedang berjalan)\n2. Port backend berubah atau tidak ter-expose\n3. Jaringan internet atau lokal terputus\n4. Ekstensi browser (adblocker/cors) memblokir request";
      }
      addError(errorMsg, tabInfo.id);
      markQueueItemsFailed(text);
    }
  } finally {
    activeRequest = null;
    // Refresh history so that recent analysis is shown in the History tab
    await fetchHistoryEvents();
    
    setBusy(false);
    if (isBackground) playQueueDoneSound();
    
    // Jika fetch gagal atau tidak ok, sembunyikan static panel
    if (!data || !data.ok) {
       const staticPanel = document.getElementById("staticResultPanel");
       if (staticPanel) staticPanel.classList.add("hidden");
    }

    // Jika fetch sukses, state udah disync via syncRateLimit.
    // Jika gagal network, set local fallback cooldown.
    if (!data || !data.rateLimit) {
      const isQwen = isQwenCommand(commandText);
      const ms = isQwen ? qwenCommandCooldownMs : commandCooldownMs;
      setCooldown(ms, isQwen);
    }
  }
}

/* --- Run button: build command from selected action + input --- */
function runFromInput() {
  const text = commandInput.value.trim();
  if (!text) {
    commandInput.focus();
    return;
  }

  // If it's already a slash command, send directly
  if (text.startsWith("/")) {
    executeCommand(text);
    return;
  }

  const command = buildCommand(selectedAction, text);
  executeCommand(command);
}

/* --- Real-Time WS Status Polling --- */
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

    updateDot('wsStatusSniffer', data.sniffer);
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
      qwenStatus.innerHTML = isError ? `<span style="display:flex; align-items:center; gap:4px; cursor:pointer;" title="Click to reconnect"><i data-lucide="refresh-cw" style="width:10px; height:10px;"></i> ${baseText}</span>` : baseText;
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
            <span style="color:var(--text-primary); font-family:var(--font-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px;" title="${model}">${model}</span>
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

/* --- Wallet Stream --- */
const walletStream = new EventSource('/api/wallet-stream');
walletStream.addEventListener('message', (e) => {
  try {
    const data = JSON.parse(e.data);
    const pmHeader = document.getElementById('pmWalletAddress');
    if (data.connected && pmHeader) {
      // Truncate address to 0x...1234
      const addr = data.address;
      const shortAddr = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      pmHeader.textContent = shortAddr;
      pmHeader.style.color = 'var(--neon-green)';
      pmHeader.style.borderColor = 'rgba(16,185,129,0.3)';
      pmHeader.style.background = 'rgba(16,185,129,0.05)';
      
      // Update balances if they are not hidden
      if (!isWalletHidden) {
        if (walletUsdcBalance) walletUsdcBalance.textContent = `$${data.usdc.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        if (walletPortfolioValue) walletPortfolioValue.textContent = `$${data.usdc.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`; // Basic mock for portfolio
        // Native balance could be shown somewhere, but standard Polymarket UI uses USDC primarily.
      }
      
      // Save full data to a global or data attribute if needed
      window.walletData = data;
    }
  } catch (err) {
    console.error('Error parsing wallet stream:', err);
  }
});

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

// Run button
runButton.addEventListener("click", () => {
  if (busy) { cancelActiveRequest(); return; }
  runFromInput();
});

// Clear button
clearButton.addEventListener("click", clearAll);

// Ctrl+Enter to run
commandInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runFromInput();
  }
});

// Input change detection
commandInput.addEventListener("input", updateInputDetection);
commandInput.addEventListener("paste", () => {
  // Delay to let paste complete
  setTimeout(updateInputDetection, 50);
});

// Discover chips (no input needed, run immediately)
document.querySelectorAll("[data-command]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const command = btn.dataset.command;
    if (command) {
      executeCommand(command);
    }
  });
});

// Smart action buttons (set selected action, then optionally run)
[btnAnalyze, btnSearch, btnBook, btnQuickscan, btnTop3, btnAnalyzeBest, btnAnalyzeAll].forEach(btn => {
  if (!btn) return;
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (!action) return;

    // Set as selected action
    selectedAction = action;

    // Update visual selection
    document.querySelectorAll("[data-action]").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");

    // Hanya select action, jangan otomatis jalan biar user bisa teken RUN
    const text = commandInput.value.trim();
    if (!text) {
      commandInput.focus();
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




/* --- Short Market Logic --- */
const btnShortMarket = document.querySelector("#btnShortMarket");
const shortMarketPanel = document.querySelector("#shortMarketPanel");
const btnRefreshShortMarket = document.querySelector("#btnRefreshShortMarket");
const btnBulkAddQueue = document.querySelector("#btnBulkAddQueue");
const bulkAddDropdown = document.querySelector("#bulkAddDropdown");
const btnConfirmBulkAdd = document.querySelector("#btnConfirmBulkAdd");
const inputBulkCount = document.querySelector("#inputBulkCount");
const selectBulkStart = document.querySelector("#selectBulkStart");
const btnCheckShortCondition = document.querySelector("#btnCheckShortCondition");
const shortMarketList = document.querySelector("#shortMarketList");
const shortMarketStatus = document.querySelector("#shortMarketStatus");

const tabAssetBtc = document.querySelector("#tabAssetBtc");
const tabAssetEth = document.querySelector("#tabAssetEth");
const tabAssetDoge = document.querySelector("#tabAssetDoge");
const shortDurationSelect = document.querySelector("#shortDurationSelect");

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

// Short Market Panel is a permanent sidebar widget - auto-load on startup
if (btnShortMarket) {
  btnShortMarket.addEventListener("click", (e) => {
    e.stopPropagation();
    // Button just refreshes the data
    fetchShortMarkets();
    startShortRealtimeTimer();
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


if (btnCheckShortCondition) {
  btnCheckShortCondition.addEventListener("click", (e) => {
    e.stopPropagation();
    
    // Pass live BTC price from websocket if available
    const liveBTC = document.querySelector("#priceBTC")?.textContent.replace(/[^0-9.]/g, '');
    if (liveBTC && liveBTC !== "") {
      commandInput.value = `/shortcondition ${liveBTC}`;
    } else {
      commandInput.value = "/shortcondition";
    }
    
    runButton.click();
    
    // Optionally close the panel
    if (shortMarketPanel) {
      shortMarketPanel.style.display = "none";
      stopShortRealtimeTimer();
    }
  });
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
    isDragging = true;
    offsetX = e.clientX - queuePanel.getBoundingClientRect().left;
    offsetY = e.clientY - queuePanel.getBoundingClientRect().top;
    queuePanelHeader.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    
    // Karena panel berada di dalam container dengan position: relative, 
    // koordinat clientX/Y harus dikurangi dengan posisi offsetParent.
    let parentLeft = 0;
    let parentTop = 0;
    if (queuePanel.offsetParent) {
      const parentRect = queuePanel.offsetParent.getBoundingClientRect();
      parentLeft = parentRect.left;
      parentTop = parentRect.top;
    }

    queuePanel.style.left = `${e.clientX - parentLeft - offsetX}px`;
    queuePanel.style.top = `${e.clientY - parentTop - offsetY}px`;
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

window.handleDragStart = function(event, element) {
  const id = element.getAttribute("data-id");
  const url = element.getAttribute("data-url");
  const question = element.getAttribute("data-question");
  event.dataTransfer.setData("text/plain", JSON.stringify({ id, url, question }));
  element.style.opacity = "0.5";
};

window.handleDragEnd = function(event) {
  event.currentTarget.style.opacity = "1";
};

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
  
  // Ambil data market penuh dari list kalau ada, supaya bisa render jam
  const fullMarket = currentShortMarkets.find(m => m.id === marketData.id);
  const queueItem = fullMarket || marketData;
  
  analysisQueue.push(queueItem);
  renderQueue();
}

window.addCardToQueue = function(card) {
  if (!card) return;
  const id = card.getAttribute("data-id");
  const url = card.getAttribute("data-url");
  const question = card.getAttribute("data-question");
  if (id) addToQueue({ id, url, question });
};

function renderQueue() {
  if (!queueDropzone || !queueEmpty) return;
  
  const completed = analysisQueue.filter(m => m.snipeFired).length;
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
    let timeHtml = "";
    if (m.endDate) {
      const timeToClose = new Date(m.endDate).getTime() - Date.now();
      const isClosingSoon = timeToClose > 0 && timeToClose < 2 * 60 * 1000;
      const isClosed = timeToClose <= 0;
      let timeColor = isClosed ? "var(--text-tertiary)" : (isClosingSoon ? "var(--neon-amber)" : "var(--neon-green)");
      let timeText = isClosed ? "Closed" : Math.floor(timeToClose / 60000) + "m " + Math.floor((timeToClose % 60000) / 1000) + "s";
      
      const pYes = m.outcomePrices && m.outcomePrices[0] ? Math.round(m.outcomePrices[0] * 100) : 0;
      const pNo = m.outcomePrices && m.outcomePrices[1] ? Math.round(m.outcomePrices[1] * 100) : 0;
      const lYes = m.outcomes && m.outcomes[0] ? m.outcomes[0] : "UP";
      const lNo = m.outcomes && m.outcomes[1] ? m.outcomes[1] : "DOWN";

      timeHtml = `<span class="btc5m-timer" data-end-date="${m.endDate}" data-p-yes="${pYes}" data-p-no="${pNo}" data-l-yes="${lYes}" data-l-no="${lNo}" style="color:${timeColor}; font-weight:bold; font-size:9px; margin-left:8px; flex-shrink:0;">${timeText}</span>`;
    }

    let sniperStatus = "";
    if (m.isFailed) {
      sniperStatus = `<span title="Analisis Gagal" style="color:var(--neon-red); font-size:9px; border:1px solid var(--neon-red); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="alert-triangle" style="width:8px; height:8px; margin-right:4px;"></i> Failed</span>`;
    } else if (isSniperActive && !m.snipeFired && !m.isTooLate) {
      sniperStatus = `<span style="color:var(--neon-amber); font-size:9px; border:1px solid var(--neon-amber); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">Wait</span>`;
    } else if (m.isTooLate) {
      sniperStatus = `<span title="Terlewat (Sisa < 1m30s)" style="color:var(--neon-red); font-size:9px; border:1px solid var(--neon-red); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="x-circle" style="width:8px; height:8px; margin-right:4px;"></i> Skipped</span>`;
    } else if (m.snipeFired) {
      if (m.isLateFired) {
        sniperStatus = `<span title="Dipaksa karena waktu minimum sudah lewat" style="color:var(--neon-cyan); font-size:9px; border:1px solid var(--neon-cyan); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="clock-4" style="width:8px; height:8px; margin-right:4px;"></i> Forced</span>`;
      } else {
        sniperStatus = `<span style="color:var(--text-tertiary); font-size:9px; border:1px solid var(--border-bright); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">Fired</span>`;
      }
    }

    // Ambil hasil dari history jika ada
    const historyItem = allHistoryEvents ? allHistoryEvents.find(e => e.market_id === m.id) : null;
    let predictionBadge = "";
    let resultBadge = "";
    if (historyItem) {
      if (historyItem.prediction) {
        const p = historyItem.prediction.toUpperCase();
        const pColor = (p === 'UP' || p === 'YES') ? 'var(--neon-green)' : ((p === 'DOWN' || p === 'NO') ? 'var(--neon-red)' : 'var(--text-tertiary)');
        predictionBadge = `<span title="Prediksi AI" style="color:${pColor}; font-weight:bold; font-size:9px; border:1px solid ${pColor}; border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="bot" style="width:10px; height:10px; margin-right:4px;"></i> ${p}</span>`;
      }
      if (historyItem.result && historyItem.result !== 'menunggu hasil') {
        const r = historyItem.result.toUpperCase();
        const rColor = (r === 'MENANG') ? 'var(--neon-green)' : ((r === 'KALAH') ? 'var(--neon-red)' : ((r === 'NETRAL') ? 'var(--neon-amber)' : 'var(--text-tertiary)'));
        resultBadge = `<span title="Hasil Aktual" style="color:${rColor}; font-weight:bold; font-size:9px; border:1px solid ${rColor}; border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0; display:inline-flex; align-items:center;"><i data-lucide="flag" style="width:10px; height:10px; margin-right:4px;"></i> ${r}</span>`;
        // Jika sudah ada hasil, timer tidak perlu muncul lagi
        timeHtml = "";
      }
      // Sembunyikan status Fired kalau hasil analisis sudah keluar agar tidak penuh
      if (predictionBadge) sniperStatus = "";
    }

    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:rgba(0,0,0,0.2); border:1px solid rgba(16,185,129,0.2); border-radius:4px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex:1; overflow:hidden;">
          <span style="font-size:10px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">[${index+1}] ${m.question}</span>
          ${sniperStatus}
          ${predictionBadge}
          ${resultBadge}
          ${timeHtml}
        </div>
        <button type="button" onclick="removeFromQueue('${m.id}')" style="background:none; border:none; color:var(--neon-red); cursor:pointer; padding:2px; margin-left:8px;"><i data-lucide="x" style="width:10px; height:10px;"></i></button>
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
  renderQueue();
};

if (btnClearQueue) {
  btnClearQueue.addEventListener("click", () => {
    analysisQueue = [];
    if (isSniperActive) toggleSniper();
    renderQueue();
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
    // Only re-render if the panel is actually visible to save CPU
    if (queuePanel && queuePanel.style.display !== "none") {
      renderQueue();
    }
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

function startSniper() {
  if (sniperInterval) clearInterval(sniperInterval);
  sniperInterval = setInterval(() => {
    let triggered = false;
    
    const min5 = document.querySelector("#set5mMin");
    const sec5 = document.querySelector("#set5mSec");
    const min15 = document.querySelector("#set15mMin");
    const sec15 = document.querySelector("#set15mSec");
    const min1h = document.querySelector("#set1hMin");
    const sec1h = document.querySelector("#set1hSec");
    
    const val5m = ((min5 && min5.value ? parseInt(min5.value) : 4) * 60) + (sec5 && sec5.value ? parseInt(sec5.value) : 45);
    const val15m = ((min15 && min15.value ? parseInt(min15.value) : 13) * 60) + (sec15 && sec15.value ? parseInt(sec15.value) : 30);
    const val1h = ((min1h && min1h.value ? parseInt(min1h.value) : 55) * 60) + (sec1h && sec1h.value ? parseInt(sec1h.value) : 0);
    
    // 1. Cek market mana saja yang sudah masuk sweet spot
    analysisQueue.forEach(m => {
      if (!m.snipeFired && m.endDate) {
        const timeToClose = new Date(m.endDate).getTime() - Date.now();
        let durationLimit = val5m * 1000;
        if (m.duration_type === '15m') durationLimit = val15m * 1000;
        else if (m.duration_type === '1h') durationLimit = val1h * 1000;
        // Fire when time is exactly at limit atau kurang, dan belum ditutup
        if (timeToClose > 0 && timeToClose <= durationLimit) {
          if (timeToClose < 90000) {
            // Jika kurang dari 1m 30s (90,000 ms), batal analisa karena udah mau closing (telat jauh)
            m.snipeFired = true;
            m.isTooLate = true;
            triggered = true;
            const title = m.groupItemTitle || m.question.replace(new RegExp(`${activeShortAsset} Up or Down -? ?`, 'i'), '').trim();
            showCustomAlert(`Analisis dibatalkan: Sisa waktu "${title}" kurang dari 1m 30s.`);
          } else {
            // Jika dieksekusi lebih dari 10 detik telat dari duration target, anggap Forced
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
    if (!busy && sniperExecutionQueue.length > 0) {
      // Ambil maksimal 10 tembakan sekaligus
      const urlsToShoot = sniperExecutionQueue.splice(0, 10);
      const commandStr = urlsToShoot.length === 1 
        ? "/analyze " + urlsToShoot[0]
        : "/analyzequeue " + urlsToShoot.join(",");
        
      executeCommand(commandStr, true); // Eksekusi di background, jangan paksa pindah tab
    }
    
    // 3. Auto-stop jika semua market di antrean sudah ditembak & dieksekusi
    if (isSniperActive && analysisQueue.length > 0) {
      const allFired = analysisQueue.every(m => m.snipeFired);
      if (allFired && sniperExecutionQueue.length === 0 && !busy) {
        toggleSniper();
      }
    }
  }, 1000);
}

function stopSniper() {
  if (sniperInterval) clearInterval(sniperInterval);
  sniperInterval = null;
}

function toggleSniper() {
  isSniperActive = !isSniperActive;
  if (isSniperActive) {
    btnRunQueue.innerHTML = `<i data-lucide="square" class="btn-icon" style="width:12px; height:12px;"></i> Stop Sniper`;
    btnRunQueue.style.background = "rgba(245, 158, 11, 0.5)";
    btnRunQueue.style.color = "#fff";
    startSniper();
  } else {
    btnRunQueue.innerHTML = `<i data-lucide="play" class="btn-icon" style="width:12px; height:12px;"></i> Start Sniper & Queue`;
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
  
  let html = "";
  let total = 0;
  let upCount = 0;
  let downCount = 0;
  
  analysisQueue.forEach(m => {
    const historyItem = allHistoryEvents.find(h => String(h.market_id) === String(m.id));
    let title = m.groupItemTitle || m.question.replace(new RegExp(`(Bitcoin|Ethereum|Dogecoin) Up or Down -? ?`, 'i'), '').trim();
    
    if (historyItem) {
      total++;
      if (historyItem.prediction === 'UP') upCount++;
      if (historyItem.prediction === 'DOWN') downCount++;
      
      let dirColor = "var(--text-secondary)";
      let dirBg = "rgba(255,255,255,0.05)";
      if (historyItem.prediction === 'UP') {
         dirColor = "var(--neon-green)";
         dirBg = "rgba(16,185,129,0.1)";
      } else if (historyItem.prediction === 'DOWN') {
         dirColor = "var(--neon-red)";
         dirBg = "rgba(239,68,68,0.1)";
      }
      
      let gradeStr = '-';
      if (historyItem.grades) {
         try {
           const g = typeof historyItem.grades === 'string' ? JSON.parse(historyItem.grades) : historyItem.grades;
           gradeStr = `S:${g.S||0} A:${g.A||0} B:${g.B||0} C:${g.C||0}`;
         } catch(e) {}
      }
      
      html += `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <td style="padding:10px 16px;">
            <div style="font-weight:600; color:#fff;">${title}</div>
            <div style="font-size:10px; color:var(--text-tertiary); margin-top:2px;">${m.id}</div>
          </td>
          <td style="padding:10px 16px; text-align:center;">
            <span style="background:${dirBg}; color:${dirColor}; padding:4px 8px; border-radius:4px; font-weight:bold; font-size:11px;">${historyItem.prediction || '-'}</span>
          </td>
          <td style="padding:10px 16px; text-align:center; font-family:monospace; color:var(--neon-amber);">${historyItem.confluence_score ? historyItem.confluence_score + '%' : '-'}</td>
          <td style="padding:10px 16px; text-align:center;">
             <span style="color:var(--text-secondary); font-size:11px; background:rgba(255,255,255,0.02); padding:4px 6px; border-radius:4px;">${gradeStr}</span>
          </td>
        </tr>
      `;
    } else {
      html += `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05); opacity:0.5;">
          <td style="padding:10px 16px;">
            <div style="font-weight:600; color:#fff;">${title}</div>
          </td>
          <td style="padding:10px 16px; text-align:center;">-</td>
          <td style="padding:10px 16px; text-align:center;">-</td>
          <td style="padding:10px 16px; text-align:center;">Belum Dianalisis / Gagal</td>
        </tr>
      `;
    }
  });
  
  if (html === "") {
    html = `<tr><td colspan="4" style="padding:20px; text-align:center; color:var(--text-tertiary);">Tidak ada data summary.</td></tr>`;
  }
  
  tbody.innerHTML = html;
  
  if (metrics) {
    metrics.innerHTML = `
      <div style="background:rgba(0,0,0,0.2); border:1px solid var(--border); padding:8px 12px; border-radius:6px; flex:1;">
        <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Total Analyzed</div>
        <div style="font-size:18px; font-weight:bold; color:#fff;">${total}</div>
      </div>
      <div style="background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.2); padding:8px 12px; border-radius:6px; flex:1;">
        <div style="font-size:10px; color:var(--neon-green); text-transform:uppercase;">UP Signals</div>
        <div style="font-size:18px; font-weight:bold; color:var(--neon-green);">${upCount}</div>
      </div>
      <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.2); padding:8px 12px; border-radius:6px; flex:1;">
        <div style="font-size:10px; color:var(--neon-red); text-transform:uppercase;">DOWN Signals</div>
        <div style="font-size:18px; font-weight:bold; color:var(--neon-red);">${downCount}</div>
      </div>
    `;
  }
  
  modal.style.display = "flex";
  if (typeof lucide !== 'undefined') lucide.createIcons();
  
  // Wire up the copy button
  const btnCopy = document.getElementById("btnCopySniperSummary");
  if (btnCopy) {
    btnCopy.onclick = () => {
      let txt = "Sniper Session Summary:\n";
      txt += `Total: ${total} | UP: ${upCount} | DOWN: ${downCount}\n\n`;
      analysisQueue.forEach(m => {
        let title = m.groupItemTitle || m.question.replace(new RegExp(`(Bitcoin|Ethereum|Dogecoin) Up or Down -? ?`, 'i'), '').trim();
        const historyItem = allHistoryEvents.find(h => String(h.market_id) === String(m.id));
        if (historyItem) {
           txt += `- ${title}: ${historyItem.prediction} (${historyItem.confluence_score ? historyItem.confluence_score + '%' : ''})\n`;
        } else {
           txt += `- ${title}: FAILED/WAITING\n`;
        }
      });
      navigator.clipboard.writeText(txt);
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

const btnBulkAddShort = document.querySelector("#btnBulkAddShort");

if (btnBulkAddShort && bulkAddDropdown) {
  btnBulkAddShort.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = bulkAddDropdown.style.display === "none";
    bulkAddDropdown.style.display = isHidden ? "flex" : "none";
    
    const selectBulkStart = document.querySelector("#selectBulkStart");
    const customBulkStartDisplay = document.querySelector("#customBulkStartDisplay");
    const customBulkStartText = document.querySelector("#customBulkStartText");
    const customBulkStartOptions = document.querySelector("#customBulkStartOptions");

    if (isHidden && customBulkStartOptions && customBulkStartText && selectBulkStart) {
      customBulkStartOptions.innerHTML = "";
      
      let durationLimit = 5 * 60 * 1000;
      if (activeShortDuration === '15m') durationLimit = 15 * 60 * 1000;
      else if (activeShortDuration === '1h') durationLimit = 60 * 60 * 1000;

      const validMarkets = currentShortMarkets.filter(m => {
        if (m.duration_type && m.duration_type !== activeShortDuration) return false;
        const timeToClose = new Date(m.endDate).getTime() - Date.now();
        return timeToClose > 0;
      });

      validMarkets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
      
      if (validMarkets.length === 0) {
        customBulkStartOptions.innerHTML = `<div style="padding:8px; font-size:11px; color:var(--text-tertiary); text-align:center;">Tidak ada market valid</div>`;
        customBulkStartText.textContent = "Tidak ada market valid";
        selectBulkStart.value = "0";
      } else {
        validMarkets.forEach((m, index) => {
          const rawTitle = m.groupItemTitle || m.question || "";
          const cleanTitle = rawTitle.replace(/(Bitcoin|BTC|Ethereum|ETH|Dogecoin|DOGE) Up or Down -? ?/i, '').trim() || "Unknown Event";
          
          const optDiv = document.createElement("div");
          optDiv.style.padding = "8px 10px";
          optDiv.style.fontSize = "11px";
          optDiv.style.color = "var(--text-primary)";
          optDiv.style.cursor = "pointer";
          optDiv.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
          optDiv.style.transition = "background 0.2s, color 0.2s";
          optDiv.textContent = cleanTitle;
          optDiv.onmouseover = () => { optDiv.style.background = "var(--bg-elevated)"; optDiv.style.color = "var(--neon-purple)"; };
          optDiv.onmouseout = () => { optDiv.style.background = "transparent"; optDiv.style.color = "var(--text-primary)"; };
          optDiv.onclick = (e) => {
            e.stopPropagation();
            customBulkStartText.textContent = cleanTitle;
            selectBulkStart.value = index;
            customBulkStartOptions.style.display = "none";
            if (customBulkStartDisplay) customBulkStartDisplay.style.borderColor = "var(--border-bright)";
          };
          
          if (index === 0) {
            customBulkStartText.textContent = cleanTitle;
            selectBulkStart.value = index;
          }
          
          customBulkStartOptions.appendChild(optDiv);
        });
      }
    }
  });
  
  const customBulkStartDisplay = document.querySelector("#customBulkStartDisplay");
  const customBulkStartOptions = document.querySelector("#customBulkStartOptions");
  if (customBulkStartDisplay && customBulkStartOptions) {
    customBulkStartDisplay.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOptionsHidden = customBulkStartOptions.style.display === "none" || customBulkStartOptions.style.display === "";
      customBulkStartOptions.style.display = isOptionsHidden ? "flex" : "none";
      customBulkStartDisplay.style.borderColor = isOptionsHidden ? "var(--neon-purple)" : "var(--border-bright)";
    });
  }
  
  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (!bulkAddDropdown.contains(e.target) && e.target !== btnBulkAddShort && !btnBulkAddShort.contains(e.target)) {
      bulkAddDropdown.style.display = "none";
    }
    if (customBulkStartOptions && customBulkStartDisplay && !customBulkStartDisplay.contains(e.target) && !customBulkStartOptions.contains(e.target)) {
      customBulkStartOptions.style.display = "none";
      customBulkStartDisplay.style.borderColor = "var(--border-bright)";
    }
  });
}

if (btnConfirmBulkAdd && inputBulkCount) {
  btnConfirmBulkAdd.addEventListener("click", () => {
    bulkAddDropdown.style.display = "none";
    if (!currentShortMarkets || currentShortMarkets.length === 0) {
      showCustomAlert("Tidak ada market yang tersedia untuk ditambahkan.");
      return;
    }
    const countStr = inputBulkCount.value;
    const skipStr = selectBulkStart ? selectBulkStart.value : "0";
    if (!countStr) return;
    const count = parseInt(countStr);
    const skip = parseInt(skipStr) || 0;
    if (isNaN(count) || count <= 0) {
      showCustomAlert("Jumlah tidak valid.");
      return;
    }

    let durationLimit = 5 * 60 * 1000;
    if (activeShortDuration === '15m') durationLimit = 15 * 60 * 1000;
    else if (activeShortDuration === '1h') durationLimit = 60 * 60 * 1000;
    else if (activeShortDuration === '4h') durationLimit = 4 * 60 * 60 * 1000;
    else if (activeShortDuration === '1d') durationLimit = 24 * 60 * 60 * 1000;

    const validMarkets = currentShortMarkets.filter(m => {
      if (m.duration_type && m.duration_type !== activeShortDuration) return false;
      const timeToClose = new Date(m.endDate).getTime() - Date.now();
      return timeToClose > 0;
    });

    validMarkets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

    const toAdd = validMarkets.slice(skip, skip + Math.min(count, 50));
    let addedCount = 0;
    for (const m of toAdd) {
      if (!analysisQueue.some(q => String(q.id) === String(m.id))) {
        if (analysisQueue.length >= 50) break;
        analysisQueue.push(m);
        addedCount++;
      }
    }
    
    if (addedCount > 0) {
      renderQueue();
      showCustomAlert(`Berhasil menambahkan ${addedCount} market ke antrean.`);
      
      // Auto-open Queue Panel
      const queuePanel = document.querySelector("#queuePanel");
      if (queuePanel && (queuePanel.style.display === "none" || queuePanel.style.display === "")) {
        queuePanel.style.display = "flex";
        document.body.classList.add("queue-open");
      }
      
      // Auto-start Sniper
      const btnRunQueue = document.querySelector("#btnRunQueue");
      if (btnRunQueue && typeof isSniperActive !== 'undefined' && !isSniperActive) {
        btnRunQueue.click();
      }
      
      if (typeof queueDropzone !== 'undefined' && queueDropzone) {
        queueDropzone.scrollIntoView({ behavior: 'smooth' });
      }
    } else {
      showCustomAlert("Tidak ada market baru yang ditambahkan (antrean mungkin sudah penuh atau market sudah ada).");
    }
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
      shortMarketList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--neon-red);"><i data-lucide="wifi-off" style="width:24px; height:24px; margin-bottom:8px;"></i><br><b>Gagal memuat data.</b><br><br><span style="font-size:10px; color:var(--text-tertiary);">Error: ${error.message}<br>Kemungkinan penyebab:<br>1. Jaringan terputus<br>2. Server backend mati/restart<br>3. Blocked by browser extension</span></div>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  // Auto refresh if panel is open
  if (shortMarketPanel && shortMarketPanel.style.display === "block") {
    if (shortMarketTimer) clearTimeout(shortMarketTimer);
    shortMarketTimer = setTimeout(fetchShortMarkets, 60000); // 60 detik (SSE handles live prices)
  }
}

const queueBtnStyle = document.createElement('style');
queueBtnStyle.textContent = `
  body:not(.queue-open) .btn-add-to-queue { display: none !important; }
  body.queue-open .btn-add-to-queue { display: flex !important; }
`;
document.head.appendChild(queueBtnStyle);

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
    const cardHoverBorder = isFuture ? "rgba(255,255,255,0.1)" : (isLockedOut ? "rgba(220,38,38,0.4)" : "rgba(245,158,11,0.3)");
    const onClickAttr = isClosed 
      ? `onclick="showCustomAlert('Event sudah ditutup dan tidak dapat dianalisis lagi.')"` 
      : isFuture 
        ? `onclick="showCustomAlert('Market belum aktif. Drag ke antrean (Sniper) untuk dianalisis otomatis nanti.')"` 
        : isLockedOut
          ? `onclick="showCustomAlert('Waktu tersisa kurang dari 1 menit! Market sudah dikunci (locked out) dan terlalu berisiko untuk dibeli.')"`
          : `onclick="analyzeShortMarket('${m.id}', '${m.url}')"`;
    const onDragAttr = (isClosed || isLockedOut) 
      ? `draggable="false"` 
      : `draggable="true" ondragstart="handleDragStart(event, this)" ondragend="handleDragEnd(event)"`;

    let priceInfo = "";


    const isSnipeBtn = isFuture;
    const btnClass = isSnipeBtn ? "btn-snipe-market" : "btn-add-to-queue";
    const btnDisplay = isSnipeBtn ? "flex" : "none";
    const btnIcon = isSnipeBtn ? "crosshair" : "plus"; 
    const btnTitle = isSnipeBtn ? "Snipe Market (Auto-Analyze when active)" : "Add to Queue";
    const btnColor = isSnipeBtn ? "var(--neon-amber)" : "var(--text-secondary)";
    
    const addBtnHtml = !isClosed ? `<button class="${btnClass}" style="display:${btnDisplay}; height:20px; width:20px; padding:0; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.05); color:${btnColor}; cursor:pointer; align-items:center; justify-content:center; margin-left:8px; flex-shrink:0; transition:all 0.2s;" onmouseover="this.style.background='rgba(245,158,11,0.2)'; this.style.color='var(--neon-amber)'; this.style.borderColor='rgba(245,158,11,0.5)';" onmouseout="this.style.background='rgba(255,255,255,0.05)'; this.style.color='${btnColor}'; this.style.borderColor='rgba(255,255,255,0.1)';" onclick="event.stopPropagation(); window.addCardToQueue(this.closest('.btc5m-card')); if('${btnClass}' === 'btn-snipe-market') { this.innerHTML='<i data-lucide=&quot;loader&quot; style=&quot;width:12px; height:12px; animation: spin 2s linear infinite;&quot;></i>'; if(typeof lucide !== 'undefined') lucide.createIcons({root:this}); this.style.pointerEvents='none'; this.style.color='var(--neon-green)'; this.style.borderColor='rgba(16,185,129,0.5)'; showCustomAlert('🎯 Market dimasukkan ke antrean Sniper!'); }" title="${btnTitle}"><i data-lucide="${btnIcon}" style="width:12px; height:12px;"></i></button>` : '';

    return `
      <div class="btc5m-card" ${onDragAttr} data-id="${m.id}" data-url="${m.url}" data-question="${(m.question || '').replace(/"/g, '&quot;')}" style="padding:8px 10px; border:1px solid ${cardBorder}; border-radius:4px; background:${cardBg}; opacity:${cardOpacity}; cursor:${cardCursor}; transition:all 0.2s;" ${isFuture ? '' : `onmouseover="this.style.background='rgba(255,255,255,0.05)'; this.style.borderColor='${cardHoverBorder}';" onmouseout="this.style.background='${cardBg}'; this.style.borderColor='${cardBorder}';"`} ${onClickAttr}>
        <div style="display:flex; justify-content:space-between; margin-bottom:4px; align-items:flex-start;">
          <span style="font-weight:600; color:var(--text-primary); font-size:11px; flex:1; min-width:0; word-wrap:break-word;">${(m.groupItemTitle || m.question || '').trim()}</span>
          <div style="display:flex; align-items:center;">
            <span class="short-market-timer" data-end-date="${m.endDate}" data-p-yes="${pYes}" data-p-no="${pNo}" data-l-yes="${labelYes}" data-l-no="${labelNo}" data-is-future="${isFuture}" style="color:${timeColor}; font-weight:700; font-size:10px; white-space:nowrap; flex-shrink:0; text-align:right; margin-left:8px;">${timeText}</span>
            ${addBtnHtml}
          </div>
        </div>
        ${priceInfo}
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; gap:8px;">
            <span style="color:var(--neon-green); font-size:10px;">${labelYes}: ${pYes}c</span>
            <span style="color:var(--neon-red); font-size:10px;">${labelNo}: ${pNo}c</span>
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
      if (prevIsFuture !== isFuture && shortMarketsCache && shortMarketsCache.length > 0) {
        // State has changed from future to active! 
        // We must re-render so that buttons and click handlers are updated.
        renderShortMarkets(shortMarketsCache);
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
  const input = document.querySelector("#commandInput");
  if (input) {
    input.value = url || marketId;
    // Set action to analyze and trigger click
    const btnAnalyze = document.querySelector("#btnAnalyze");
    if (btnAnalyze) {
      btnAnalyze.click();
      setTimeout(() => {
        const btnRun = document.querySelector("#runButton");
        if (btnRun) btnRun.click();
      }, 100);
    }
  }
};

/* --- Analyzed Events History --- */
const historyModal = document.querySelector("#historyModal");
const btnHistory = document.querySelector("#btnHistory");
const btnManual = document.querySelector("#btnManual");
const closeHistoryModal = document.querySelector("#closeHistoryModal");
const manualModal = document.querySelector("#manualModal");
const closeManualModal = document.querySelector("#closeManualModal");
const historyTableBody = document.querySelector("#historyTableBody");
const btnCheckAllHistory = document.querySelector("#btnCheckAllHistory");
const btnEvaluateAllHistory = document.querySelector("#btnEvaluateAllHistory");
let allHistoryEvents = [];
let currentHistoryAsset = "all";
let currentHistoryDuration = "all";
const excludeNeutralBtn = document.querySelector("#excludeNeutralBtn");
if (excludeNeutralBtn) {
  // Checkbox is removed from UI, but handle if it still exists in some cache
  excludeNeutralBtn.style.display = "none";
}

if (btnHistory && historyModal && closeHistoryModal) {
  btnHistory.addEventListener("click", () => {
    historyModal.style.display = "flex";
    const smp = document.querySelector("#shortMarketPanel");
    if (smp) smp.style.display = "none";
    fetchHistoryEvents();
  });

  closeHistoryModal.addEventListener("click", () => {
    historyModal.style.display = "none";
    const smp = document.querySelector("#shortMarketPanel");
    if (smp) smp.style.display = "flex";
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

  if (btnEvaluateAllHistory) {
    btnEvaluateAllHistory.addEventListener("click", async () => {
      const pendingEvals = allHistoryEvents.filter(e => e.result === 'kalah' && !e.has_reflection);
      if (pendingEvals.length === 0) {
        showCustomAlert("Tidak ada market kalah yang perlu dievaluasi.");
        return;
      }
      
      const estimatedTokens = pendingEvals.length * 1500;
      if (!confirm(`Akan mengevaluasi ${pendingEvals.length} market.\nEstimasi token Qwen yang digunakan: ~${estimatedTokens} token.\n\nLanjutkan?`)) {
        return;
      }
      
      btnEvaluateAllHistory.disabled = true;
      const originalText = btnEvaluateAllHistory.innerHTML;
      btnEvaluateAllHistory.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px; height:14px;"></i> Mengevaluasi ${pendingEvals.length}...`;
      if (typeof lucide !== 'undefined') lucide.createIcons();

      let evaluatedCount = 0;
      for (const event of pendingEvals) {
        try {
          await fetch("/api/evaluate/single", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ eventId: event.id })
          });
          evaluatedCount++;
          btnEvaluateAllHistory.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px; height:14px;"></i> Mengevaluasi ${pendingEvals.length - evaluatedCount}...`;
          if (typeof lucide !== 'undefined') lucide.createIcons();
        } catch (err) {
          console.error("Error evaluating event", event.id, err);
        }
      }
      
      btnEvaluateAllHistory.innerHTML = originalText;
      btnEvaluateAllHistory.disabled = false;
      if (typeof lucide !== 'undefined') lucide.createIcons();
      
      fetchHistoryEvents();
      showCustomAlert(`Selesai mengevaluasi ${evaluatedCount} market.`);
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
    document.getElementById("historyLimit").value = "100";
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

function applyHistoryFilter() {
  let filtered = allHistoryEvents;
  
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
      container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--neon-red);"><i data-lucide="wifi-off" style="width:24px; height:24px; margin-bottom:8px;"></i><br><b>Gagal memuat riwayat.</b><br><br><span style="font-size:10px; color:var(--text-tertiary);">Error: ${error.message}<br>Kemungkinan penyebab:<br>1. Jaringan terputus<br>2. Server backend mati/restart<br>3. Adblocker memblokir request</span></div>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Relocate modals to body to escape z-index and overflow clipping
  const modalsToMove = ["themePanelModal", "historyModal", "manualModal"];
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
      const r = event.result.toUpperCase();
      const rColor = (r === 'MENANG') ? 'var(--neon-green)' : ((r === 'KALAH') ? 'var(--neon-red)' : ((r === 'NETRAL') ? 'var(--neon-amber)' : 'var(--text-tertiary)'));
      resultBadge = `<span title="Hasil Aktual" style="color:${rColor}; font-weight:bold; font-size:9px; border:1px solid ${rColor}; border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="flag" style="width:10px; height:10px; margin-right:4px;"></i> ${r}</span>`;
    }

    const pColor = (event.prediction === 'UP' || event.prediction === 'YES') ? 'var(--neon-green)' : ((event.prediction === 'DOWN' || event.prediction === 'NO') ? 'var(--neon-red)' : 'var(--text-tertiary)');
    const predBadge = `<span title="Prediksi AI" style="color:${pColor}; font-weight:bold; font-size:9px; border:1px solid ${pColor}; border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="bot" style="width:10px; height:10px; margin-right:4px;"></i> ${event.prediction || '?'}</span>`;

    html += `
      <div onclick="showHistoryChat(${event.id})" style="padding:10px; border:1px solid rgba(255,255,255,0.05); border-radius:6px; background:rgba(0,0,0,0.2); cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'; this.style.borderColor='var(--neon-purple)';" onmouseout="this.style.background='rgba(0,0,0,0.2)'; this.style.borderColor='rgba(255,255,255,0.05)';">
        <div style="display:flex; justify-content:flex-start; align-items:center; gap:12px; margin-bottom:6px;">
          <span style="font-size:10px; color:var(--text-tertiary); white-space:nowrap; min-width:max-content;">${dateStr} ${timeStr}</span>
          <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-start;">
            ${predBadge}
            ${resultBadge}
            ${event.qwen_confidence ? `<span title="Qwen Confidence" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;">Q: ${event.qwen_confidence}</span>` : ''}
            ${event.data_confidence ? `<span title="Data Confidence" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;">D: ${event.data_confidence}</span>` : ''}
            ${event.execution_time ? `<span title="Execution Time" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="timer" style="width:8px; height:8px; margin-right:4px;"></i>${event.execution_time}s</span>` : ''}
          </div>
        </div>
        <div style="font-size:11px; font-weight:600; color:var(--text-primary); line-height:1.3; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">
          ${(event.question || "")
              .replace(/Bitcoin/gi, 'BTC')
              .replace(/Ethereum/gi, 'ETH')
              .replace(/Dogecoin/gi, 'DOGE')
              .replace(/Solana/gi, 'SOL')
              .replace(/ Up or Down/gi, '')}
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons({ root: container });
}

window.showHistoryChat = function(eventId) {
  const event = allHistoryEvents.find(e => e.id === eventId);
  if (!event) return;
  
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
  const staticBody = document.getElementById("staticResultBody");
  if (staticPanel) {
    staticPanel.style.display = "flex";
    localStorage.setItem("market_summary_closed", "false"); // Ensure it stays open
  }
  
  if (staticBody && typeof buildBentoGrid === "function") {
    const aiText = event.analysis_conclusion || "";
    staticBody.innerHTML = buildBentoGrid(aiText, true);
    if (window.lucide) window.lucide.createIcons({ root: staticBody });
    
    // Store archive report HTML for the global modal opener
    window._currentReportHtml = marked.parse(`## 🤖 ARCHIVED ANALYSIS\n\n**Market:** [${event.question}](${event.url})\n**Prediction:** ${event.prediction}\n**Result:** ${event.result}\n\n---\n\n${aiText}`);
  }
}

function renderHistoryEvents(events) {
  const limitInput = document.getElementById('historyLimit');
  const limit = limitInput ? (parseInt(limitInput.value) || 10) : 100;
  const displayEvents = events.slice(0, limit);

  const statsEvents = events.filter((event) => event.strategy_version === "deepseek-chainlink-guarded-v2");
  let total = statsEvents.length;
  let wins = 0;
  let losses = 0;
  let neutrals = 0;
  let pending = 0;

  let html = "";
  for (const event of statsEvents) {
    if (event.result === 'menang') wins++;
    else if (event.result === 'kalah') losses++;
    else if (event.result === 'netral') neutrals++;
    else pending++;
  }

  for (const event of displayEvents) {
    const statusColor = event.status === 'selesai' 
      ? (event.result === 'menang' ? 'var(--neon-green)' : (event.result === 'kalah' ? 'var(--neon-red)' : 'var(--neon-amber)')) 
      : 'var(--text-tertiary)';
    html += `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
        <td style="padding:10px 0;">
          <a href="${event.url}" target="_blank" style="color:var(--text-primary); text-decoration:none;">${event.question}</a>
        </td>
        <td style="padding:10px 0; color:var(--text-secondary); font-weight:bold;">
          ${event.prediction || '-'}
          ${event.actual_outcome ? `<div style="font-size:10px; color:var(--text-tertiary); margin-top:4px; font-weight:normal;">Realita: <span style="color:var(--text-primary);">${event.actual_outcome}</span></div>` : ''}
        </td>
        <td style="padding:10px 0; color:var(--text-tertiary); text-transform:capitalize;">${event.status}</td>
        <td style="padding:10px 0;">
          <span style="color:${statusColor}; font-weight:bold; text-transform:capitalize;">${event.result || '-'}</span>
          ${event.qwen_confidence ? `<div style="font-size:9px; color:var(--text-tertiary); margin-top:4px;">Qwen Conf: ${event.qwen_confidence}/100</div>` : ''}
          ${event.data_confidence ? `<div style="font-size:9px; color:var(--text-tertiary);">Data Conf: ${event.data_confidence}/100</div>` : ''}
          ${event.execution_time ? `<div style="font-size:9px; color:var(--text-tertiary); display:flex; align-items:center; justify-content:center; gap:4px;"><i data-lucide="timer" style="width:10px; height:10px;"></i> ${event.execution_time}s</div>` : ''}
        </td>
        <td style="padding:10px 0; text-align:right;">
          <button class="action-chip" style="height:24px; font-size:10px; padding:0 8px; ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? 'opacity:0.5; cursor:not-allowed;' : ''}" 
                  onclick="checkHistoryEvent(${event.id}, '${event.market_id}', '${event.prediction}')"
                  ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? 'disabled' : ''}>
            Periksa
          </button>
          ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? `
          <button class="action-chip" style="height:24px; font-size:10px; padding:0 8px; margin-left:4px; background:rgba(6,182,212,0.1); color:var(--neon-cyan); border:1px solid rgba(6,182,212,0.3);" 
                  onclick="showReasonModal(${event.id})">
            Reason
          </button>
          ` : ''}
          ${event.status === 'selesai' && event.result === 'kalah' && !event.has_reflection ? `
          <button class="action-chip" style="height:24px; font-size:10px; padding:0 8px; margin-left:4px; background:rgba(239,68,68,0.1); color:var(--neon-red); border:1px solid rgba(239,68,68,0.3);" 
                  onclick="evaluateSingleEventInline(${event.id}, this)">
            Evaluate
          </button>
          ` : ''}
          ${event.has_reflection ? `<span style="display:inline-block; margin-left:4px; font-size:9px; color:var(--neon-green); border:1px solid var(--neon-green); padding:2px 4px; border-radius:4px; background:rgba(16,185,129,0.1);"><i data-lucide="check-circle" style="width:10px; height:10px; vertical-align:middle; margin-right:2px;"></i>Telah Dipelajari</span>` : ''}
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
  document.querySelector("#historyNeutral").textContent = neutrals;
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

window.evaluateSingleEventInline = async function(eventId, btn) {
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = `<i data-lucide="loader" class="spin" style="width:10px; height:10px;"></i>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const res = await fetch("/api/evaluate/single", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId })
    });
    const data = await res.json();
    
    if (data.ok) {
      fetchHistoryEvents();
      showCustomAlert("✅ Evaluasi berhasil disimpan ke memori AI!");
    } else {
      showCustomAlert("Gagal mengevaluasi: " + data.error);
      btn.innerHTML = originalText;
      btn.disabled = false;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  } catch (err) {
    console.error(err);
    showCustomAlert("Terjadi kesalahan jaringan.");
    btn.innerHTML = originalText;
    btn.disabled = false;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
};

/* --- Reason & Evaluation Modal --- */
const reasonModal = document.querySelector("#reasonModal");
const closeReasonModal = document.querySelector("#closeReasonModal");
const reasonModalContent = document.querySelector("#reasonModalContent");
const reflectionContainer = document.querySelector("#reflectionContainer");
const reflectionText = document.querySelector("#reflectionText");
const evaluateBtnContainer = document.querySelector("#evaluateBtnContainer");
const btnEvaluateSingle = document.querySelector("#btnEvaluateSingle");
const evaluateAllBtn = document.querySelector("#evaluateAllBtn");

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

let currentEvaluatingEventId = null;

window.showReasonModal = async function(eventId) {
  const event = allHistoryEvents.find(e => e.id === eventId);
  if (!event) return;
  
  currentEvaluatingEventId = eventId;
  reasonModalContent.textContent = event.analysis_conclusion || "Tidak ada detail analisis tersimpan.";
  
  // Populate Event Result Details
  reasonPrediction.textContent = event.prediction || "-";
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
  } else if (event.result === 'netral') {
    reasonStatusBadge.textContent = "NETRAL";
    reasonStatusBadge.style.color = "var(--neon-amber)";
    reasonStatusBadge.style.borderColor = "var(--neon-amber)";
    reasonStatusBadge.style.background = "rgba(245, 158, 11, 0.1)";
  } else {
    reasonStatusBadge.textContent = (event.result || "-").toUpperCase();
    reasonStatusBadge.style.color = "var(--text-tertiary)";
    reasonStatusBadge.style.borderColor = "var(--text-tertiary)";
    reasonStatusBadge.style.background = "transparent";
  }
  
  reflectionContainer.style.display = "none";
  evaluateBtnContainer.style.display = "none";
  reflectionText.textContent = "";
  reasonModal.style.display = "flex";

  if (event.result === 'kalah') {
    // Check if reflection exists
    try {
      const res = await fetch(`/api/evaluate/reflection/${event.market_id}`);
      const data = await res.json();
      if (data.ok && data.reflection) {
        reflectionText.textContent = data.reflection;
        reflectionContainer.style.display = "block";
      } else {
        evaluateBtnContainer.style.display = "block";
      }
    } catch (err) {
      console.error("Failed to check reflection", err);
      evaluateBtnContainer.style.display = "block";
    }
  }
};

if (btnEvaluateSingle) {
  btnEvaluateSingle.addEventListener("click", async () => {
    if (!currentEvaluatingEventId) return;
    
    btnEvaluateSingle.disabled = true;
    btnEvaluateSingle.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px; height:14px; margin-right:6px;"></i> Mengevaluasi...`;
    lucide.createIcons();
    
    try {
      const res = await fetch("/api/evaluate/single", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId: currentEvaluatingEventId })
      });
      const data = await res.json();
      
      if (data.ok) {
        reflectionText.textContent = data.reflection;
        reflectionContainer.style.display = "block";
        evaluateBtnContainer.style.display = "none";
        
        // Refresh the table so "Telah Dipelajari" badge appears immediately
        fetchHistoryEvents();
        
        showCustomAlert("✅ Evaluasi berhasil disimpan ke memori AI!");
      } else {
        showCustomAlert("Gagal mengevaluasi: " + data.error);
      }
    } catch (err) {
      console.error(err);
      showCustomAlert("Terjadi kesalahan jaringan.");
    } finally {
      btnEvaluateSingle.disabled = false;
      btnEvaluateSingle.innerHTML = `<i data-lucide="alert-triangle" style="width:14px; height:14px; margin-right:6px;"></i> Evaluate Kesalahan`;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  });
}

/* --- Settings Modal --- */
const settingsModal = document.querySelector("#settingsModal");
const btnSettings = document.querySelector("#btnSettings");
const closeSettingsModal = document.querySelector("#closeSettingsModal");
const btnSaveSettings = document.querySelector("#btnSaveSettings");
const themeBtns = document.querySelectorAll(".theme-btn");
const toggleAudioBtn = document.querySelector("#toggleAudioBtn");
const settingsTabs = document.querySelectorAll(".settings-tab");
const settingsPanes = document.querySelectorAll(".settings-pane");
const chkShortMarketLearning = document.querySelector("#chkShortMarketLearning");
const botLanguageSelect = document.querySelector("#botLanguageSelect");

// Load Short Market Learning setting — sync dari backend
if (chkShortMarketLearning) {
  // Load state awal dari backend (sumber kebenaran)
  fetch("/api/settings/short-memory").then(r => r.json()).then(d => {
    if (d.ok) {
      chkShortMarketLearning.checked = d.enabled;
      localStorage.setItem("shortMarketLearningEnabled", d.enabled);
    }
  }).catch(() => {
    // fallback ke localStorage jika server belum siap
    chkShortMarketLearning.checked = localStorage.getItem("shortMarketLearningEnabled") !== "false";
  });

  // Load Bot Language
  if (botLanguageSelect) {
    botLanguageSelect.value = localStorage.getItem("botLanguage") || "Indonesia";
    applyLanguageUI(botLanguageSelect.value);
  }

  chkShortMarketLearning.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    localStorage.setItem("shortMarketLearningEnabled", enabled);
    fetch("/api/settings/short-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    }).catch(() => {}); // silent \u2014 toggle tetap responsif walau request gagal
  });
}

// Sniper Settings Inputs
const set5mMin = document.querySelector("#set5mMin");
const set5mSec = document.querySelector("#set5mSec");
const set15mMin = document.querySelector("#set15mMin");
const set15mSec = document.querySelector("#set15mSec");
const set1hMin = document.querySelector("#set1hMin");
const set1hSec = document.querySelector("#set1hSec");

// State

let currentTheme = localStorage.getItem("theme") || "default";

function applyTheme(theme) {
  currentTheme = theme;
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  
  themeBtns.forEach(btn => {
    if (btn.dataset.theme === theme) {
      btn.classList.add("active");
      btn.style.boxShadow = `0 0 12px ${btn.style.color}`;
    } else {
      btn.classList.remove("active");
      btn.style.boxShadow = "none";
    }
  });
}


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

      const g = m.grades;
      if (g) {
        const ds = document.getElementById("dashGradeS");
        const da = document.getElementById("dashGradeA");
        const db = document.getElementById("dashGradeB");
        const dc = document.getElementById("dashGradeC");
        const dd = document.getElementById("dashGradeD");
        if(ds) ds.innerText = g.S;
        if(da) da.innerText = g.A;
        if(db) db.innerText = g.B;
        if(dc) dc.innerText = g.C;
        if(dd) dd.innerText = g.D;
      }

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

async function fetchReflections() {
  const learningList = document.querySelector("#learningList");
  if (!learningList) return;
  learningList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-tertiary); font-size:12px;"><i data-lucide="loader" class="spin" style="width:14px; height:14px;"></i> Memuat data...</div>`;
  if (typeof lucide !== "undefined") lucide.createIcons();
  try {
    const res = await fetch("/api/reflections");
    const data = await res.json();
    if (data.ok) {
      const totalReflections = data.reflections ? data.reflections.length : 0;
      const improvementPercent = Math.min(99, Math.round(totalReflections * 3.5));
      
      const pctLabel = document.querySelector("#improvementPercentage");
      const bar = document.querySelector("#improvementBar");
      if (pctLabel) pctLabel.textContent = improvementPercent + "%";
      if (bar) bar.style.width = improvementPercent + "%";

      if (totalReflections === 0) {
        learningList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-tertiary); font-size:12px;">Belum ada hasil pembelajaran (evaluasi).</div>`;
      } else {
        const extractCoreLesson = (text) => {
          if (!text) return "Tidak ada catatan.";
          const kw = "3. **Core Lesson Learned";
          const idx = text.indexOf(kw);
          if (idx !== -1) {
            let after = text.substring(idx + kw.length);
            const nl = after.indexOf('\\n');
            if (nl !== -1) after = after.substring(nl + 1).trim();
            return after.substring(0, 500);
          }
          return text.length > 300 ? "..." + text.substring(text.length - 300) : text;
        };

        learningList.innerHTML = data.reflections.map(r => `
          <div style="background:var(--bg-elevated); border:1px solid var(--border); padding:12px; border-radius:6px; display:flex; flex-direction:column; gap:6px;">
            <div style="font-weight:bold; color:var(--text-primary); font-size:12px;">Market: ${r.question}</div>
            <div style="font-size:11px; color:var(--text-secondary); line-height:1.4;"><strong>Prediction:</strong> ${r.prediction} | <strong>Actual:</strong> ${r.actual_outcome}</div>
            
            <div style="margin-top:4px; padding:8px; background:rgba(245,158,11,0.1); border-left:3px solid var(--neon-amber); border-radius:4px;">
              <div style="font-size:10px; color:var(--neon-amber); font-weight:bold; margin-bottom:4px; text-transform:uppercase;">Distilled Trap Memory</div>
              <div style="font-size:11px; color:var(--text-primary); line-height:1.4;">"${extractCoreLesson(r.reflection_note)}"</div>
            </div>

            <div style="margin-top:6px; padding-top:6px; border-top:1px dashed var(--border);">
              <button class="btn-detail-improvement" data-reflection="${encodeURIComponent(r.reflection_note)}" style="background:transparent; border:1px solid var(--neon-cyan); color:var(--neon-cyan); padding:4px 8px; border-radius:4px; font-size:10px; cursor:pointer; display:flex; align-items:center; gap:4px; transition:all 0.2s;">
                <i data-lucide="lightbulb" style="width:12px; height:12px;"></i>Lihat Full Evaluasi
              </button>
            </div>
          </div>
        `).join("");
        if (typeof lucide !== "undefined") lucide.createIcons();
        
          // Add listeners to new buttons
          document.querySelectorAll(".btn-detail-improvement").forEach(btn => {
            btn.addEventListener("click", (e) => {
              const reflection = decodeURIComponent(e.currentTarget.dataset.reflection);
              const contentDiv = document.querySelector("#improvementModalContent");
              if (contentDiv) {
                contentDiv.innerHTML = reflection.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\\n/g, '<br>');
              }
              document.querySelector("#improvementModal").style.display = "flex";
            });
          });
        }
      }
    } catch (err) {
      learningList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--neon-red); font-size:12px;">Gagal memuat data.</div>`;
      console.error("Failed to load reflections:", err);
    }
  }

  const btnViewMemoryPrompt = document.querySelector("#btnViewMemoryPrompt");
  if (btnViewMemoryPrompt) {
    btnViewMemoryPrompt.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/memory-checklist");
        const data = await res.json();
        if (data.ok) {
          const contentDiv = document.querySelector("#improvementModalContent");
          if (contentDiv) {
            contentDiv.innerHTML = "<div style='font-family:\"JetBrains Mono\", monospace; font-size:10px; white-space:pre-wrap;'>" + data.text + "</div>";
          }
          document.querySelector("#improvementModal").style.display = "flex";
        }
      } catch (e) {
        console.error(e);
        showCustomAlert("Gagal memuat kompilasi memori.");
      }
    });
  }


// Initial Setup
applyTheme(currentTheme);

// Learning Tabs Logic
const tabLearningEval = document.querySelector("#tabLearningEval");
const tabLearningShort = document.querySelector("#tabLearningShort");
const learningListContainer = document.querySelector("#learningListContainer");
const shortMemoryList = document.querySelector("#shortMemoryList");

if (tabLearningEval && tabLearningShort) {
  tabLearningEval.addEventListener("click", () => {
    tabLearningEval.style.background = "rgba(255,255,255,0.05)";
    tabLearningEval.style.color = "var(--text-primary)";
    tabLearningEval.style.borderBottomColor = "var(--neon-cyan)";
    
    tabLearningShort.style.background = "transparent";
    tabLearningShort.style.color = "var(--text-tertiary)";
    tabLearningShort.style.borderBottomColor = "transparent";
    
    if(learningListContainer) learningListContainer.style.display = "flex";
    if(shortMemoryList) shortMemoryList.style.display = "none";
  });
  
  tabLearningShort.addEventListener("click", () => {
    tabLearningShort.style.background = "rgba(255,255,255,0.05)";
    tabLearningShort.style.color = "var(--text-primary)";
    tabLearningShort.style.borderBottomColor = "var(--neon-cyan)";
    
    tabLearningEval.style.background = "transparent";
    tabLearningEval.style.color = "var(--text-tertiary)";
    tabLearningEval.style.borderBottomColor = "transparent";
    
    if(shortMemoryList) shortMemoryList.style.display = "flex";
    if(learningListContainer) learningListContainer.style.display = "none";
  });
}

async function fetchLearningHistory() {
  const list = document.getElementById("shortMemoryList");
  if (!list) return;
  try {
    const res = await fetch("/api/short-learning");
    const data = await res.json();
    if (data.ok && data.history.length > 0) {
      list.innerHTML = "";
      data.history.forEach((h, i) => {
        const item = document.createElement("div");
        item.style.background = "var(--bg-elevated)";
        item.style.padding = "12px 16px";
        item.style.borderRadius = "8px";
        item.style.border = "1px solid var(--border)";
        item.style.fontSize = "12px";
        item.style.color = "var(--text-secondary)";
        item.innerHTML = `
          <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
            <strong style="color:var(--text-primary);">Short Market Analysis #${data.history.length - i}</strong>
            <span style="font-family:'JetBrains Mono',monospace; opacity:0.6;">${new Date(h.date).toLocaleTimeString()}</span>
          </div>
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            <span style="background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px; font-weight:600; color:${h.condition === 'VOLATILE' ? 'var(--green)' : 'var(--neon-amber)'};">${h.condition}</span>
            <span style="background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px; font-weight:600;">${h.recommendation}</span>
          </div>
          <div style="line-height:1.4; font-size:11px; margin-bottom:8px;">${h.reason}</div>
          ${h.memory_reflection ? `<div style="padding-top:8px; border-top:1px dashed var(--border); color:var(--neon-cyan);"><strong style="font-size:10px; display:flex; align-items:center; gap:4px; margin-bottom:4px;"><i data-lucide="brain-circuit" style="width:12px; height:12px;"></i> AI Reflection on Memory</strong><div style="line-height:1.4;">${h.memory_reflection}</div></div>` : ''}
        `;
        list.appendChild(item);
      });
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
      list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-tertiary); font-size:12px;">Belum ada memori Vibe Check.</div>`;
    }
  } catch(e) {
    list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--red); font-size:12px;">Gagal memuat memori.</div>`;
  }
}

if (btnSettings && settingsModal) {
  btnSettings.addEventListener("click", () => {
    fetchStats();
    fetchReflections();
    fetchLearningHistory();
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
      m5: { min: set5mMin?.value || 4, sec: set5mSec?.value || 45 },
      m15: { min: set15mMin?.value || 13, sec: set15mSec?.value || 30 },
      h1: { min: set1hMin?.value || 55, sec: set1hSec?.value || 0 }
    };
    localStorage.setItem("sniperConfig", JSON.stringify(sniperConf));
    
    if (botLanguageSelect) {
      localStorage.setItem("botLanguage", botLanguageSelect.value);
      applyLanguageUI(botLanguageSelect.value);
    }
    
    settingsModal.style.display = "none";
    showCustomAlert("Settings tersimpan!");
  });
}

function loadSniperConfig() {
  try {
    const saved = localStorage.getItem("sniperConfig");
    if (saved) {
      const conf = JSON.parse(saved);
      if (set5mMin && conf.m5) { set5mMin.value = conf.m5.min; set5mSec.value = conf.m5.sec; }
      if (set15mMin && conf.m15) { set15mMin.value = conf.m15.min; set15mSec.value = conf.m15.sec; }
      if (set1hMin && conf.h1) { set1hMin.value = conf.h1.min; set1hSec.value = conf.h1.sec; }
    }
  } catch (err) {}
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

const closeImprovementModal = document.querySelector("#closeImprovementModal");
if (closeImprovementModal) {
  closeImprovementModal.addEventListener("click", () => {
    document.querySelector("#improvementModal").style.display = "none";
  });
}

const improvementModal = document.querySelector("#improvementModal");
if (improvementModal) {
  improvementModal.addEventListener("click", (e) => {
    if (e.target === improvementModal) improvementModal.style.display = "none";
  });
}

// Gunakan setActiveTab untuk memastikan state panel dan UI disinkronkan di awal
if (activeTabId) {
  setActiveTab(activeTabId);
} else {
  renderTabs();
  renderMessages();
}

updateInputDetection();
function applyLanguageUI(lang) {
  const translations = {
    English: {
      ".settings-tab[data-target='pane-language']": "Language",
      ".settings-tab[data-target='pane-alerts']": "Alerts & Audio",
      ".settings-tab[data-target='pane-sniper']": "Sniper Trigger",
      ".settings-tab[data-target='pane-analytics']": "Analytics",
      ".settings-tab[data-target='pane-learning']": "Learning Process",
      "#pane-language h2": "Language",
      "#pane-language p": "Select the language Qwen will use for analysis responses.",
      "#pane-alerts h2": "Alerts & Audio",
      "#pane-alerts p": "Configure system notifications and sound alerts.",
      "#pane-sniper h2": "Sniper Trigger Timing",
      "#pane-sniper p": "How many minutes/seconds before market close should Qwen trigger?",
      "#pane-analytics h2": "Analytics Stats",
      "#pane-analytics p": "Performance summary and predictions from Qwen.",
      "#pane-learning h2": "Learning Process",
      "#pane-learning p": "What Qwen has improved from previous loss evaluations.",
    },
    Spanish: {
      ".settings-tab[data-target='pane-language']": "Idioma",
      ".settings-tab[data-target='pane-alerts']": "Alertas y Audio",
      ".settings-tab[data-target='pane-sniper']": "Disparador Sniper",
      ".settings-tab[data-target='pane-analytics']": "Analítica",
      ".settings-tab[data-target='pane-learning']": "Proceso Aprendizaje",
      "#pane-language h2": "Idioma",
      "#pane-language p": "Seleccione el idioma que usará Qwen para responder el análisis.",
      "#pane-alerts h2": "Alertas y Audio",
      "#pane-alerts p": "Configura notificaciones del sistema y alertas de sonido.",
      "#pane-sniper h2": "Tiempo de Disparo Sniper",
      "#pane-sniper p": "¿Cuántos minutos/segundos antes del cierre del mercado debe disparar Qwen?",
      "#pane-analytics h2": "Estadísticas Analítica",
      "#pane-analytics p": "Resumen de rendimiento y predicciones de Qwen.",
      "#pane-learning h2": "Proceso Aprendizaje",
      "#pane-learning p": "Qué ha mejorado Qwen a partir de evaluaciones de pérdidas anteriores.",
    },
    Russian: {
      ".settings-tab[data-target='pane-language']": "Язык",
      ".settings-tab[data-target='pane-alerts']": "Уведомления",
      ".settings-tab[data-target='pane-sniper']": "Снайпер Триггер",
      ".settings-tab[data-target='pane-analytics']": "Аналитика",
      ".settings-tab[data-target='pane-learning']": "Обучение",
      "#pane-language h2": "Язык",
      "#pane-language p": "Выберите язык, который Qwen будет использовать для ответов.",
      "#pane-alerts h2": "Уведомления и Звук",
      "#pane-alerts p": "Настройте системные уведомления и звуковые сигналы.",
      "#pane-sniper h2": "Снайпер Триггер",
      "#pane-sniper p": "За сколько минут/секунд до закрытия рынка Qwen должен сработать?",
      "#pane-analytics h2": "Статистика",
      "#pane-analytics p": "Сводка производительности и прогнозы от Qwen.",
      "#pane-learning h2": "Процесс обучения",
      "#pane-learning p": "Что Qwen улучшил после анализа предыдущих потерх.",
    }
  };

  const dict = translations[lang];
  if (!dict) return; // Default ID in HTML

  for (const [selector, text] of Object.entries(dict)) {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  }
}

// Queue polling handled by the sniper interval above
setTimeout(loadHealth, 100);
setTimeout(detectDns, 100);
setInterval(loadHealth, 5000); // Keep ms latency live in status bar


/* --- Aggressive Mode (No NETRAL) --- */
const aggressiveModeBtn = document.getElementById('aggressiveModeBtn');
const aggressiveModeText = document.getElementById('aggressiveModeText');
let isAggressiveMode = localStorage.getItem('aggressiveMode') === 'true';

function updateAggressiveModeUI() {
  if (!aggressiveModeBtn || !aggressiveModeText) return;
  if (isAggressiveMode) {
    aggressiveModeText.textContent = 'NO NETRAL: ON';
    aggressiveModeBtn.style.borderColor = 'var(--neon-red)';
    aggressiveModeBtn.style.color = 'var(--neon-red)';
    aggressiveModeBtn.style.boxShadow = '0 0 8px rgba(239,68,68,0.4)';
    aggressiveModeBtn.title = 'Mode Agresif AKTIF: Analisis NETRAL akan dipaksa ke UP atau DOWN';
  } else {
    aggressiveModeText.textContent = 'NO NETRAL: OFF';
    aggressiveModeBtn.style.borderColor = 'rgba(239,68,68,0.35)';
    aggressiveModeBtn.style.color = 'var(--text-secondary)';
    aggressiveModeBtn.style.boxShadow = 'none';
    aggressiveModeBtn.title = 'Mode Agresif: Paksa UP atau DOWN, tidak ada NETRAL';
  }
}

// Notify backend of initial state on page load
fetch('/api/settings/aggressive-mode', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({ enabled: isAggressiveMode })
}).catch(() => {});

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

if (aggressiveModeBtn) {
  aggressiveModeBtn.addEventListener('click', () => {
    isAggressiveMode = !isAggressiveMode;
    localStorage.setItem('aggressiveMode', isAggressiveMode);
    updateAggressiveModeUI();
    // Notify backend
    fetch('/api/settings/aggressive-mode', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ enabled: isAggressiveMode })
    }).catch(() => {});
    // Show toast
    const msg = isAggressiveMode
      ? '🔴 Mode Agresif ON — Tidak ada NETRAL, semua dipaksa UP atau DOWN'
      : '⚪ Mode Agresif OFF — NETRAL diperbolehkan';
    if (typeof showToastNotification === 'function') showToastNotification(msg, isAggressiveMode ? 'warning' : 'info');
  });
  updateAggressiveModeUI();
}

// Expose to be used by analysis result handler
window.isAggressiveMode = () => isAggressiveMode;

/* --- Polymarket Wallet Logic --- */
const btnToggleWallet = document.getElementById('btnToggleWallet');
const walletEyeIcon = document.getElementById('walletEyeIcon');
const walletPortfolioValue = document.getElementById('walletPortfolioValue');
const walletPortfolioChange = document.getElementById('walletPortfolioChange');
const walletUsdcBalance = document.getElementById('walletUsdcBalance');
const walletPositions = document.getElementById('walletPositions');
const walletActiveVolume = document.getElementById('walletActiveVolume');
// Default to true (hidden) if not explicitly set to false
let isWalletHidden = localStorage.getItem('walletHidden') !== 'false';

function updateWalletVisibility() {
  if (isWalletHidden) {
    if (walletEyeIcon) {
      walletEyeIcon.setAttribute('data-lucide', 'eye-off');
      if (typeof lucide !== 'undefined') lucide.createIcons({root: btnToggleWallet});
    }
    if (walletPortfolioValue) walletPortfolioValue.textContent = '*****';
    if (walletPortfolioChange) walletPortfolioChange.textContent = '***';
    if (walletUsdcBalance) walletUsdcBalance.textContent = '*****';
    if (walletPositions) walletPositions.textContent = '***';
    if (walletActiveVolume) walletActiveVolume.textContent = '*****';
  } else {
    if (walletEyeIcon) {
      walletEyeIcon.setAttribute('data-lucide', 'eye');
      if (typeof lucide !== 'undefined') lucide.createIcons({root: btnToggleWallet});
    }
    const wData = window.walletData;
    if (wData && wData.connected) {
      const formattedUsdc = `$${wData.usdc.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
      if (walletPortfolioValue) walletPortfolioValue.textContent = formattedUsdc;
      if (walletPortfolioChange) walletPortfolioChange.textContent = 'Active (Polygon)';
      if (walletUsdcBalance) walletUsdcBalance.textContent = formattedUsdc;
      if (walletPositions) walletPositions.textContent = 'Ready';
      if (walletActiveVolume) walletActiveVolume.textContent = '-';
    } else {
      if (walletPortfolioValue) walletPortfolioValue.textContent = '$0.00';
      if (walletPortfolioChange) walletPortfolioChange.textContent = '-';
      if (walletUsdcBalance) walletUsdcBalance.textContent = '$0.00';
      if (walletPositions) walletPositions.textContent = '-';
      if (walletActiveVolume) walletActiveVolume.textContent = '-';
    }
  }
}

if (btnToggleWallet) {
  updateWalletVisibility();
  btnToggleWallet.addEventListener('click', () => {
    isWalletHidden = !isWalletHidden;
    localStorage.setItem('walletHidden', isWalletHidden.toString());
    updateWalletVisibility();
  });
}

/* --- Whale Sniffer UI Toggle --- */
let currentSnifferStartTime = 0;
let lastSeenWhaleTimestamp = Date.now();
let isFirstLoad = true;

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
    const sizeStr = "$" + whale.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    
    const isTracked = whale.isTracked;
    const headerTitle = isTracked ? "Tracked Wallet Traded!" : "Whale Ditemukan!";
    const headerColor = isTracked ? "var(--neon-amber)" : "var(--neon-cyan)";
    const borderGlow = isTracked ? "1px solid var(--neon-amber)" : "1px solid var(--neon-cyan)";
    const iconName = isTracked ? "target" : "radar";
    
    toast.style.border = borderGlow;
    if (isTracked) toast.style.boxShadow = "0 8px 32px rgba(245,158,11,0.4)";

    toast.innerHTML = `
      <div style="font-weight:bold; font-size:12px; color:${headerColor}; display:flex; align-items:center; gap:6px;">
        <i data-lucide="${iconName}" style="width:14px; height:14px;"></i> ${headerTitle}
      </div>
      <div style="font-size:11px;">${icon} ${sizeStr} (${whale.side} @ $${whale.price.toFixed(3)})</div>
      <div style="font-size:10px; color:var(--text-secondary); max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${whale.market_question}</div>
    `;
    
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

  // Tab Switching
  if (dashTabSniffer && dashTabWallet) {
    dashTabSniffer.addEventListener('click', () => {
      dashTabSniffer.classList.add('active');
      dashTabWallet.classList.remove('active');
      dashPaneSniffer.classList.add('active');
      dashPaneWallet.classList.remove('active');
    });
    dashTabWallet.addEventListener('click', () => {
      dashTabWallet.classList.add('active');
      dashTabSniffer.classList.remove('active');
      dashPaneWallet.classList.add('active');
      dashPaneSniffer.classList.remove('active');
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

  // Dashboard Add Wallet Logic
  if (dashWalletAddBtn) {
    dashWalletAddBtn.addEventListener('click', async () => {
      const address = dashWalletInput.value.trim();
      const nick = dashWalletNick.value.trim();
      if (!address) return;
      dashWalletAddBtn.innerText = 'Adding...';
      try {
        await fetch('/api/sniffer-wallet', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({action: 'add', address, nickname: nick})
        });
        dashWalletInput.value = '';
        dashWalletNick.value = '';
        await updateSnifferUI();
      } catch (e) {
        console.error(e);
      } finally {
        dashWalletAddBtn.innerText = 'Add';
      }
    });
  }

  // Dashboard Remove Wallet logic happens inside updateSnifferUI
  window.removeDashWallet = async function(address) {
    try {
      await fetch('/api/sniffer-wallet', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'remove', address})
      });
      await updateSnifferUI();
    } catch(e) { console.error(e); }
  };

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
          dashStatusPill.classList.add('live');
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
          dashStatusPill.classList.remove('live');
          dashStatusText.innerText = 'Offline';
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
          trendingList.innerHTML = data.trending.map(t => `
            <a href="https://polymarket.com/event/${t.slug}" target="_blank" style="text-decoration:none; background:rgba(6,182,212,0.1); border:1px solid rgba(6,182,212,0.3); color:var(--neon-cyan); padding:4px 8px; border-radius:4px; font-size:11px; white-space:nowrap; max-width:200px; overflow:hidden; text-overflow:ellipsis;" title="${t.question} (${t.count} trades)">
              ${t.count} trades • ${t.question}
            </a>
          `).join("");
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
             
             const size = "$" + w.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
             
             let walletShort = "";
             if (w.wallet_nickname) {
               walletShort = `${w.wallet_nickname} (${w.maker.slice(0, 6)}...${w.maker.slice(-4)})`;
             } else {
               walletShort = w.maker === "Hidden" ? "Anonymous" : `${w.maker.slice(0, 6)}...${w.maker.slice(-4)}`;
             }
             
             const timeAgo = Math.round((Date.now() - w.timestamp) / 1000);
             const timeFmt = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo/60)}m ago`;
             const icon = w.side === "BUY" ? "🟢" : (w.side === "SELL" ? "🔴" : "🔵");
             
             const eventLinkHtml = w.market_slug 
                 ? `<a href="https://polymarket.com/event/${w.market_slug}" target="_blank" style="color:inherit; text-decoration:none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${w.market_question}</a>`
                 : w.market_question;
             

             const sideClass = w.side.toLowerCase();
             const outcomeStr = w.outcome === "UP" ? `<span style="color:var(--neon-green)">UP</span>` : (w.outcome === "DOWN" ? `<span style="color:var(--neon-red)">DOWN</span>` : `<span style="color:var(--text-tertiary)">???</span>`);
             const durationStr = w.duration_type ? `<span style="background:rgba(255,255,255,0.05); padding:2px 4px; border-radius:3px;">${w.duration_type}</span>` : "";

             dashHtml += `
              <div class="tracker-whale-item">
                <div class="whale-row-top">
                  <span class="whale-side-badge ${sideClass}">${w.side} ${outcomeStr}</span>
                  <span class="whale-size">${size}</span>
                  <span class="whale-time">${timeFmt}</span>
                </div>
                <div class="whale-market">${eventLinkHtml} ${durationStr}</div>
                <div style="display:flex; align-items:center;">
                  <div style="color:var(--text-tertiary); font-family:var(--font-mono); font-size:9px; margin-top:2px;">${walletShort}</div>
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
           let html = '';
           let dashTrackedHtml = '';
           for (const w of trackedFiltered) {
             const size = "$" + w.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
             
             let walletShort = "";
             if (w.wallet_nickname) {
               walletShort = `${w.wallet_nickname} (${w.maker.slice(0, 6)}...${w.maker.slice(-4)})`;
             } else {
               walletShort = w.maker === "Hidden" ? "Anonymous" : `${w.maker.slice(0, 6)}...${w.maker.slice(-4)}`;
             }
             
             const timeAgo = Math.round((Date.now() - w.timestamp) / 1000);
             const timeFmt = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo/60)}m ago`;
             const icon = w.side === "BUY" ? "🟢" : (w.side === "SELL" ? "🔴" : "🔵");
             
             const eventLinkHtml = w.market_slug 
                 ? `<a href="https://polymarket.com/event/${w.market_slug}" target="_blank" style="color:inherit; text-decoration:none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${w.market_question}</a>`
                 : w.market_question;
                 

             
             const sideClass = w.side.toLowerCase();
             dashTrackedHtml += `
              <div class="tracker-whale-item" style="border-left: 2px solid var(--neon-amber); background: rgba(245,158,11,0.02);">
                <div class="whale-row-top">
                  <span class="whale-side-badge ${sideClass}">${w.side}</span>
                  <span class="whale-size">${size}</span>
                  <span class="whale-time">${timeFmt}</span>
                </div>
                <div class="whale-market">${eventLinkHtml}</div>
                <div style="display:flex; align-items:center;">
                  <div style="color:var(--text-tertiary); font-family:var(--font-mono); font-size:9px; margin-top:2px;">${walletShort}</div>
                  <div class="whale-tracked-badge"><i data-lucide="target" style="width:8px; height:8px;"></i> Target</div>
                </div>
              </div>
             `;
           }
           if (dashTrackedFeed) {
             dashTrackedFeed.innerHTML = dashTrackedHtml;
             if (typeof lucide !== 'undefined') lucide.createIcons({root: dashTrackedFeed});
           }
        } else {
          if (dashTrackedFeed) {
            if (activeTrackedWallets.length > 0) {
              dashTrackedFeed.innerHTML = `<div class="tracker-empty"><i data-lucide="target" class="tracker-empty-icon"></i><p>Listening for trades from tracked wallets...</p></div>`;
            } else {
              dashTrackedFeed.innerHTML = `<div class="tracker-empty"><i data-lucide="target" class="tracker-empty-icon"></i><p>No wallets tracked.<br>Add an address to intercept their trades.</p></div>`;
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
    if (dashText) dashText.innerText = `Live (${timeStr})`;
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
        dashWalletTags.innerHTML = activeTrackedWallets.map(w => `
          <div class="wallet-tag" title="${w.address}">
            <span onclick="window.viewWalletPositions('${w.address}', '${w.nickname}')" style="cursor:pointer; text-decoration:underline; text-underline-offset:2px; font-weight:600; color:var(--text-secondary); transition:color 0.2s;" onmouseover="this.style.color='var(--neon-cyan)';" onmouseout="this.style.color='var(--text-secondary)';">${w.nickname || (w.address.slice(0,6)+'...')}</span>
            <button type="button" onclick="window.removeDashWallet('${w.address}')">
              <i data-lucide="x" style="width:10px; height:10px;"></i>
            </button>
          </div>
        `).join("");
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
      if (w.length > 0 && !activeTrackedWallets.some(x => x.address === w)) {
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
    positionsModal.style.display = 'flex';
    
    // Reset Tabs
    if (tabWalletPositions) tabWalletPositions.click();
    
    if (walletDashboardNickname) walletDashboardNickname.textContent = nickname || 'Unknown Wallet';
    if (walletDashboardAddress) walletDashboardAddress.textContent = address;
    if (walletDashboardValue) walletDashboardValue.textContent = '...';
    if (walletDashboardAllTimePnl) walletDashboardAllTimePnl.textContent = '...';
    if (btnViewOnPoly) btnViewOnPoly.href = `https://polymarket.com/profile/${address}`;

    positionsTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-tertiary);"><i data-lucide="loader" class="radar-anim" style="width:24px; height:24px; margin-bottom:10px;"></i><br>Fetching portfolio data...</div>`;
    historyTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-tertiary);"><i data-lucide="loader" class="radar-anim" style="width:24px; height:24px; margin-bottom:10px;"></i><br>Fetching history...</div>`;
    if (typeof lucide !== 'undefined') {
      lucide.createIcons({root: positionsTabContent});
      lucide.createIcons({root: historyTabContent});
    }

    try {
      const res = await fetch(`/api/wallet-profile/${address}`);
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
            <div style="background:var(--bg-elevated); border:1px solid var(--border); padding:16px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; transition:border-color 0.2s; cursor:pointer;" onmouseover="this.style.borderColor='var(--neon-amber)'" onmouseout="this.style.borderColor='var(--border)'">
              <div style="display:flex; flex-direction:column; gap:8px; flex:1; padding-right:16px;">
                <div style="font-weight:600; color:var(--text-primary); font-size:14px; line-height:1.4;">${p.title}</div>
                <div style="display:flex; gap:16px; font-family:var(--font-mono); font-size:11px;">
                  <span style="color:var(--text-secondary); background:rgba(0,0,0,0.2); padding:2px 6px; border-radius:4px;">Outcome: <span style="color:var(--neon-amber); font-weight:bold;">${p.outcome}</span></span>
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
                  ${t.side}
                </div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                  <div style="font-weight:500; color:var(--text-primary); font-size:13px;">${t.title}</div>
                  <div style="font-size:11px; color:var(--text-tertiary);">${date}</div>
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
      positionsTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:#ef4444;">Failed to load data: ${e.message}</div>`;
      historyTabContent.innerHTML = `<div style="text-align:center; padding:40px; color:#ef4444;">Failed to load history: ${e.message}</div>`;
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

/* --- X INTELLIGENCE PANEL LOGIC --- */
const liveAlertsSource = new EventSource('/api/live-alerts');
const xAlertCount = document.getElementById('xAlertCount');
const xWhaleFeed = document.getElementById('xWhaleFeed');
const xWhaleEmpty = document.getElementById('xWhaleEmpty');
const xMiniVibeCheck = document.getElementById('xMiniVibeCheck');
const xVibeContent = document.getElementById('xVibeContent');

let alertCount = 0;

liveAlertsSource.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    if (data.type === "HOT_NICHE_UPDATE") {
      alertCount++;
      if(xAlertCount) {
        xAlertCount.style.display = "inline";
        xAlertCount.textContent = alertCount;
      }
      
      if(xWhaleEmpty) xWhaleEmpty.style.display = "none";
      
      const el = document.createElement("div");
      el.style.background = "rgba(239, 68, 68, 0.1)";
      el.style.border = "1px solid rgba(239, 68, 68, 0.3)";
      el.style.padding = "10px";
      el.style.borderRadius = "8px";
      el.innerHTML = `
        <div style="font-size:10px; color:var(--text-tertiary); margin-bottom:4px; font-weight:bold;">🔥 HOT NICHE DETECTED</div>
        <div style="font-weight:600; font-size:13px; color:var(--text-primary); margin-bottom:8px; line-height:1.4;">${data.marketInfo.question}</div>
        <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-secondary); background:rgba(0,0,0,0.3); padding:4px 8px; border-radius:4px;">${data.volumeSpike}</div>
      `;
      if(xWhaleFeed) xWhaleFeed.prepend(el);
      
      if(xMiniVibeCheck) {
        xMiniVibeCheck.style.display = "block";
        xMiniVibeCheck.textContent = data.sentiment;
        if (data.sentiment === "BULLISH") {
           xMiniVibeCheck.style.color = "var(--neon-green)";
           xMiniVibeCheck.style.borderColor = "var(--neon-green)";
           xMiniVibeCheck.style.background = "rgba(16,185,129,0.1)";
        } else if (data.sentiment === "BEARISH") {
           xMiniVibeCheck.style.color = "var(--neon-red)";
           xMiniVibeCheck.style.borderColor = "var(--neon-red)";
           xMiniVibeCheck.style.background = "rgba(239,68,68,0.1)";
        } else {
           xMiniVibeCheck.style.color = "var(--text-secondary)";
           xMiniVibeCheck.style.borderColor = "var(--border-strong)";
           xMiniVibeCheck.style.background = "rgba(255,255,255,0.05)";
        }
      }
      
      if(xVibeContent) {
        xVibeContent.innerHTML = `
          <div style="background:var(--bg-elevated); border:1px solid var(--border); padding:16px; border-radius:8px;">
            <div style="font-size:11px; color:var(--text-tertiary); margin-bottom:6px; text-transform:uppercase;">AI Sentiment Analysis</div>
            <div style="font-weight:bold; font-size:18px; color:${xMiniVibeCheck ? xMiniVibeCheck.style.color : '#fff'}; margin-bottom:12px;">${data.sentiment}</div>
            <div style="font-size:13px; color:var(--text-secondary); line-height:1.6; margin-bottom:12px;">${data.summary}</div>
            <div style="padding-top:12px; border-top:1px dashed var(--border); font-size:10px; color:var(--text-tertiary);">Market: ${data.marketInfo.question}</div>
          </div>
        `;
      }
    }
  } catch(e) {}
};

document.querySelectorAll(".x-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".x-tab-btn").forEach(b => {
      b.classList.remove("active");
      b.style.background = "transparent";
      b.style.color = "var(--text-secondary)";
    });
    btn.classList.add("active");
    btn.style.background = "rgba(255,255,255,0.1)";
    btn.style.color = "var(--text-primary)";
    
    document.querySelectorAll(".x-tab-content").forEach(c => c.style.display = "none");
    const targetId = btn.dataset.target;
    if(targetId) {
       const tab = document.getElementById(targetId);
       if (tab) tab.style.display = "flex";
       if (targetId === "xTabWhales") {
         alertCount = 0;
         if(xAlertCount) xAlertCount.style.display = "none";
       }
    }
  });
});

const titleObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === "childList" || mutation.type === "characterData") {
      const polyTitleEl = document.getElementById("polyTitle");
      if (polyTitleEl) {
        const text = polyTitleEl.textContent;
        if (text && text !== "Embed panel") {
          const wrapper = document.getElementById("xEmbedWrapper");
          if (wrapper) {
            wrapper.innerHTML = `
              <div style="padding:20px; text-align:center;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="color:#1DA1F2; margin-bottom:10px;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                <div style="color:var(--text-secondary); font-size:12px; margin-bottom:16px;">Mencari obrolan X tentang:<br><strong style="color:#fff;">${text}</strong></div>
                <div id="xSearchResults" style="display:flex; flex-direction:column; gap:10px; text-align:left;">
                  <div style="color:var(--text-secondary); font-size:12px; font-style:italic;">Loading live tweets...</div>
                </div>
              </div>
            `;

            fetch('/api/twitter-search?q=' + encodeURIComponent(text))
              .then(r => r.json())
              .then(data => {
                const resultsContainer = document.getElementById('xSearchResults');
                if (!resultsContainer) return;
                
                if (!data.tweets || data.tweets.length === 0) {
                  resultsContainer.innerHTML = `<div style="color:var(--neon-red); font-size:12px; text-align:center; padding:10px; background:rgba(239,68,68,0.1); border-radius:8px;">Tidak ada obrolan terbaru ditemukan.</div>`;
                  return;
                }

                resultsContainer.innerHTML = data.tweets.map(tweet => `
                  <div style="background:var(--bg-secondary); border:1px solid var(--border-strong); padding:12px; border-radius:8px; font-size:13px; line-height:1.4; color:var(--text-primary);">
                    <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11px; color:var(--text-secondary);">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="#1DA1F2"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                      Postingan X Terbaru
                    </div>
                    ${tweet}
                  </div>
                `).join('');
              })
              .catch(err => {
                const resultsContainer = document.getElementById('xSearchResults');
                if (resultsContainer) {
                  resultsContainer.innerHTML = `<div style="color:var(--text-secondary); font-size:12px;">Gagal memuat tweets.</div>`;
                }
              });
          }
        }
      }
    }
  });
});
const polyTitleEl = document.getElementById("polyTitle");
if (polyTitleEl) {
  titleObserver.observe(polyTitleEl, { childList: true, characterData: true, subtree: true });
}

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

/* --- Agent Modal Logic --- */
const agentConclusionBox = document.querySelector("#agentConclusionBox");
const agentModal = document.querySelector("#agentModal");
const closeAgentModal = document.querySelector("#closeAgentModal");

if (agentConclusionBox && agentModal && closeAgentModal) {
  agentConclusionBox.addEventListener("click", () => {
    agentModal.style.display = "flex";
  });
  closeAgentModal.addEventListener("click", () => {
    agentModal.style.display = "none";
  });
  agentModal.addEventListener("click", (e) => {
    if (e.target === agentModal) {
      agentModal.style.display = "none";
    }
  });
}

/* --- Dashboard Drag and Drop Logic --- */
window.addEventListener('load', () => {
  const centerDashboard = document.getElementById("centerDashboard");
  if (!centerDashboard) return;

  if (typeof Sortable === 'undefined') {
    console.error('[DragDrop] SortableJS not loaded — drag disabled');
    return;
  }

  Sortable.create(centerDashboard, {
    animation: 200,
    easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    handle: '.card-drag-strip',  // full-width bar — much easier to grab than icon alone
    filter: '#staticResultPanel', // exclude bento grid panel from being dragged
    draggable: '.dash-bottom-card', // only drag the 3 uniform cards
    forceFallback: true,
    fallbackTolerance: 4,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    fallbackClass: "sortable-drag",
    onStart: function (evt) {
      evt.item.style.opacity = '0.9';
    },
    onEnd: function (evt) {
      evt.item.style.opacity = '';
      const cards = Array.from(centerDashboard.querySelectorAll('.dash-bottom-card'));
      const newOrder = cards.map(c => c.id).filter(Boolean);
      localStorage.setItem("dashboardCardOrder", JSON.stringify(newOrder));
    }
  });

  // Restore saved card order
  try {
    const savedOrder = JSON.parse(localStorage.getItem("dashboardCardOrder"));
    if (savedOrder && savedOrder.length) {
      savedOrder.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.classList.contains('dash-bottom-card')) {
          centerDashboard.appendChild(el);
        }
      });
    }
  } catch(e) {}
});

function closeStaticPanel() {
  const panel = document.getElementById('staticResultPanel');
  if (panel) {
    localStorage.setItem("market_summary_closed", "true");
    panel.style.display = 'none';
  }
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

window.toggleChartFullscreen = function(ticker) {
  const container = document.getElementById(`icc-chart-${ticker}`);
  const modal = document.getElementById('chartModal');
  const modalBody = document.getElementById('chartModalBody');
  const modalTitle = document.getElementById('chartModalTitle');
  
  if (!container || !modal || !modalBody) return;
  
  // Save original parent
  container.dataset.originalParent = container.parentElement.id;
  
  // Update UI
  modalTitle.textContent = `${ticker.toUpperCase()}/USDT`;
  modalTitle.style.color = ticker === 'btc' ? '#f59e0b' : ticker === 'eth' ? '#818cf8' : '#34d399';
  
  // Remove absolute top constraint so it fills modal body
  container.style.top = '0';
  
  // Move to modal
  modalBody.appendChild(container);
  modal.style.display = 'flex';
  
  // Force resize on the chart
  if (iccCharts[ticker] && iccCharts[ticker].chart) {
    setTimeout(() => {
      iccCharts[ticker].chart.timeScale().fitContent();
    }, 50);
  }
};

window.closeChartModal = function() {
  const modal = document.getElementById('chartModal');
  const modalBody = document.getElementById('chartModalBody');
  if (!modal || !modalBody) return;
  
  const container = modalBody.firstElementChild;
  if (container && container.dataset.originalParent) {
    const origParent = document.getElementById(container.dataset.originalParent);
    if (origParent) {
      container.style.top = '30px'; // Restore constraint for grid
      origParent.appendChild(container);
      
      const ticker = container.id.split('-').pop();
      if (iccCharts[ticker] && iccCharts[ticker].chart) {
        setTimeout(() => {
          iccCharts[ticker].chart.timeScale().fitContent();
        }, 50);
      }
    }
  }
  
  modal.style.display = 'none';
};

window.updateChartRealtimePrice = function(asset, priceVal) {
  const symbol = asset + "USDT";
  const state = iccCharts[symbol];
  if (!state || !state.series || !state.lastCandle) return;

  const nowMs = Date.now();
  const currentIntervalSec = Math.floor(nowMs / (15 * 60 * 1000)) * (15 * 60);

  let lc = state.lastCandle;
  
  if (currentIntervalSec > lc.time) {
    // Start a new 15m candle
    lc = {
      time: currentIntervalSec,
      open: lc.close, // Open at previous close
      high: priceVal,
      low: priceVal,
      close: priceVal
    };
    state.lastCandle = lc;
    state.openPrice = lc.open; // Update the reference open price for the % change calculation
  } else {
    // Update existing candle
    lc.close = priceVal;
    if (priceVal > lc.high) lc.high = priceVal;
    if (priceVal < lc.low) lc.low = priceVal;
  }

  state.series.update(lc);
  
  // Update header UI
  updatePriceDisplay(state.cfg, priceVal, state.openPrice);
};

// === Live Chart Command Center (Lightweight Charts + Binance REST + Pyth Realtime) ===
const iccCharts = {}; // symbol -> { chart, series, cfg, lastCandle, openPrice }

function initTradingViewCharts() {
  if (typeof LightweightCharts === 'undefined') {
    // LW Charts not loaded yet — retry in 500ms
    setTimeout(initTradingViewCharts, 500);
    return;
  }

  const chartDefs = [
    { symbol: 'BTCUSDT',  containerId: 'icc-chart-btc',  priceId: 'icc-btc-price',  chgId: 'icc-btc-chg',  color: '#f59e0b', precision: 2 },
    { symbol: 'ETHUSDT',  containerId: 'icc-chart-eth',  priceId: 'icc-eth-price',  chgId: 'icc-eth-chg',  color: '#818cf8', precision: 2 },
    { symbol: 'DOGEUSDT', containerId: 'icc-chart-doge', priceId: 'icc-doge-price', chgId: 'icc-doge-chg', color: '#34d399', precision: 5 },
  ];

  chartDefs.forEach(cfg => {
    const container = document.getElementById(cfg.containerId);
    if (!container || iccCharts[cfg.symbol]) return;

    const chart = LightweightCharts.createChart(container, {
      width: container.offsetWidth || 400,
      height: container.offsetHeight || 300,
      layout: { background: { color: '#0a0a0e' }, textColor: '#555' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', textColor: '#555' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });

    // Auto-resize — use resize() not applyOptions() for LW Charts v4
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) chart.resize(w, h);
    });
    ro.observe(container);

    const series = chart.addCandlestickSeries({
      upColor: cfg.color,
      downColor: '#ef4444',
      borderUpColor: cfg.color,
      borderDownColor: '#ef4444',
      wickUpColor: cfg.color,
      wickDownColor: '#ef4444',
      priceFormat: { type: 'price', precision: cfg.precision, minMove: Math.pow(10, -cfg.precision) },
    });

    iccCharts[cfg.symbol] = { chart, series, cfg, currentTf: '15m' };

    fetchChartData(cfg.symbol, '15m');
  });
}

window.changeChartTimeframe = function(coin, tf) {
  const symbol = coin.toUpperCase() + 'USDT';
  if (!iccCharts[symbol]) {
    // Chart not init yet — init on demand then fetch
    initTradingViewCharts();
    setTimeout(() => window.changeChartTimeframe(coin, tf), 600);
    return;
  }
  iccCharts[symbol].currentTf = tf;
  fetchChartData(symbol, tf);
  // Update button styles
  document.querySelectorAll(`.tf-btn-${coin.toLowerCase()}`).forEach(btn => {
    btn.style.color = btn.getAttribute('data-tf') === tf ? '#e8e8e8' : '#555';
    btn.style.background = btn.getAttribute('data-tf') === tf ? 'rgba(255,255,255,0.1)' : 'transparent';
  });
};

function fetchChartData(symbol, tf) {
  const cfg = iccCharts[symbol].cfg;
  const series = iccCharts[symbol].series;
  const chart = iccCharts[symbol].chart;
  
  fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=500`)
    .then(r => r.json())
    .then(data => {
      const candles = data.map(k => ({
        time: Math.floor(k[0] / 1000),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
      }));
      series.setData(candles);
      chart.timeScale().fitContent();

      const lastCandle = candles[candles.length - 1];
      const firstClose = candles[0].open;
      iccCharts[symbol].lastCandle = Object.assign({}, lastCandle);
      iccCharts[symbol].openPrice = firstClose;
      
      updatePriceDisplay(cfg, lastCandle.close, firstClose);
    })
    .catch(() => {
      const container = document.getElementById(cfg.containerId);
      if(container) container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#333;font-size:11px;font-family:monospace;">Connection error</div>';
    });
}

function updatePriceDisplay(cfg, currentPrice, openPrice) {
  const priceEl = document.getElementById(cfg.priceId);
  const chgEl = document.getElementById(cfg.chgId);
  if (!priceEl || !chgEl) return;

  priceEl.textContent = currentPrice.toFixed(cfg.precision);
  const chgPct = ((currentPrice - openPrice) / openPrice) * 100;
  const chgSign = chgPct >= 0 ? '+' : '';
  chgEl.textContent = `${chgSign}${chgPct.toFixed(2)}%`;
  chgEl.style.color = chgPct >= 0 ? '#34d399' : '#ef4444';
}

function startIccKlineWs(cfg, series) {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${cfg.symbol.toLowerCase()}@kline_15m`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const k = msg.k;
    if (!k) return;
    const candle = {
      time: Math.floor(k.t / 1000),
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
    };
    series.update(candle);
    // Update price display with open of first historical candle is tricky — just use prev close
    const priceEl = document.getElementById(cfg.priceId);
    if (priceEl) {
      const prev = parseFloat(priceEl.textContent) || candle.open;
      updatePriceDisplay(cfg, candle.close, candle.open);
    }
  };
  ws.onerror = () => {};
  if (iccCharts[cfg.symbol]) iccCharts[cfg.symbol].ws = ws;
}

// Call after page is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initTradingViewCharts, 800));
} else {
  setTimeout(initTradingViewCharts, 800);
}



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

function injectMspStyles() {
  if (document.getElementById('msp-styles')) return;
  const style = document.createElement('style');
  style.id = 'msp-styles';
  style.innerHTML = `
/* Outer bezel */
.msp-shell { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 2px; box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.04) inset; }
.msp-core { box-sizing: border-box; background: rgba(22,22,26,0.98); border-radius: 12px; border: 1px solid rgba(255,255,255,0.07); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08); padding: 18px 20px 16px; display: flex; flex-direction: column; justify-content: space-between; gap: 0; }
.msp-top-row { display: flex; justify-content: space-between; align-items: center; }
.msp-eyebrow { font-family: var(--font-secondary); font-size: 9px; font-weight: 700; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.18em; }
.msp-link { font-family: var(--font-secondary); font-size: 10px; font-weight: 500; color: rgba(16,185,129,0.55); letter-spacing: 0.02em; cursor: pointer; transition: color 0.2s ease; }
.msp-link:hover { color: var(--neon-green); }
.msp-hero-row { display: flex; align-items: center; flex: 1; margin: 10px 0; }
.msp-signal-block { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.msp-signal-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px 6px 12px; border-radius: 8px; width: fit-content; }
.msp-signal-arrow { font-size: 18px; font-weight: 900; line-height: 1; }
.msp-signal-text { font-family: var(--font-primary); font-size: 22px; font-weight: 800; letter-spacing: 0.05em; line-height: 1; }
.msp-vline { width: 1px; height: 48px; background: rgba(255,255,255,0.1); margin: 0 20px; flex-shrink: 0; }
.msp-entry-block { display: flex; flex-direction: column; gap: 6px; text-align: right; }
.msp-entry-val { font-family: var(--font-primary); font-size: 18px; font-weight: 800; letter-spacing: 0.04em; line-height: 1; }
.msp-field-label { font-family: var(--font-secondary); font-size: 9px; font-weight: 600; color: rgba(255,255,255,0.32); text-transform: uppercase; letter-spacing: 0.1em; }
.msp-hline { height: 1px; background: rgba(255,255,255,0.08); margin: 0 -20px; }
.msp-strip { display: flex; align-items: stretch; padding: 12px 0; }
.msp-strip-item { flex: 1; display: flex; flex-direction: column; gap: 5px; padding: 2px 0; }
.msp-strip-item--wide { flex: 1.6; }
.msp-strip-sep { width: 1px; background: rgba(255,255,255,0.08); margin: 0 14px; flex-shrink: 0; }
.msp-strip-label { font-family: var(--font-secondary); font-size: 8px; font-weight: 700; color: rgba(255,255,255,0.32); text-transform: uppercase; letter-spacing: 0.1em; }
.msp-strip-val { font-family: var(--font-primary); font-size: 13px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
.msp-depth { padding-top: 14px; }
.msp-depth-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.msp-depth-bid-txt { font-family: var(--font-secondary); font-size: 9px; font-weight: 700; color: var(--neon-green); text-transform: uppercase; letter-spacing: 0.07em; }
.msp-depth-center-txt { font-family: var(--font-secondary); font-size: 8px; font-weight: 600; color: rgba(255,255,255,0.28); text-transform: uppercase; letter-spacing: 0.12em; }
.msp-depth-ask-txt { font-family: var(--font-secondary); font-size: 9px; font-weight: 700; color: #ef4444; text-transform: uppercase; letter-spacing: 0.07em; }
.msp-depth-bar { display: flex; width: 100%; height: 6px; border-radius: 4px; overflow: hidden; background: rgba(255,255,255,0.06); gap: 1px; }
.msp-depth-bid-fill { height: 100%; background: linear-gradient(90deg, rgba(16,185,129,0.4), rgba(16,185,129,0.85)); border-radius: 4px 0 0 4px; transition: width 1.2s cubic-bezier(0.16,1,0.3,1); box-shadow: 0 0 12px rgba(16,185,129,0.5); }
.msp-depth-ask-fill { height: 100%; background: linear-gradient(90deg, rgba(239,68,68,0.85), rgba(239,68,68,0.4)); border-radius: 0 4px 4px 0; transition: width 1.2s cubic-bezier(0.16,1,0.3,1); box-shadow: 0 0 12px rgba(239,68,68,0.5); }
`;
  document.head.appendChild(style);
}

function buildBentoGrid(text, isHistory = false) {
  if (typeof injectMspStyles === "function") injectMspStyles();

  const data = {
     arah: "-", entry: "-", liquidity: "-", gammaVol: "-", orderbook: "-", conf: "-", qwenScore: "-", risk: "-",
     deadline: "-", summary: "-", targetPrice: "-", realtimePrice: "-", analysisTime: null, url: null, tokens: null
  };
  const lines = text.split("\n");
  for (let line of lines) {
    if (line.includes("Arah market:")) data.arah = line.split("Arah market:")[1].trim().split(" ")[0].toUpperCase();
    if (line.includes("Entry status:")) data.entry = line.split("Entry status:")[1].trim().split(" ")[0].replace(/[^a-zA-Z]/g, "").toUpperCase();
    if (line.includes("Liquidity:")) data.liquidity = line.split("Liquidity:")[1].trim().split(" ")[0];
    if (line.includes("Gamma volume:")) data.gammaVol = line.split("Gamma volume:")[1].trim().split(" ")[0];
    if (line.startsWith("Orderbook")) data.orderbook = line.split("|").slice(0, 2).join(" | ").replace("Orderbook UP:", "").replace("Orderbook DOWN:", "").trim();
    if (line.includes("Data confidence:")) data.conf = line.split("|")[0].replace("Data confidence:", "").trim();
    if (line.includes("Qwen confidence:")) data.qwenScore = line.split("Qwen confidence:")[1].trim();
    if (line.includes("API close/resolution:")) data.deadline = line.split("API close/resolution:")[1].replace("WIB", "").trim();
    if (line.includes("Kesimpulan Analisis:")) data.summary = line.split("Kesimpulan Analisis:")[1].trim();
    if (line.includes("Target Price:")) data.targetPrice = line.split("Target Price:")[1].trim();
    if (line.includes("Realtime Price:")) data.realtimePrice = line.split("Realtime Price:")[1].trim();
    if (line.includes("Durasi Analisis:")) data.analysisTime = line.split("Durasi Analisis:")[1].trim().replace(" detik", "");
    if (line.startsWith("URL:")) data.url = line.split("URL:")[1].trim();
    if (line.startsWith("Tokens:")) data.tokens = line.split("Tokens:")[1].trim();
  }
  
  // Fallback extraction from summary if backend explicit fields are missing
  if (data.targetPrice === "-" && data.summary.match(/Target Price\s*\(?\$?([0-9.,]+)\)?/i)) {
      data.targetPrice = data.summary.match(/Target Price\s*\(?\$?([0-9.,]+)\)?/i)[1];
  }
  if (data.realtimePrice === "-" && data.summary.match(/Oracle Pyth\s*\(?\$?([0-9.,]+)\)?/i)) {
      data.realtimePrice = data.summary.match(/Oracle Pyth\s*\(?\$?([0-9.,]+)\)?/i)[1];
  }

  const arahColor = data.arah === "UP" ? "var(--neon-green)" : (data.arah === "DOWN" ? "var(--neon-red)" : "var(--neon-cyan)");
  const arahBg = data.arah === "UP" ? "rgba(16,185,129,0.12)" : (data.arah === "DOWN" ? "rgba(239,68,68,0.12)" : "rgba(6,182,212,0.1)");
  const arahBorderColor = data.arah === "UP" ? "rgba(16,185,129,0.35)" : (data.arah === "DOWN" ? "rgba(239,68,68,0.35)" : "rgba(6,182,212,0.3)");
  const entryColor = (data.entry === "WAIT" || data.entry === "WATCHLIST") ? "var(--neon-amber)" : (data.entry === "SKIP" ? "var(--neon-red)" : "var(--neon-green)");
  const arahArrow = data.arah === "UP" ? "↑" : data.arah === "DOWN" ? "↓" : "—";

  let bidPct = 50;
  let askPct = 50;
  let bidStr = "50%";
  let askStr = "50%";
  if (data.orderbook && data.orderbook !== "-") {
     const matchBid = data.orderbook.match(/bid\s+([0-9.]+)/i);
     const matchAsk = data.orderbook.match(/ask\s+([0-9.]+)/i);
     if (matchBid && matchAsk) {
         const bidPrice = parseFloat(matchBid[1]);  // e.g. 0.47
         const askPrice = parseFloat(matchAsk[1]);  // e.g. 0.48
         // Midpoint = market implied prob for YES/UP
         const midpoint = (bidPrice + askPrice) / 2;
         // Bid side = prob UP (mid), Ask side = prob DOWN (1-mid)
         bidPct = Math.round(midpoint * 100);
         askPct = 100 - bidPct;
         bidStr = bidPct + "%";
         askStr = askPct + "%";
     }
  }

  const headerText = isHistory ? "HISTORY ARCHIVE" : "MARKET SUMMARY";
  const headerIcon = isHistory ? "archive" : "zap";
  const headerColor = isHistory ? "var(--neon-purple)" : "var(--neon-amber)";

  return `
        <div class="msp-top-row">
           <div class="msp-eyebrow" style="display:flex; align-items:center; gap:6px;">
             <i data-lucide="${headerIcon}" style="width:12px; height:12px; color:${headerColor};"></i>
             <span style="color:${headerColor}; font-weight:800; letter-spacing:0.25em;">${headerText}</span>
           </div>
           <div style="display:flex; gap:12px; align-items:center;">
             ${data.analysisTime ? `<span style="font-family:var(--font-secondary); font-size:9px; color:var(--text-tertiary); text-transform:uppercase;"><i data-lucide="timer" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-top:-2px;margin-right:3px;"></i>${data.analysisTime}s</span>` : ""}
             ${data.tokens ? `<span style="font-family:var(--font-secondary); font-size:9px; color:var(--text-tertiary); text-transform:uppercase;" title="Qwen Token Usage"><i data-lucide="cpu" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-top:-2px;margin-right:3px;"></i>${data.tokens} tkns</span>` : ""}
             ${data.deadline !== "-" ? `<span style="font-family:var(--font-secondary); font-size:9px; color:var(--text-tertiary); text-transform:uppercase;"><i data-lucide="clock" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-top:-2px;margin-right:3px;"></i>${data.deadline}</span>` : ""}
             ${data.url ? `<a href="${data.url}" target="_blank" class="msp-link" style="color:var(--neon-cyan); text-decoration:none; display:flex; align-items:center; gap:2px;"><i data-lucide="external-link" style="width:12px;height:12px;"></i> Polymarket</a>` : ""}
             <span class="msp-link" id="bentoKesimpulanBox" onclick="openFullReportModal()" style="cursor:pointer;">View full report →</span>
             <span class="msp-link" onclick="closeStaticPanel()" style="cursor:pointer; color:var(--neon-red); margin-left:8px; display:flex; align-items:center; gap:2px;" title="Tutup analisis dan kembali ke Live Charts"><i data-lucide="x" style="width:12px;height:12px;"></i> Tutup</span>
           </div>
        </div>
        <div class="msp-hero-row">
          <div class="msp-signal-block">
            <div class="msp-signal-pill" style="background:${arahBg}; border:1px solid ${arahBorderColor}; color:${arahColor};">
              <span class="msp-signal-arrow">${arahArrow}</span>
              <span class="msp-signal-text">${data.arah}</span>
            </div>
            <span class="msp-field-label">AI Signal</span>
          </div>
          <div class="msp-vline"></div>
          
          <div style="flex:2.2; display:flex; flex-direction:column; justify-content:center; padding:0 12px;">
             
             <!-- Premium Price Ticker -->
             <div style="display:flex; background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:10px 14px; margin-bottom:12px; align-items:center; justify-content:space-between; box-shadow:inset 0 2px 10px rgba(0,0,0,0.4);">
                <div style="display:flex; flex-direction:column; gap:4px;">
                   <span style="font-family:var(--font-secondary); font-size:8px; font-weight:700; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.1em;">Realtime (Pyth)</span>
                   <div style="font-family:var(--font-primary); font-size:18px; font-weight:800; color:var(--text-primary); text-shadow:0 0 12px rgba(255,255,255,0.15); line-height:1;">
                      ${data.realtimePrice !== "-" ? `$${data.realtimePrice.replace(/^\$/, '')}` : '<span style="font-size:11px;color:rgba(255,255,255,0.2);">WAITING DATA</span>'}
                   </div>
                </div>
                
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:0 12px;">
                   <div style="width:1px; height:8px; background:rgba(255,255,255,0.1); margin-bottom:4px;"></div>
                   <span style="font-family:var(--font-secondary); font-size:8px; font-weight:800; color:rgba(255,255,255,0.2); font-style:italic;">VS</span>
                   <div style="width:1px; height:8px; background:rgba(255,255,255,0.1); margin-top:4px;"></div>
                </div>
                
                <div style="display:flex; flex-direction:column; gap:4px; text-align:right;">
                   <span style="font-family:var(--font-secondary); font-size:8px; font-weight:700; color:var(--neon-cyan); text-transform:uppercase; letter-spacing:0.1em; opacity:0.8;">Price to Beat</span>
                   <div style="font-family:var(--font-primary); font-size:18px; font-weight:800; color:var(--neon-cyan); text-shadow:0 0 12px rgba(6,182,212,0.4); line-height:1;">
                      ${data.targetPrice !== "-" ? `$${data.targetPrice.replace(/^\$/, '')}` : '<span style="font-size:11px;color:rgba(255,255,255,0.2);">WAITING DATA</span>'}
                   </div>
                </div>
             </div>

             <!-- AI Rationale -->
             <div style="border-left:2px solid rgba(16,185,129,0.3); padding-left:12px; margin-left:2px;">
                <span style="font-family:var(--font-secondary); font-size:8px; font-weight:700; color:rgba(255,255,255,0.3); text-transform:uppercase; margin-bottom:4px; letter-spacing:0.1em; display:block;">AI Rationale Snippet</span>
                <p style="margin:0; font-family:var(--font-secondary); font-size:10.5px; line-height:1.45; color:var(--text-secondary); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${data.summary}</p>
             </div>
             
          </div>
          
          <div class="msp-vline"></div>
          <div class="msp-entry-block">
            <div class="msp-entry-val" style="color:${entryColor};">${data.entry}</div>
            <span class="msp-field-label">Entry Status</span>
          </div>
        </div>
        <div class="msp-hline"></div>
        <div class="msp-strip">
          <div class="msp-strip-item">
            <span class="msp-strip-label">LIQUIDITY</span>
            <span class="msp-strip-val" style="color:var(--neon-green);">${data.liquidity}</span>
          </div>
          <div class="msp-strip-sep"></div>
          <div class="msp-strip-item">
            <span class="msp-strip-label">GAMMA VOL</span>
            <span class="msp-strip-val" style="color:var(--neon-cyan);">${data.gammaVol}</span>
          </div>
          <div class="msp-strip-sep"></div>
          <div class="msp-strip-item msp-strip-item--wide">
            <span class="msp-strip-label">ORDERBOOK</span>
            <span class="msp-strip-val" style="color:var(--text-primary); font-size:12px;">${data.orderbook}</span>
          </div>
          <div class="msp-strip-sep"></div>
          <div class="msp-strip-item">
            <span class="msp-strip-label">DATA CONF</span>
            <span class="msp-strip-val" style="color:var(--text-secondary);">${data.conf}</span>
          </div>
          <div class="msp-strip-sep"></div>
          <div class="msp-strip-item">
            <span class="msp-strip-label">QWEN</span>
            <span class="msp-strip-val" style="color:var(--neon-purple);">${data.qwenScore}</span>
          </div>
        </div>
        <div class="msp-hline"></div>
        <div class="msp-depth">
          <div class="msp-depth-meta">
            <span class="msp-depth-bid-txt">BID ${bidStr}</span>
            <span class="msp-depth-center-txt">MARKET DEPTH</span>
            <span class="msp-depth-ask-txt">ASK ${askStr}</span>
          </div>
          <div class="msp-depth-bar">
            <div class="msp-depth-bid-fill" style="width:${bidPct}%;"></div>
            <div class="msp-depth-ask-fill" style="width:${askPct}%;"></div>
          </div>
        </div>
  `;
}

// ==========================================
// BULK TRADE PANEL LOGIC
// ==========================================

window.openTradePanel = async function() {
  document.getElementById('tradePanelModal').style.display = 'flex';
  await populateTradePanel();
};

window.closeTradePanel = function() {
  document.getElementById('tradePanelModal').style.display = 'none';
};

window.selectAllTradeItems = function() {
  const items = document.querySelectorAll('.trade-item');
  if (items.length === 0) return;
  const allSelected = Array.from(items).every(item => item.classList.contains('selected'));
  
  items.forEach(item => {
    if (allSelected) {
      item.classList.remove('selected');
    } else {
      item.classList.add('selected');
    }
  });
};

window.toggleTradeItem = function(element) {
  element.classList.toggle('selected');
};

async function populateTradePanel() {
  const listEl = document.getElementById('tradePanelList');
  listEl.innerHTML = '<div style="text-align:center; padding:30px; color:#aaa;">Loading queue & predictions...</div>';
  document.getElementById('tradePanelStatus').innerText = '';
  
  try {
    const queueData = { queue: Array.isArray(analysisQueue) ? analysisQueue : [] };
    
    if (!queueData.queue || queueData.queue.length === 0) {
      listEl.innerHTML = '<div style="text-align:center; padding:30px; color:#666; font-size:12px;">Queue is empty. Analyze some events first.</div>';
      return;
    }
    
    if (!Array.isArray(allHistoryEvents) || allHistoryEvents.length === 0) {
      if (typeof fetchHistoryEvents === 'function') await fetchHistoryEvents(); 
    }
    
    let html = '';
    let hasValid = false;
    
    queueData.queue.forEach(item => {
      const historyMatch = (allHistoryEvents || []).find(h => String(h.market_id) === String(item.id));
      
      let predictionText = "UNKNOWN";
      let predictionColor = "#aaa";
      let canTrade = false;
      
      if (historyMatch && historyMatch.prediction) {
        const pred = historyMatch.prediction.toUpperCase();
        if (pred === "YES" || pred === "UP") {
          predictionText = pred;
          predictionColor = "var(--neon-green)";
          canTrade = true;
        } else if (pred === "NO" || pred === "DOWN") {
          predictionText = pred;
          predictionColor = "var(--neon-red)";
          canTrade = true;
        } else {
          predictionText = "NETRAL / SKIP";
        }
      } else {
        predictionText = item.status === "DONE" ? "WAITING FOR SYNC" : item.status;
      }
      
      if (!canTrade) {
        html += `
          <div class="trade-item" style="opacity:0.5; cursor:not-allowed;">
            <div class="trade-checkbox"></div>
            <div style="flex:1; overflow:hidden;">
              <div style="font-size:12px; font-weight:bold; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.question || item.id}</div>
              <div style="font-size:10px; color:#aaa;">Signal: ${predictionText} (Cannot Trade)</div>
            </div>
          </div>
        `;
      } else {
        hasValid = true;
        html += `
          <div class="trade-item selected" onclick="toggleTradeItem(this)" data-marketid="${item.id}" data-prediction="${predictionText}">
            <div class="trade-checkbox"></div>
            <div style="flex:1; overflow:hidden;">
              <div style="font-size:12px; font-weight:bold; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.question || item.id}</div>
              <div style="font-size:10px; color:#ccc;">AI Signal: <span style="color:${predictionColor}; font-weight:bold;">${predictionText}</span></div>
            </div>
          </div>
        `;
      }
    });
    
    if (!hasValid) {
      html += '<div style="text-align:center; padding:10px; color:#666; font-size:12px;">No clear UP/DOWN signals in the queue to trade.</div>';
    }
    
    listEl.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = `<div style="text-align:center; padding:30px; color:var(--neon-red);">${err.message}</div>`;
  }
}

window.executeBulkTrade = async function() {
  const selectedItems = document.querySelectorAll('.trade-item.selected');
  if (selectedItems.length === 0) {
    alert("Please select at least one market to trade.");
    return;
  }
  
  const sizeInput = document.getElementById('tradePanelSizeInput').value;
  const sizeUsdc = parseFloat(sizeInput);
  if (isNaN(sizeUsdc) || sizeUsdc <= 0) {
    alert("Please enter a valid Trade Size (USDC).");
    return;
  }
  
  const trades = [];
  selectedItems.forEach(el => {
    trades.push({
      marketId: el.getAttribute('data-marketid'),
      prediction: el.getAttribute('data-prediction'),
      sizeUsdc: sizeUsdc
    });
  });

  const totalUsdc = trades.reduce((sum, trade) => sum + trade.sizeUsdc, 0);
  if (!window.confirm(`Confirm ${trades.length} FOK order(s), maximum total ${totalUsdc.toFixed(2)} USDC? Unfilled orders will be cancelled.`)) {
    return;
  }
  
  const statusEl = document.getElementById('tradePanelStatus');
  const btn = document.getElementById('btnExecuteTrade');
  
  btn.disabled = true;
  btn.innerText = "EXECUTING...";
  btn.style.opacity = "0.5";
  statusEl.style.color = "var(--neon-green)";
  statusEl.innerText = `Sending ${trades.length} market orders to Polygon...`;
  
  try {
    const res = await fetch("/api/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trades,
        idempotencyKey: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      })
    });
    
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Execution failed");
    
    let successCount = 0;
    let failCount = 0;
    data.results.forEach(r => {
      if (r.success) successCount++;
      else failCount++;
    });
    
    statusEl.innerText = `Done! ${successCount} successful, ${failCount} failed.`;
    if (failCount > 0) statusEl.style.color = "var(--neon-red)";
    
    setTimeout(() => { if (typeof fetchWsStatus === 'function') fetchWsStatus(); }, 2000); 
    
  } catch (err) {
    statusEl.style.color = "var(--neon-red)";
    statusEl.innerText = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.innerText = "EXECUTE TRADES";
    btn.style.opacity = "1";
  }
};

window.triggerMarketPulse = async (asset) => {
  if (typeof injectMspStyles === "function") injectMspStyles();

  const panel = document.getElementById("staticResultPanel");
  const body = document.getElementById("staticResultBody");
  if (!panel || !body) return;
  
  panel.style.display = "flex"; // Show panel
  
  // Custom Loading UI for Pulse
  body.innerHTML = `
      <div style="min-height:220px; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; position:relative;">
        <span class="msp-link" onclick="closeStaticPanel()" style="position:absolute; top:-4px; right:-4px; cursor:pointer; color:rgba(255,255,255,0.3); display:flex; align-items:center; gap:4px; font-size:10px; font-weight:bold; text-transform:uppercase;"><i data-lucide="x" style="width:12px;height:12px;"></i> Tutup</span>
        <div style="width:32px; height:32px; border:3px solid rgba(6,182,212,0.2); border-top-color:var(--neon-cyan); border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 16px;"></div>
        <div style="font-family:var(--font-primary); font-size:14px; font-weight:800; color:var(--neon-cyan); letter-spacing:0.2em; text-transform:uppercase;">Scanning Pulse</div>
        <div style="font-family:var(--font-secondary); font-size:10px; color:rgba(255,255,255,0.4); margin-top:8px; text-transform:uppercase; letter-spacing:1px;">Evaluating ${asset} momentum...</div>
      </div>
  `;

  try {
    const symbol = asset + "USDT";
    const tf = (window.iccCharts && window.iccCharts[symbol] && window.iccCharts[symbol].currentTf) ? window.iccCharts[symbol].currentTf : "15m";

    const res = await fetch("/api/market-pulse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset, tf })
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server Error (${res.status}): ${errText}`);
    }
    
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to fetch pulse");

    const pulse = data.data;
    const ticker = pulse.tickerData || {};
    const ev = pulse.evaluation || {};
    const dir = ev.direction || "UNKNOWN";
    const dirColor = dir === "UP" ? "var(--neon-green)" : dir === "DOWN" ? "var(--neon-red)" : "var(--neon-amber)";

    // Render Custom Pulse UI
    body.innerHTML = `
        <div class="msp-top-row">
           <div class="msp-eyebrow" style="display:flex; align-items:center; gap:6px;">
             <i data-lucide="activity" style="width:12px; height:12px; color:var(--neon-cyan);"></i>
             <span style="color:var(--neon-cyan); font-weight:800; letter-spacing:0.25em;">NEURAL MARKET PULSE</span>
           </div>
           <div style="display:flex; gap:12px; align-items:center;">
             <span style="font-family:var(--font-secondary); font-size:10px; color:var(--text-secondary); font-weight:700;">${asset} USDT-M</span>
             <span class="msp-link" onclick="closeStaticPanel()" style="cursor:pointer; color:var(--neon-red); margin-left:8px; display:flex; align-items:center; gap:4px; text-transform:uppercase; font-size:10px; font-weight:800;" title="Tutup Panel"><i data-lucide="x" style="width:12px;height:12px;"></i> Tutup</span>
           </div>
        </div>
        
        <div class="msp-hero-row">
          <div class="msp-signal-block">
            <div class="msp-signal-pill" style="background:${dirColor}15; border:1px solid ${dirColor}40; color:${dirColor};">
              <span class="msp-signal-text">${dir}</span>
            </div>
            <span class="msp-field-label">AI Verdict</span>
          </div>
          <div class="msp-vline"></div>
          
          <div style="flex:2.2; display:flex; flex-direction:column; justify-content:center; padding:0 12px;">
             <div style="display:flex; background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:10px 14px; margin-bottom:12px; align-items:center; justify-content:space-between; box-shadow:inset 0 2px 10px rgba(0,0,0,0.4);">
                <div style="display:flex; flex-direction:column; gap:4px;">
                   <span style="font-family:var(--font-secondary); font-size:8px; font-weight:700; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.1em;">Current Price</span>
                   <div style="font-family:var(--font-primary); font-size:18px; font-weight:800; color:var(--text-primary); text-shadow:0 0 12px rgba(255,255,255,0.15); line-height:1;">
                      $${ticker.currentPrice || '-'}
                   </div>
                </div>
                
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:0 12px;">
                   <div style="width:1px; height:8px; background:rgba(255,255,255,0.1); margin-bottom:4px;"></div>
                   <span style="font-family:var(--font-secondary); font-size:8px; font-weight:800; color:rgba(255,255,255,0.2); font-style:italic;">CHG</span>
                   <div style="width:1px; height:8px; background:rgba(255,255,255,0.1); margin-top:4px;"></div>
                </div>
                
                <div style="display:flex; flex-direction:column; gap:4px; text-align:right;">
                   <span style="font-family:var(--font-secondary); font-size:8px; font-weight:700; color:${parseFloat(ticker.priceChange24h) >= 0 ? 'var(--neon-green)' : 'var(--neon-red)'}; text-transform:uppercase; letter-spacing:0.1em; opacity:0.8;">24h Change</span>
                   <div style="font-family:var(--font-primary); font-size:18px; font-weight:800; color:${parseFloat(ticker.priceChange24h) >= 0 ? 'var(--neon-green)' : 'var(--neon-red)'}; line-height:1;">
                      ${parseFloat(ticker.priceChange24h) > 0 ? '+' : ''}${ticker.priceChange24h || 0}%
                   </div>
                </div>
             </div>
             
             <!-- Recommendation Snippet -->
             <div style="border-left:2px solid ${dirColor}; padding-left:12px; margin-left:2px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                   <span style="font-family:var(--font-secondary); font-size:8px; font-weight:700; color:rgba(255,255,255,0.3); text-transform:uppercase; margin-bottom:4px; letter-spacing:0.1em; display:block;">Recommendation</span>
                   <p style="margin:0; font-family:var(--font-secondary); font-size:11px; font-weight:600; color:var(--text-primary); text-transform:uppercase;">${ev.recommendation || 'N/A'}</p>
                </div>
                <button onclick="window.showPulseReason()" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:6px 12px; color:var(--neon-cyan); font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:1px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='rgba(6,182,212,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">View Logic</button>
             </div>
          </div>
        </div>
        
        <div class="msp-hline"></div>
        <div class="msp-strip">
          <div class="msp-strip-item">
            <span class="msp-strip-label">RSI (14)</span>
            <span class="msp-strip-val" style="color:var(--text-primary); font-size:12px;">${ticker.rsi14 ?? '-'}</span>
            <span style="font-size:8px; font-weight:700; color:var(--neon-amber); margin-top:2px;">${ticker.rsiSignal || 'NEUTRAL'}</span>
          </div>
          <div class="msp-strip-sep"></div>
          <div class="msp-strip-item">
            <span class="msp-strip-label">VOL MOMENTUM</span>
            <span class="msp-strip-val" style="color:var(--neon-cyan); font-size:12px;">${ticker.volumeRatio ?? '-'}x</span>
            <span style="font-size:8px; font-weight:700; color:rgba(255,255,255,0.4); margin-top:2px;">${ticker.volumeSignal || 'NORMAL'}</span>
          </div>
          <div class="msp-strip-sep"></div>
          <div class="msp-strip-item">
            <span class="msp-strip-label">MACD TREND</span>
            <span class="msp-strip-val" style="color:${ticker.macd && ticker.macd.trend === 'BULLISH' ? 'var(--neon-green)' : (ticker.macd && ticker.macd.trend === 'BEARISH' ? 'var(--neon-red)' : 'var(--neon-amber)')}; font-size:12px;">${ticker.macd ? ticker.macd.histogram : '-'}</span>
            <span style="font-size:8px; font-weight:700; color:rgba(255,255,255,0.4); margin-top:2px;">${ticker.macd ? ticker.macd.trend : 'NEUTRAL'}</span>
          </div>
        </div>
    `;

    // Bind function to global scope to be called by onclick
    window.currentPulseReasonHTML = `
      <div style="font-family:var(--font-primary);">
        <h3 style="color:${dirColor}; font-size:18px; font-weight:800; text-transform:uppercase; margin-bottom:16px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:8px;">Qwen Engine Reasoning (${asset} ${dir})</h3>
        <div style="font-size:14px; color:var(--text-secondary); line-height:1.8;">
          ${(ev.reason || "Menunggu hasil analisa...").replace(/\n/g, '<br/>')}
        </div>
      </div>
    `;
    window.showPulseReason = function() {
      document.getElementById('summaryModalContent').innerHTML = window.currentPulseReasonHTML;
      document.getElementById('summaryModal').style.display = 'flex';
    };
    
  } catch(err) {
    body.innerHTML = `
      <div style="align-items:center; text-align:center; padding:12px; position:relative;">
        <span class="msp-link" onclick="closeStaticPanel()" style="position:absolute; top:-4px; right:-4px; cursor:pointer; color:var(--neon-red); display:flex; align-items:center; gap:4px; font-size:10px; font-weight:bold; text-transform:uppercase;"><i data-lucide="x" style="width:12px;height:12px;"></i> Tutup</span>
        <i data-lucide="alert-triangle" style="width:32px; height:32px; margin-bottom:12px; color:var(--neon-red);"></i>
        <div style="font-family:var(--font-primary); font-size:14px; font-weight:900; color:var(--neon-red); letter-spacing:1px; text-transform:uppercase; margin-bottom:12px;">Pulse Check Failed</div>
        <div style="font-family:var(--font-secondary); font-size:11px; color:rgba(255,255,255,0.6); line-height:1.6; background:rgba(0,0,0,0.3); padding:12px 16px; border-radius:8px; max-width:400px; text-align:left; margin:0 auto;">${err.message}</div>
      </div>
    `;
    if(window.lucide) window.lucide.createIcons({root: body});
  }
};
