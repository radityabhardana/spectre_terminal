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
let duplicateCommandCooldownMs = 15000;
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
      if (savedActiveId && outputTabs.has(savedActiveId)) {
        activeTabId = savedActiveId;
      } else if (outputTabs.size > 0) {
        activeTabId = outputTabs.keys().next().value;
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
    if (polyPanelContainer) polyPanelContainer.style.display = "none";
    if (historyListPanel) {
      historyListPanel.style.display = "flex";
      renderHistoryListPanel();
    }
    if (consoleBody) consoleBody.classList.add("has-embed");
  } else {
    if (polyPanelContainer) polyPanelContainer.style.display = "";
    if (historyListPanel) historyListPanel.style.display = "none";
    
    if (consoleBody) {
      // Return has-embed to its natural state for console tab based on iframe
      const polyFrame = document.querySelector("#polyFrame");
      if (polyFrame && !polyFrame.classList.contains("hidden")) {
        consoleBody.classList.add("has-embed");
      } else {
        consoleBody.classList.remove("has-embed");
      }
    }
  }
}

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
  } else if (timerId) {
    clearInterval(timerId);
    timerId = null;
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
  url.searchParams.set("height", "650");
  return url.toString();
}

function setPolymarketEmbed(value, source = "Detected market") {
  const embedUrl = embedUrlFromPolymarketUrl(value);
  if (!embedUrl) return false;
  polyFrame.src = embedUrl;
  polyFrame.classList.remove("hidden");
  polyEmpty.classList.add("hidden");
  polyTitle.textContent = source;
  polyOpenLink.href = value;
  polyOpenLink.classList.remove("disabled");
  // Show the poly panel by adding has-embed to console-body
  const consoleBody = document.querySelector(".console-body");
  if (consoleBody) consoleBody.classList.add("has-embed");
  return true;
}

function syncPolymarketEmbedFromText(text, source) {
  const urls = polymarketUrlsFromText(text);
  if (source === "From result" && (urls.length > 1 || /^TOP MARKETS\b|^SEARCH RESULTS\b/i.test(String(text || "")))) {
    return;
  }
  const [firstUrl] = urls;
  if (firstUrl) setPolymarketEmbed(firstUrl, source);
}

/* --- Rendering --- */
function renderMessages() {
  messagesEl.innerHTML = "";
  const tab = activeTab();
  const messages = tab?.messages || [];
  emptyState.classList.toggle("hidden", messages.length > 0);
  for (const message of messages) appendMessageElement(message);
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
    
    for (const line of lines) {
      if (!line.trim()) {
        html += "<br>";
        continue;
      }
      
      // All-caps headers (e.g. MARKET SUMMARY, KESIMPULAN CEPAT)
      if (/^[A-Z0-9 \-&/]{3,}$/.test(line.trim())) {
        html += `<div class="msg-header">${line}</div>`;
      } 
      else if (/^([^:]+):(.*)$/.test(line)) {
        const match = line.match(/^([^:]+):(.*)$/);
        const key = match[1];
        let val = match[2];

        if (key === "Realtime Ticker" && val.trim().length > 0) {
          const payload = val.trim();
          html += `<div class="msg-kv" style="flex-direction:column; align-items:flex-start; margin-top:8px; background:rgba(0,0,0,0.2); padding:8px; border-radius:6px; border:1px solid var(--border);"><span class="live-ticker" data-tokens="${payload}" style="width:100%; display:flex; flex-direction:column; gap:6px;">⏳ Syncing CLOB & Crypto Feed...</span></div>`;
          continue;
        }
        
        // Highlight percentages and money
        val = val.replace(/(\$[\d,]+(\.\d+)?|\d+(\.\d+)?%)/g, '<span class="hl-val">$1</span>');
        
        html += `<div class="msg-kv"><span class="msg-k">${key}:</span><span class="msg-v">${val}</span></div>`;
      } 
      // List items
      else if (line.trim().startsWith("- ")) {
        html += `<div class="msg-li">${line.replace("- ", "<span class='msg-bullet'>•</span> ")}</div>`;
      } 
      // Normal text
      else {
        html += `<div class="msg-text">${line}</div>`;
      }
    }
    body.innerHTML = html;
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

let isAudioMuted = false;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playAlertSound() {
  if (isAudioMuted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, audioCtx.currentTime); // High pitch (A5)
  osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.5); // Drop pitch like an alert
  
  gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
  
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  
  osc.start();
  osc.stop(audioCtx.currentTime + 0.5);
}

function playQueueDoneSound() {
  if (isAudioMuted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, audioCtx.currentTime); 
  osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1); 
  
  gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
  gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
  
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  
  osc.start();
  osc.stop(audioCtx.currentTime + 0.3);
}

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
      
      let cryptoPrice = null;
      let cryptoOpen = null;
      let cryptoSymbol = "";
      if (question.includes("bitcoin") || question.includes("btc")) {
        cryptoSymbol = "BTC";
      } else if (question.includes("ethereum") || question.includes("eth")) {
        cryptoSymbol = "ETH";
      } else if (question.includes("dogecoin") || question.includes("doge")) {
        cryptoSymbol = "DOGE";
      }
      
      let klineInterval = "1h";
      let intervalLabel = "1H";
      let msInterval = 60 * 60 * 1000;
      if (question.includes("5m") || question.includes("5 min") || question.includes("5-min")) {
        klineInterval = "5m";
        intervalLabel = "5M";
        msInterval = 5 * 60 * 1000;
      } else if (question.includes("15m") || question.includes("15 min") || question.includes("15-min")) {
        klineInterval = "15m";
        intervalLabel = "15M";
        msInterval = 15 * 60 * 1000;
      } else if (question.includes("30m") || question.includes("30 min") || question.includes("30-min")) {
        klineInterval = "30m";
        intervalLabel = "30M";
        msInterval = 30 * 60 * 1000;
      }
      
      if (cryptoSymbol) {
        try {
          const pythIds = {
            BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
            ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
            DOGE: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c"
          };
          const pid = pythIds[cryptoSymbol];
          
          if (pid) {
            // Fetch exact Pyth Oracle current price
            const pRes = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${pid}&_t=${Date.now()}`, { cache: 'no-store' });
            if (pRes.ok) {
              const pData = await pRes.json();
              const pInfo = pData.parsed?.[0]?.price;
              if (pInfo) {
                cryptoPrice = parseFloat(pInfo.price) * Math.pow(10, pInfo.expo);
              }
            }
            
            // Fetch the exact Pyth Oracle price at the exact start of the candle
            const startTs = Math.floor((Math.floor(Date.now() / msInterval) * msInterval) / 1000);
            let kRes = await fetch(`https://hermes.pyth.network/v2/updates/price/${startTs}?ids[]=${pid}&_t=${Date.now()}`, { cache: 'no-store' });
            // Retry with -5s offset if Pyth hasn't indexed the exact timestamp yet
            if (!kRes.ok || kRes.status === 404) {
              kRes = await fetch(`https://hermes.pyth.network/v2/updates/price/${startTs - 5}?ids[]=${pid}&_t=${Date.now()}`, { cache: 'no-store' });
            }
            if (kRes.ok) {
              try {
                const kData = await kRes.json();
                const kInfo = kData.parsed?.[0]?.price;
                if (kInfo) {
                  cryptoOpen = parseFloat(kInfo.price) * Math.pow(10, kInfo.expo);
                }
              } catch(e) {}
            }
          }
        } catch (e) {}
      }

      const getMidpoint = async (token) => {
        if (!token || token === "undefined") return null;
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${token}&_t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const data = await res.json();
        const bestBid = data.bids && data.bids.length ? Number(data.bids[0].price) : null;
        const bestAsk = data.asks && data.asks.length ? Number(data.asks[0].price) : null;
        if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
        if (bestBid != null) return bestBid;
        if (bestAsk != null) return bestAsk;
        return null;
      };

      const [primaryMid, secondaryMid] = await Promise.all([
        getMidpoint(primaryToken),
        getMidpoint(secondaryToken)
      ]);
      
      let displayHtml = "";
      if (cryptoSymbol && cryptoPrice) {
        let decimals = cryptoSymbol === "DOGE" ? 4 : 2;
        let pBeatStr = cryptoOpen ? `$${cryptoOpen.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}` : "TBD";
        let isWinning = cryptoOpen ? cryptoPrice >= cryptoOpen : true;
        let color = cryptoOpen ? (isWinning ? "var(--neon-green)" : "var(--neon-amber)") : "var(--text-primary)";
        
        let oracleTag = `<div style="font-size:10px; color:var(--text-tertiary); margin-top:2px;">*Using true Pyth Oracle matching Polymarket UI</div>`;
        displayHtml += `<div style="font-size:13px; color:var(--text-primary); font-weight:bold; margin-bottom:4px; display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; justify-content:space-between;">
            <span style="color:var(--text-secondary); font-size:11px;">Price to Beat (${intervalLabel} Open):</span> 
            <span style="color:var(--text-primary);">${pBeatStr}</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span style="color:var(--text-secondary); font-size:11px;">Current ${cryptoSymbol} Price:</span> 
            <span style="${color};">$${cryptoPrice.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}</span>
          </div>
          ${oracleTag}
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
          <div style="color:var(--neon-amber); font-weight:bold; font-size:14px;">${Math.round(secondaryMid * 100)}¢</div>
        </div>`;
      }
      displayHtml += `</div>`;
      
      document.querySelectorAll(`.live-ticker[data-tokens="${payload}"]`).forEach(el => {
        el.innerHTML = displayHtml;
      });
      
      // Update the Polymarket Embed Overlay for the LATEST payload
      const tickersArr = Array.from(tickers);
      const latestPayload = tickersArr[tickersArr.length - 1].getAttribute('data-tokens');
      if (payload === latestPayload) {
        const polyLiveTicker = document.querySelector("#polyLiveTicker");
        const polyMidpoint = document.querySelector("#polyMidpoint");
        const polyBestBid = document.querySelector("#polyBestBid");
        const polyBestAsk = document.querySelector("#polyBestAsk");
        const polyFrame = document.querySelector("#polyFrame");
        
        if (polyLiveTicker && polyMidpoint && polyFrame && !polyFrame.classList.contains("hidden")) {
          polyLiveTicker.style.display = "block";
          if (cryptoSymbol && cryptoPrice) {
            let decimals = cryptoSymbol === "DOGE" ? 4 : 2;
            let pBeatStr = cryptoOpen ? `$${cryptoOpen.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}` : "TBD";
            let isWinning = cryptoOpen ? cryptoPrice >= cryptoOpen : true;
            let color = cryptoOpen ? (isWinning ? "var(--neon-green)" : "var(--neon-amber)") : "var(--text-primary)";
            
            polyMidpoint.innerHTML = `<div><span style="font-size:11px; color:var(--text-tertiary);">Price to Beat:</span> <span style="color:white;">${pBeatStr}</span></div>` +
                                     `<div style="margin-top:2px;"><span style="font-size:11px; color:var(--text-tertiary);">Current:</span> <span style="${color};">$${cryptoPrice.toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals})}</span></div>`;
          } else {
            polyMidpoint.textContent = "Live Market Data";
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
    emptyState.classList.add("hidden");
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
function addError(text, tabId) { addMessage({ role: "error", text }, tabId); }

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

  // Hide short market panel when executing a command
  const shortMarketPanel = document.querySelector("#shortMarketPanel");
  if (shortMarketPanel) shortMarketPanel.style.display = "none";

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
      body: JSON.stringify({ text, mode: "auto" }),
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
      return;
    }

    for (const msg of data.messages || []) addMessage(msg, tabInfo.id);
  } catch (error) {
    if (error.name === "AbortError") {
      addError("Prompt dibatalkan.", tabInfo.id);
    } else {
      addError(error.message || String(error), tabInfo.id);
    }
  } finally {
    activeRequest = null;
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

    qwenStatus.classList.toggle("warn", !qwenConfigured || serverOutdated);
    qwenStatus.classList.toggle("ai", qwenConfigured && !serverOutdated);
    
    const isError = !qwenConfigured || serverOutdated;
    const baseText = serverOutdated ? "Server old" : qwenLabel || "Qwen ?";
    qwenStatus.innerHTML = isError ? `<span style="display:flex; align-items:center; gap:4px; cursor:pointer;" title="Click to reconnect"><i data-lucide="refresh-cw" style="width:10px; height:10px;"></i> ${baseText}</span>` : baseText;
    if (isError && typeof lucide !== 'undefined') lucide.createIcons();
    qwenStatus.style.cursor = isError ? "pointer" : "default";

    if (connDot) connDot.className = "status-bar-dot";
    if (connLabel) connLabel.textContent = "Connected";
    if (sbEngine) sbEngine.textContent = `Engine: ${shortLabel(version, 40)}`;
    if (sbLatency) sbLatency.textContent = `${latency}ms`;
    if (sbQwenDot) sbQwenDot.className = qwenConfigured ? "status-bar-dot ai" : "status-bar-dot warn";
    if (sbQwenLabel) sbQwenLabel.textContent = qwenConfigured ? "Qwen: ✓ loaded" : "Qwen: ✗ missing";
  } catch {
    versionText.textContent = "Engine offline";
    qwenStatus.classList.add("warn");
    qwenStatus.classList.remove("ai");
    qwenStatus.innerHTML = `<span style="display:flex; align-items:center; gap:4px; cursor:pointer;" title="Click to reconnect"><i data-lucide="refresh-cw" style="width:10px; height:10px;"></i> Offline</span>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    qwenStatus.style.cursor = "pointer";
    if (connDot) connDot.className = "status-bar-dot error";
    if (connLabel) connLabel.textContent = "Disconnected";
    if (sbEngine) sbEngine.textContent = "Engine: offline";
    if (sbQwenDot) sbQwenDot.className = "status-bar-dot error";
    if (sbQwenLabel) sbQwenLabel.textContent = "Qwen: offline";
    if (sbLatency) sbLatency.textContent = "--ms";
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
if (togglePolyBtn) {
  togglePolyBtn.addEventListener("click", () => {
    const consoleBody = document.querySelector(".console-body");
    if (consoleBody) {
      consoleBody.classList.toggle("has-embed");
      // If turning on but empty, show default empty state
      if (consoleBody.classList.contains("has-embed") && polyFrame.classList.contains("hidden")) {
        polyEmpty.classList.remove("hidden");
      }
    }
  });
}




/* --- Short Market Logic --- */
const btnShortMarket = document.querySelector("#btnShortMarket");
const shortMarketPanel = document.querySelector("#shortMarketPanel");
const btnRefreshShortMarket = document.querySelector("#btnRefreshShortMarket");
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
  if (tabAssetBtc) tabAssetBtc.style.color = activeShortAsset === 'btc' ? 'var(--neon-amber)' : 'var(--text-tertiary)';
  if (tabAssetEth) tabAssetEth.style.color = activeShortAsset === 'eth' ? 'var(--neon-amber)' : 'var(--text-tertiary)';
  if (tabAssetDoge) tabAssetDoge.style.color = activeShortAsset === 'doge' ? 'var(--neon-amber)' : 'var(--text-tertiary)';
}

if (btnShortMarket && shortMarketPanel) {
  document.body.appendChild(shortMarketPanel); // Escape stacking context
  btnShortMarket.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = shortMarketPanel.style.display === "none";
    if (isHidden) {
      const rect = btnShortMarket.getBoundingClientRect();
      shortMarketPanel.style.top = (rect.bottom + 8) + "px";
      shortMarketPanel.style.right = (window.innerWidth - rect.right) + "px";
      shortMarketPanel.style.display = "block";
      
      activeShortAsset = "btc";
      if (shortDurationSelect) {
        shortDurationSelect.value = activeShortDuration;
      }
      updateActiveAssetTab();
      fetchShortMarkets();
      startShortRealtimeTimer();
    } else {
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
    } else {
      queuePanel.style.display = "none";
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
  if (analysisQueue.length >= 10) {
    showCustomAlert("Antrian maksimal 10 market.");
    return;
  }
  
  // Ambil data market penuh dari list kalau ada, supaya bisa render jam
  const fullMarket = currentShortMarkets.find(m => m.id === marketData.id);
  const queueItem = fullMarket || marketData;
  
  analysisQueue.push(queueItem);
  renderQueue();
}

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
    if (isSniperActive && !m.snipeFired) {
      sniperStatus = `<span style="color:var(--neon-amber); font-size:9px; border:1px solid var(--neon-amber); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">Wait</span>`;
    } else if (m.snipeFired) {
      sniperStatus = `<span style="color:var(--text-tertiary); font-size:9px; border:1px solid var(--border-bright); border-radius:2px; padding:1px 4px; margin-left:6px; flex-shrink:0;">Fired</span>`;
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
        const rColor = (r === 'MENANG') ? 'var(--neon-green)' : ((r === 'KALAH') ? 'var(--neon-red)' : 'var(--text-tertiary)');
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
    
    const min5 = document.querySelector("#sniper5mMin");
    const sec5 = document.querySelector("#sniper5mSec");
    const min15 = document.querySelector("#sniper15mMin");
    const sec15 = document.querySelector("#sniper15mSec");
    const min1h = document.querySelector("#sniper1hMin");
    const sec1h = document.querySelector("#sniper1hSec");
    
    const val5m = ((min5 && min5.value ? parseInt(min5.value) : 4) * 60) + (sec5 && sec5.value ? parseInt(sec5.value) : 30);
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
          m.snipeFired = true;
          sniperExecutionQueue.push(m.url);
          triggered = true;
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
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
  
  if (btnCloseQueue) {
    btnCloseQueue.style.opacity = isSniperActive ? "0.3" : "1";
    btnCloseQueue.style.cursor = isSniperActive ? "not-allowed" : "pointer";
  }
  
  renderQueue();
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

if (shortDurationSelect) {
  shortDurationSelect.addEventListener("change", (e) => {
    activeShortDuration = e.target.value;
    renderShortMarkets(currentShortMarkets);
  });
}

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
  }

  // Auto refresh if panel is open
  if (shortMarketPanel && shortMarketPanel.style.display === "block") {
    if (shortMarketTimer) clearTimeout(shortMarketTimer);
    shortMarketTimer = setTimeout(fetchShortMarkets, 5000); // 5 detik
  }
}

function renderShortMarkets(markets) {
  if (!shortMarketList) return;
  if (!markets || !markets.length) {
    shortMarketList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-tertiary);">No active ${activeShortAsset.toUpperCase()} markets found right now.</div>`;
    return;
  }

  const renderCard = (m) => {
    const timeToClose = new Date(m.endDate).getTime() - Date.now();
    const isClosingSoon = timeToClose > 0 && timeToClose < 2 * 60 * 1000;
    const isClosed = timeToClose <= 0;
    
    const pYes = m.outcomePrices[0] ? Math.round(m.outcomePrices[0] * 100) : 0;
    const pNo = m.outcomePrices[1] ? Math.round(m.outcomePrices[1] * 100) : 0;
    
    const labelYes = m.outcomes[0] || "Up";
    const labelNo = m.outcomes[1] || "Down";

    let timeColor = isClosed ? "var(--text-tertiary)" : (isClosingSoon ? "var(--neon-amber)" : "var(--neon-green)");
    let timeText = isClosed ? "Closed" : Math.floor(timeToClose / 60000) + "m " + Math.floor((timeToClose % 60000) / 1000) + "s";
    
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

    return `
      <div class="btc5m-card" draggable="true" data-id="${m.id}" data-url="${m.url}" data-question="${(m.question || '').replace(/"/g, '&quot;')}" ondragstart="handleDragStart(event, this)" ondragend="handleDragEnd(event)" style="padding:8px 10px; border:1px solid rgba(255,255,255,0.05); border-radius:4px; background:rgba(0,0,0,0.15); cursor:grab; transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'; this.style.borderColor='rgba(245,158,11,0.3)';" onmouseout="this.style.background='rgba(0,0,0,0.15)'; this.style.borderColor='rgba(255,255,255,0.05)';" onclick="analyzeShortMarket('${m.id}', '${m.url}')">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px; align-items:flex-start;">
          <span style="font-weight:600; color:var(--text-primary); font-size:11px; flex:1; min-width:0; word-wrap:break-word;">${m.groupItemTitle || m.question.replace(new RegExp(`${activeShortAsset} Up or Down -? ?`, 'i'), '').trim()}</span>
          <span class="short-market-timer" data-end-date="${m.endDate}" data-p-yes="${pYes}" data-p-no="${pNo}" data-l-yes="${labelYes}" data-l-no="${labelNo}" style="color:${timeColor}; font-weight:700; font-size:10px; white-space:nowrap; flex-shrink:0; text-align:right; margin-left:8px;">${timeText}</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; gap:8px;">
            <span style="color:var(--neon-green); font-size:10px;">${labelYes}: ${pYes}c</span>
            <span style="color:var(--neon-red); font-size:10px;">${labelNo}: ${pNo}c</span>
          </div>
          <span style="color:var(--text-tertiary); font-size:9px;">Vol: $${Math.round(m.volume || 0).toLocaleString()}</span>
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
}

function startShortRealtimeTimer() {
  if (shortMarketRealtimeInterval) clearInterval(shortMarketRealtimeInterval);
  shortMarketRealtimeInterval = setInterval(() => {
    document.querySelectorAll(".short-market-timer").forEach(el => {
      const endDate = el.getAttribute("data-end-date");
      if (!endDate) return;
      
      const timeToClose = new Date(endDate).getTime() - Date.now();
      const isClosingSoon = timeToClose > 0 && timeToClose < 2 * 60 * 1000;
      const isClosed = timeToClose <= 0;
      
      let timeColor = isClosed ? "var(--text-tertiary)" : (isClosingSoon ? "var(--neon-amber)" : "var(--neon-green)");
      let timeText = isClosed ? "Closed" : Math.floor(timeToClose / 60000) + "m " + Math.floor((timeToClose % 60000) / 1000) + "s";
      
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
  if (shortMarketPanel) shortMarketPanel.style.display = "none";
  if (shortMarketTimer) clearTimeout(shortMarketTimer);
  stopShortRealtimeTimer();
  
  const input = document.querySelector("#commandInput");
  if (input) {
    input.value = url || marketId;
    // Set action to analyze and trigger click
    const btnAnalyze = document.querySelector("#btnAnalyze");
    if (btnAnalyze) {
      btnAnalyze.click();
      const btnRun = document.querySelector("#runButton");
      if (btnRun) btnRun.click();
    }
  }
};

/* --- Analyzed Events History --- */
const historyModal = document.querySelector("#historyModal");
const btnHistory = document.querySelector("#btnHistory");
const closeHistoryModal = document.querySelector("#closeHistoryModal");
const historyTableBody = document.querySelector("#historyTableBody");
let allHistoryEvents = [];
let currentHistoryAsset = "all";
let currentHistoryDuration = "all";
let excludeNeutralFilter = false;

const excludeNeutralBtn = document.querySelector("#excludeNeutralBtn");
if (excludeNeutralBtn) {
  excludeNeutralBtn.addEventListener("change", (e) => {
    excludeNeutralFilter = e.target.checked;
    applyHistoryFilter();
  });
}

if (btnHistory && historyModal && closeHistoryModal) {
  btnHistory.addEventListener("click", () => {
    historyModal.style.display = "flex";
    const qp = document.querySelector("#queuePanel");
    if (qp) qp.style.display = "none";
    const smp = document.querySelector("#shortMarketPanel");
    if (smp) smp.style.display = "none";
    fetchHistoryEvents();
  });

  closeHistoryModal.addEventListener("click", () => {
    historyModal.style.display = "none";
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
      const q = e.question.toLowerCase();
      const u = e.url.toLowerCase();
      if (currentHistoryAsset === "btc") return q.includes("bitcoin") || q.includes("btc") || u.includes("btc");
      if (currentHistoryAsset === "eth") return q.includes("ethereum") || q.includes("eth") || u.includes("eth");
      if (currentHistoryAsset === "doge") return q.includes("dogecoin") || q.includes("doge") || u.includes("doge");
      return true;
    });
  }

  // 2. Filter by Duration
  if (currentHistoryDuration !== "all") {
    filtered = filtered.filter(e => {
      const q = e.question.toLowerCase();
      const u = e.url.toLowerCase();
      if (currentHistoryDuration === "5m") return u.includes("5m") || q.includes("5 min") || q.includes("5-min");
      if (currentHistoryDuration === "15m") return u.includes("15m") || q.includes("15 min") || q.includes("15-min");
      if (currentHistoryDuration === "1h") return u.includes("hourly") || u.includes("1h") || q.includes("1 hour") || q.includes("1-hour");
      return true;
    });
  }
  
  // 3. Filter Neutral
  if (excludeNeutralFilter) {
    filtered = filtered.filter(e => {
      if (!e.prediction) return true;
      const p = e.prediction.toUpperCase();
      return p !== 'SKIP' && p !== 'WATCHLIST' && p !== 'NETRAL' && p !== '=';
    });
  }
  
  renderHistoryEvents(filtered);
}

async function fetchHistoryEvents() {
  try {
    const res = await fetch("/api/history/events");
    const data = await res.json();
    if (data.ok) {
      allHistoryEvents = data.events;
      applyHistoryFilter();
      renderQueue(); // Refresh queue badges
      if (activeTabId === "history-archive") renderHistoryListPanel();
    }
  } catch (error) {
    console.error("Failed to fetch history events:", error);
  }
}

function renderHistoryListPanel() {
  const container = document.querySelector("#historyListContainer");
  if (!container || !allHistoryEvents) return;
  
  if (allHistoryEvents.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-tertiary);">Belum ada riwayat analisis.</div>';
    return;
  }

  let html = "";
  for (const event of allHistoryEvents) {
    const d = new Date(event.created_at);
    const timeStr = d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    const dateStr = d.toLocaleDateString("id-ID", { month: "short", day: "numeric" });
    
    let resultBadge = "";
    if (event.result && event.result !== "menunggu hasil") {
      const r = event.result.toUpperCase();
      const rColor = (r === 'MENANG') ? 'var(--neon-green)' : ((r === 'KALAH') ? 'var(--neon-red)' : 'var(--text-tertiary)');
      resultBadge = `<span title="Hasil Aktual" style="color:${rColor}; font-weight:bold; font-size:9px; border:1px solid ${rColor}; border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="flag" style="width:10px; height:10px; margin-right:4px;"></i> ${r}</span>`;
    }

    const pColor = (event.prediction === 'UP' || event.prediction === 'YES') ? 'var(--neon-green)' : ((event.prediction === 'DOWN' || event.prediction === 'NO') ? 'var(--neon-red)' : 'var(--text-tertiary)');
    const predBadge = `<span title="Prediksi AI" style="color:${pColor}; font-weight:bold; font-size:9px; border:1px solid ${pColor}; border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;"><i data-lucide="bot" style="width:10px; height:10px; margin-right:4px;"></i> ${event.prediction || '?'}</span>`;

    html += `
      <div onclick="showHistoryChat(${event.id})" style="padding:10px; border:1px solid rgba(255,255,255,0.05); border-radius:6px; background:rgba(0,0,0,0.2); cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'; this.style.borderColor='var(--neon-purple)';" onmouseout="this.style.background='rgba(0,0,0,0.2)'; this.style.borderColor='rgba(255,255,255,0.05)';">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="font-size:10px; color:var(--text-tertiary);">${dateStr} ${timeStr}</span>
          <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;">
            ${predBadge} ${resultBadge}
            ${event.qwen_confidence ? `<span title="Qwen Confidence" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;">Q: ${event.qwen_confidence}</span>` : ''}
            ${event.data_confidence ? `<span title="Data Confidence" style="color:var(--text-tertiary); font-weight:normal; font-size:9px; border:1px solid rgba(255,255,255,0.1); border-radius:2px; padding:1px 4px; display:inline-flex; align-items:center;">D: ${event.data_confidence}</span>` : ''}
          </div>
        </div>
        <div style="font-size:11px; font-weight:600; color:var(--text-primary); line-height:1.3; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">
          ${event.question}
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

window.showHistoryChat = function(eventId) {
  const event = allHistoryEvents.find(e => e.id === eventId);
  if (!event) return;
  
  // Set tab history-archive message log to this event's conclusion
  const tab = outputTabs.get("history-archive");
  if (tab) {
    tab.messages = []; // Clear
    // Tambahkan user prompt
    tab.messages.push({ role: "user", text: `Analyze Market: ${event.question}\nURL: ${event.url}` });
    
    // Tambahkan AI response
    let aiText = event.analysis_conclusion || "No detailed conclusion available.";
    
    // Karena kita tidak menyimpan text mentah full dari data.messages yang dikirim Qwen saat itu,
    // kita akan mem-formatting ulang conclusion agar terlihat proper seperti chat
    let formattedText = `## 🤖 ARCHIVED ANALYSIS\n\n**Market:** [${event.question}](${event.url})\n**Prediction:** ${event.prediction}\n**Result:** ${event.result}\n\n---\n\n${aiText}`;
    
    tab.messages.push({ role: "assistant", text: formattedText });
    
    renderMessages();
    saveState();
  }
}

function renderHistoryEvents(events) {
  let total = events.length;
  let wins = 0;
  let losses = 0;
  let pending = 0;

  let html = "";
  for (const event of events) {
    if (event.result === 'menang') wins++;
    else if (event.result === 'kalah') losses++;
    else pending++;

    const statusColor = event.status === 'selesai' ? (event.result === 'menang' ? 'var(--neon-green)' : 'var(--neon-red)') : 'var(--text-tertiary)';
    
    html += `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
        <td style="padding:10px 0;">
          <a href="${event.url}" target="_blank" style="color:var(--text-primary); text-decoration:none;">${event.question}</a>
        </td>
        <td style="padding:10px 0; color:var(--text-secondary); font-weight:bold;">${event.prediction || '-'}</td>
        <td style="padding:10px 0; color:var(--text-tertiary); text-transform:capitalize;">${event.status}</td>
        <td style="padding:10px 0;">
          <span style="color:${statusColor}; font-weight:bold; text-transform:capitalize;">${event.result || '-'}</span>
          ${event.qwen_confidence ? `<div style="font-size:9px; color:var(--text-tertiary); margin-top:4px;">Qwen Conf: ${event.qwen_confidence}/100</div>` : ''}
          ${event.data_confidence ? `<div style="font-size:9px; color:var(--text-tertiary);">Data Conf: ${event.data_confidence}/100</div>` : ''}
        </td>
        <td style="padding:10px 0; text-align:right;">
          <button class="action-chip" style="height:24px; font-size:10px; padding:0 8px; ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? 'opacity:0.5; cursor:not-allowed;' : ''}" 
                  onclick="checkHistoryEvent(${event.id}, '${event.market_id}', '${event.prediction}')"
                  ${event.status === 'selesai' && event.result !== 'menunggu hasil' ? 'disabled' : ''}>
            Periksa
          </button>
        </td>
      </tr>
    `;
  }

  historyTableBody.innerHTML = html || '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-tertiary);">Belum ada riwayat analisis.</td></tr>';
  
  document.querySelector("#historyTotal").textContent = total;
  document.querySelector("#historyWins").textContent = wins;
  document.querySelector("#historyLosses").textContent = losses;
  document.querySelector("#historyPending").textContent = pending;

  const resolved = wins + losses;
  const winRate = resolved > 0 ? Math.round((wins / resolved) * 100) : 0;
  
  const winRateEl = document.querySelector("#historyWinRate");
  winRateEl.textContent = `${winRate}%`;
  winRateEl.style.color = winRate >= 50 ? 'var(--neon-green)' : (winRate > 0 ? 'var(--neon-amber)' : 'var(--text-secondary)');
}

const alertModal = document.querySelector("#alertModal");
const alertModalText = document.querySelector("#alertModalText");
const closeAlertModal = document.querySelector("#closeAlertModal");

function showCustomAlert(text) {
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

/* --- Init --- */
if (typeof lucide !== "undefined") {
  lucide.createIcons();
}
loadState();

// Panggil fetchHistoryEvents untuk mengambil data histori dari database di awal
fetchHistoryEvents();

// Gunakan setActiveTab untuk memastikan state panel dan UI disinkronkan di awal
if (activeTabId) {
  setActiveTab(activeTabId);
} else {
  renderTabs();
  renderMessages();
}

updateInputDetection();
loadHealth();
setInterval(loadHealth, 30000);
