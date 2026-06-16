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
      // Key-value pairs (e.g. Market ID: 12345)
      else if (/^([^:]+):(.*)$/.test(line)) {
        const match = line.match(/^([^:]+):(.*)$/);
        const key = match[1];
        let val = match[2];
        
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
async function executeCommand(commandText) {
  if (busy) return;
  const text = String(commandText || "").trim();
  if (!text) return;

  const remMs = getCooldownRemaining(text);
  if (remMs > 0) {
    const tabInfo = tabInfoForCommand(text, "auto");
    setActiveTab(tabInfo);
    addError(`ANTI-SPAM: Command ini masih dalam cooldown ${Math.ceil(remMs / 1000)} detik lagi.`, tabInfo.id);
    return;
  }

  const tabInfo = tabInfoForCommand(text, "auto");
  setActiveTab(tabInfo, { reset: true });
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




/* --- BTC 5m Live Logic --- */
const btnBtc5m = document.querySelector("#btnBtc5m");
const btc5mPanel = document.querySelector("#btc5mPanel");
const btnRefreshBtc5m = document.querySelector("#btnRefreshBtc5m");
const btc5mList = document.querySelector("#btc5mList");
const btc5mStatus = document.querySelector("#btc5mStatus");

let btc5mTimer = null;

if (btnBtc5m && btc5mPanel) {
  btnBtc5m.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = btc5mPanel.style.display === "none";
    btc5mPanel.style.display = isHidden ? "block" : "none";
    if (isHidden) {
      fetchBtc5mMarkets();
      startBtc5mRealtimeTimer();
    } else {
      stopBtc5mRealtimeTimer();
    }
  });
  // Panel akan tetap terbuka sampai tombol diklik lagi
  // Tidak ada event listener document click untuk menutup otomatis.
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
  btnToggleQueue.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = queuePanel.style.display === "none";
    queuePanel.style.display = isHidden ? "block" : "none";
  });
}

if (btnCloseQueue && queuePanel) {
  btnCloseQueue.addEventListener("click", () => {
    queuePanel.style.display = "none";
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
const queueResizeHandleSW = document.querySelector("#queueResizeHandleSW");
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
  const fullMarket = currentBtcMarkets.find(m => m.id === marketData.id);
  const queueItem = fullMarket || marketData;
  
  analysisQueue.push(queueItem);
  renderQueue();
}

function renderQueue() {
  if (!queueDropzone || !queueEmpty) return;
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
  queueDropzone.innerHTML = html;
  if (typeof lucide !== 'undefined') lucide.createIcons();
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
    
    const val5m = ((min5 && min5.value ? parseInt(min5.value) : 3) * 60) + (sec5 && sec5.value ? parseInt(sec5.value) : 30);
    const val15m = ((min15 && min15.value ? parseInt(min15.value) : 7) * 60) + (sec15 && sec15.value ? parseInt(sec15.value) : 0);
    
    // 1. Cek market mana saja yang sudah masuk sweet spot
    analysisQueue.forEach(m => {
      if (!m.snipeFired && m.endDate) {
        const timeToClose = new Date(m.endDate).getTime() - Date.now();
        const durationLimit = m.duration_type === '15m' ? val15m * 1000 : val5m * 1000;
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
        
      executeCommand(commandStr);
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
    btnRunQueue.innerHTML = `<i data-lucide="crosshair" class="btn-icon"></i> Sniper Active`;
    btnRunQueue.style.background = "rgba(245, 158, 11, 0.5)";
    btnRunQueue.style.color = "#fff";
    startSniper();
  } else {
    btnRunQueue.innerHTML = `<i data-lucide="crosshair" class="btn-icon"></i> Activate Sniper`;
    btnRunQueue.style.background = "rgba(245, 158, 11, 0.2)";
    btnRunQueue.style.color = "var(--neon-amber)";
    stopSniper();
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
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


let currentBtcMarkets = [];
let activeBtcTab = '5m';

const tabBtc5m = document.querySelector("#tabBtc5m");
const tabBtc15m = document.querySelector("#tabBtc15m");

if (tabBtc5m && tabBtc15m) {
  tabBtc5m.addEventListener("click", () => {
    activeBtcTab = '5m';
    tabBtc5m.style.borderBottomColor = 'var(--neon-amber)';
    tabBtc5m.style.color = 'var(--text-primary)';
    tabBtc15m.style.borderBottomColor = 'transparent';
    tabBtc15m.style.color = 'var(--text-tertiary)';
    renderBtc5mMarkets(currentBtcMarkets);
  });
  
  tabBtc15m.addEventListener("click", () => {
    activeBtcTab = '15m';
    tabBtc15m.style.borderBottomColor = 'var(--neon-amber)';
    tabBtc15m.style.color = 'var(--text-primary)';
    tabBtc5m.style.borderBottomColor = 'transparent';
    tabBtc5m.style.color = 'var(--text-tertiary)';
    renderBtc5mMarkets(currentBtcMarkets);
  });
}

if (btnRefreshBtc5m) {
  btnRefreshBtc5m.addEventListener("click", () => {
    fetchBtc5mMarkets();
  });
}

async function fetchBtc5mMarkets() {
  if (btc5mStatus) btc5mStatus.textContent = "Updating...";
  try {
    const res = await fetch("/api/btc-short-term");
    const data = await res.json();
    if (data.ok) {
      currentBtcMarkets = data.markets || [];
      renderBtc5mMarkets(currentBtcMarkets);
      if (btc5mStatus) {
        const now = new Date();
        btc5mStatus.textContent = `Last update: ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      }
    } else {
      if (btc5mStatus) btc5mStatus.textContent = "Error updating";
    }
  } catch (error) {
    console.error("Failed to fetch BTC 5m markets:", error);
    if (btc5mStatus) btc5mStatus.textContent = "Network error";
  }

  // Auto refresh if panel is open
  if (btc5mPanel && btc5mPanel.style.display === "block") {
    if (btc5mTimer) clearTimeout(btc5mTimer);
    btc5mTimer = setTimeout(fetchBtc5mMarkets, 5000); // 5 detik
  }
}

function renderBtc5mMarkets(markets) {
  if (!btc5mList) return;
  if (!markets || !markets.length) {
    btc5mList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-tertiary);">No active BTC markets found right now.</div>';
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
      <div class="btc5m-card" draggable="true" data-id="${m.id}" data-url="${m.url}" data-question="${(m.question || '').replace(/"/g, '&quot;')}" ondragstart="handleDragStart(event, this)" ondragend="handleDragEnd(event)" style="padding:8px 10px; border:1px solid rgba(255,255,255,0.05); border-radius:4px; background:rgba(0,0,0,0.15); cursor:grab; transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'; this.style.borderColor='rgba(245,158,11,0.3)';" onmouseout="this.style.background='rgba(0,0,0,0.15)'; this.style.borderColor='rgba(255,255,255,0.05)';" onclick="analyzeBtc5m('${m.id}', '${m.url}')">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span style="font-weight:600; color:var(--text-primary); font-size:11px;">${m.groupItemTitle || m.question.replace(/Bitcoin Up or Down -? ?/i, '').trim()}</span>
          <span class="btc5m-timer" data-end-date="${m.endDate}" data-p-yes="${pYes}" data-p-no="${pNo}" data-l-yes="${labelYes}" data-l-no="${labelNo}" style="color:${timeColor}; font-weight:700; font-size:10px;">${timeText}</span>
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

  let targetMarkets = [];
  if (activeBtcTab === '5m') {
    targetMarkets = markets.filter(m => m.duration_type === '5m' || !m.duration_type);
  } else {
    targetMarkets = markets.filter(m => m.duration_type === '15m');
  }

  let html = "";
  
  if (targetMarkets.length) {
    html += targetMarkets.map(renderCard).join("");
  } else {
    html = `<div style="text-align:center; padding:20px; color:var(--text-tertiary);">No active BTC ${activeBtcTab} markets right now.</div>`;
  }

  btc5mList.innerHTML = html;
}

let btc5mRealtimeInterval = null;

function startBtc5mRealtimeTimer() {
  if (btc5mRealtimeInterval) clearInterval(btc5mRealtimeInterval);
  btc5mRealtimeInterval = setInterval(() => {
    document.querySelectorAll(".btc5m-timer").forEach(el => {
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

function stopBtc5mRealtimeTimer() {
  if (btc5mRealtimeInterval) {
    clearInterval(btc5mRealtimeInterval);
    btc5mRealtimeInterval = null;
  }
}

window.analyzeBtc5m = function(marketId, url) {
  if (btc5mPanel) btc5mPanel.style.display = "none";
  if (btc5mTimer) clearTimeout(btc5mTimer);
  stopBtc5mRealtimeTimer();
  
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
let currentHistoryFilter = "all";
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
    fetchHistoryEvents();
  });

  closeHistoryModal.addEventListener("click", () => {
    historyModal.style.display = "none";
  });
}

document.querySelectorAll(".history-tab-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".history-tab-btn").forEach(b => {
      b.classList.remove("active");
      b.style.color = "var(--text-tertiary)";
      b.style.borderBottom = "2px solid transparent";
    });
    const target = e.currentTarget;
    target.classList.add("active");
    target.style.color = "var(--text-primary)";
    target.style.borderBottom = "2px solid var(--neon-purple)";
    
    currentHistoryFilter = target.getAttribute("data-filter");
    applyHistoryFilter();
  });
});

function applyHistoryFilter() {
  let filtered = allHistoryEvents;
  if (currentHistoryFilter === "5m") {
    filtered = allHistoryEvents.filter(e => e.url.includes("5m") || e.question.toLowerCase().includes("5 min"));
  } else if (currentHistoryFilter === "15m") {
    filtered = allHistoryEvents.filter(e => e.url.includes("15m") || e.question.toLowerCase().includes("15 min"));
  }
  
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
          <div style="display:flex; gap:4px;">${predBadge} ${resultBadge}</div>
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
        <td style="padding:10px 0; color:${statusColor}; font-weight:bold; text-transform:capitalize;">
          ${event.result || '-'} 
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
