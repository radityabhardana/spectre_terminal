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
    if (!saved) return;
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

    if (tab.id !== "cmd:console") {
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

    qwenStatus.textContent = serverOutdated ? "Server old" : data.qwenLabel || "Qwen ?";
    qwenStatus.classList.toggle("warn", !data.qwenConfigured || serverOutdated);
    qwenStatus.classList.toggle("ai", data.qwenConfigured && !serverOutdated);

    if (connDot) connDot.className = "status-bar-dot";
    if (connLabel) connLabel.textContent = "Connected";
    if (sbEngine) sbEngine.textContent = `Engine: ${shortLabel(version, 40)}`;
    if (sbLatency) sbLatency.textContent = `${latency}ms`;
    if (sbQwenDot) sbQwenDot.className = data.qwenConfigured ? "status-bar-dot ai" : "status-bar-dot warn";
    if (sbQwenLabel) sbQwenLabel.textContent = data.qwenConfigured ? "Qwen: ✓ loaded" : "Qwen: ✗ missing";
  } catch {
    versionText.textContent = "Engine offline";
    qwenStatus.textContent = "Offline";
    qwenStatus.classList.add("warn");
    qwenStatus.classList.remove("ai");
    if (connDot) connDot.className = "status-bar-dot error";
    if (connLabel) connLabel.textContent = "Disconnected";
    if (sbEngine) sbEngine.textContent = "Engine: offline";
    if (sbQwenDot) sbQwenDot.className = "status-bar-dot error";
    if (sbQwenLabel) sbQwenLabel.textContent = "Qwen: offline";
    if (sbLatency) sbLatency.textContent = "--ms";
  }
}

/* --- Event Listeners --- */

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

/* --- Shadow Bot Logic --- */
const toggleShadowPanelBtn = document.querySelector("#toggleShadowPanelBtn");
const shadowBotPanel = document.querySelector("#shadowBotPanel");
const shadowRuntime = document.querySelector("#shadowRuntime");

let localShadowStartedAt = null;
let localShadowIsRunning = false;

function updateShadowRuntime() {
  if (!shadowRuntime) return;
  if (!localShadowIsRunning || !localShadowStartedAt) {
    shadowRuntime.textContent = "0m 0s";
    return;
  }
  const diffMs = Date.now() - localShadowStartedAt;
  const totalSecs = Math.floor(diffMs / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  
  if (m > 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    shadowRuntime.textContent = `${h}h ${remM}m`;
  } else {
    shadowRuntime.textContent = `${m}m ${s}s`;
  }
}

setInterval(updateShadowRuntime, 1000);

if (toggleShadowPanelBtn && shadowBotPanel) {
  toggleShadowPanelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = shadowBotPanel.style.display === "none";
    shadowBotPanel.style.display = isHidden ? "block" : "none";
    if (isHidden) fetchShadowStatus(); // Refresh on open
  });
  
  document.addEventListener("click", (e) => {
    if (!shadowBotPanel.contains(e.target) && e.target !== toggleShadowPanelBtn && !toggleShadowPanelBtn.contains(e.target)) {
      shadowBotPanel.style.display = "none";
    }
  });
  
  shadowBotPanel.addEventListener("click", (e) => { e.stopPropagation(); });
}

// Also open panel when clicking balance
const shadowBalanceEl = document.querySelector("#shadowBalance");
if (shadowBalanceEl) {
  shadowBalanceEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (shadowBotPanel) shadowBotPanel.style.display = "block";
    fetchShadowStatus();
  });
}

// Tab navigation
document.querySelectorAll(".shadow-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".shadow-tab").forEach(t => {
      t.classList.remove("active");
      t.style.borderBottomColor = "transparent";
      t.style.color = "var(--text-tertiary)";
    });
    tab.classList.add("active");
    tab.style.borderBottomColor = "var(--neon-purple)";
    tab.style.color = "var(--neon-purple)";
    
    document.querySelectorAll(".shadow-tab-content").forEach(c => c.style.display = "none");
    const target = tab.dataset.shadowTab;
    const targetEl = document.querySelector(`#shadowTab${target.charAt(0).toUpperCase() + target.slice(1)}`);
    if (targetEl) targetEl.style.display = "block";
  });
});

const btnStartShadow = document.querySelector("#btnStartShadow");
const btnStopShadow = document.querySelector("#btnStopShadow");
const btnResetShadow = document.querySelector("#btnResetShadow");
const shadowStatusBox = document.querySelector("#shadowStatusBox");
const shadowStateLabel = document.querySelector("#shadowStateLabel");
const shadowProgress = document.querySelector("#shadowProgress");
const shadowBadge = document.querySelector("#shadowBadge");
const shadowPnlPill = document.querySelector("#shadowPnlPill");

// Preset Buttons
const btnPresetCustom = document.querySelector("#btnPresetCustom");
const btnPresetSafe = document.querySelector("#btnPresetSafe");
const btnPresetAggro = document.querySelector("#btnPresetAggro");
const btnPresetHighRisk = document.querySelector("#btnPresetHighRisk");

// Inputs
const inputShadowCapital = document.querySelector("#shadowCapital");
const inputShadowTarget = document.querySelector("#shadowTarget");
const inputShadowDuration = document.querySelector("#shadowDuration");
const inputShadowMM = document.querySelector("#shadowMM");
const inputShadowSize = document.querySelector("#shadowSize");

function selectPreset(btn, preset) {
  [btnPresetCustom, btnPresetSafe, btnPresetAggro, btnPresetHighRisk].forEach(b => {
    if (b) b.classList.remove("selected");
  });
  if (btn) btn.classList.add("selected");
  
  if (preset === "safe") {
    if (inputShadowTarget) inputShadowTarget.value = 10;
    if (inputShadowDuration) inputShadowDuration.value = 12;
    if (inputShadowMM) inputShadowMM.value = "percentage";
    if (inputShadowSize) inputShadowSize.value = 1;
  } else if (preset === "aggro") {
    if (inputShadowTarget) inputShadowTarget.value = 30;
    if (inputShadowDuration) inputShadowDuration.value = 2;
    if (inputShadowMM) inputShadowMM.value = "percentage";
    if (inputShadowSize) inputShadowSize.value = 5;
  } else if (preset === "degen") {
    if (inputShadowCapital) inputShadowCapital.value = 13;
    if (inputShadowTarget) inputShadowTarget.value = 5;
    if (inputShadowDuration) inputShadowDuration.value = 1;
    if (inputShadowMM) inputShadowMM.value = "percentage";
    if (inputShadowSize) inputShadowSize.value = 25;
  }
}

if (btnPresetCustom) btnPresetCustom.addEventListener("click", () => selectPreset(btnPresetCustom, "custom"));
if (btnPresetSafe) btnPresetSafe.addEventListener("click", () => selectPreset(btnPresetSafe, "safe"));
if (btnPresetAggro) btnPresetAggro.addEventListener("click", () => selectPreset(btnPresetAggro, "aggro"));
if (btnPresetHighRisk) btnPresetHighRisk.addEventListener("click", () => selectPreset(btnPresetHighRisk, "degen"));

[inputShadowCapital, inputShadowTarget, inputShadowDuration, inputShadowMM, inputShadowSize].forEach(input => {
  if (input) {
    input.addEventListener("input", () => {
      [btnPresetCustom, btnPresetSafe, btnPresetAggro, btnPresetHighRisk].forEach(b => {
        if (b) b.classList.remove("selected");
      });
      if (btnPresetCustom) btnPresetCustom.classList.add("selected");
    });
  }
});

let shadowPollingTimer = null;
let lastShadowRunning = false;

async function fetchShadowStatus() {
  try {
    const res = await fetch("/api/shadow/status");
    const data = await res.json();
    if (data.ok) {
      updateShadowUI(data.state);
      lastShadowRunning = !!data.state?.isRunning;
    }
  } catch (e) {
    // Silently ignore — server might be restarting
  }
}

/**
 * Adaptive polling: 5s while bot is running (need fast feedback),
 * 15s when bot is stopped (low urgency).
 * Also uses Page Visibility API so that when the tab comes back from
 * the background, we poll immediately instead of waiting for a throttled timer.
 */
function scheduleShadowPoll() {
  if (shadowPollingTimer) clearTimeout(shadowPollingTimer);
  const interval = lastShadowRunning ? 5000 : 15000;
  shadowPollingTimer = setTimeout(async () => {
    await fetchShadowStatus();
    scheduleShadowPoll(); // reschedule after each fetch
  }, interval);
}

// When user returns to tab, fire an immediate poll instead of waiting
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    fetchShadowStatus().then(() => scheduleShadowPoll());
  } else {
    // Tab hidden — cancel the pending timer; browser would throttle it anyway
    if (shadowPollingTimer) clearTimeout(shadowPollingTimer);
  }
});

function updateShadowUI(state) {
  if (!state) return;
  
  localShadowStartedAt = state.startedAt || null;
  localShadowIsRunning = !!state.isRunning;
  updateShadowRuntime();
  
  // Bot running state
  if (state.isRunning) {
    if (btnStartShadow) btnStartShadow.style.display = "none";
    if (btnStopShadow) btnStopShadow.style.display = "flex";
    if (shadowStatusBox) shadowStatusBox.style.display = "block";
    if (shadowStateLabel) { shadowStateLabel.textContent = "Running"; shadowStateLabel.style.color = "var(--neon-cyan)"; }
    if (shadowBadge) shadowBadge.style.display = "inline-block";
  } else {
    if (btnStartShadow) btnStartShadow.style.display = "flex";
    if (btnStopShadow) btnStopShadow.style.display = "none";
    if (shadowStateLabel) { shadowStateLabel.textContent = "Stopped"; shadowStateLabel.style.color = "var(--text-tertiary)"; }
    if (shadowBadge) shadowBadge.style.display = state.stats?.totalBets > 0 ? "inline-block" : "none";
  }
  
  if (state.config && shadowProgress) {
    shadowProgress.textContent = `${state.currentBets}/${state.config.targetBets} bets`;
  }
  
  // Balance
  if (shadowBalanceEl) {
    const bal = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(state.balance);
    shadowBalanceEl.textContent = bal;
  }
  
  // Stats dashboard
  if (state.stats) {
    const s = state.stats;
    const statWinRate = document.querySelector("#statWinRate");
    const statPnl = document.querySelector("#statPnl");
    const statRoi = document.querySelector("#statRoi");
    const statWL = document.querySelector("#statWL");
    
    if (statWinRate) {
      statWinRate.textContent = `${s.winRate}%`;
      statWinRate.style.color = s.winRate >= 50 ? "var(--neon-green)" : s.winRate > 0 ? "var(--neon-amber)" : "var(--text-secondary)";
    }
    if (statPnl) {
      const pnlStr = s.totalPnl >= 0 ? `+$${s.totalPnl.toFixed(0)}` : `-$${Math.abs(s.totalPnl).toFixed(0)}`;
      statPnl.textContent = pnlStr;
      statPnl.style.color = s.totalPnl > 0 ? "var(--neon-green)" : s.totalPnl < 0 ? "var(--neon-red)" : "var(--text-secondary)";
    }
    if (statRoi) {
      statRoi.textContent = `${s.roi > 0 ? '+' : ''}${s.roi}%`;
      statRoi.style.color = s.roi > 0 ? "var(--neon-green)" : s.roi < 0 ? "var(--neon-red)" : "var(--text-secondary)";
    }
    if (statWL) statWL.textContent = `${s.wins}/${s.losses}`;
    
    // PnL pill in topbar
    if (shadowPnlPill && s.totalBets > 0) {
      shadowPnlPill.style.display = "inline-flex";
      const pnlStr = s.totalPnl >= 0 ? `+$${s.totalPnl.toFixed(0)}` : `-$${Math.abs(s.totalPnl).toFixed(0)}`;
      shadowPnlPill.textContent = `PnL: ${pnlStr}`;
      shadowPnlPill.style.color = s.totalPnl > 0 ? "var(--neon-green)" : s.totalPnl < 0 ? "var(--neon-red)" : "var(--text-secondary)";
      shadowPnlPill.style.borderColor = s.totalPnl > 0 ? "rgba(0,255,136,0.3)" : s.totalPnl < 0 ? "rgba(255,71,87,0.3)" : "var(--border)";
    }
  }
  
  // Render bets list
  renderBetsList(state.activeBets, state.resolvedBets);
  
  // Render logs
  renderLogsList(state.logs);
}

function renderBetsList(activeBets = [], resolvedBets = []) {
  const container = document.querySelector("#shadowBetsList");
  if (!container) return;
  
  if (!activeBets.length && !resolvedBets.length) {
    container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-tertiary);">No bets yet. Start the bot!</div>';
    return;
  }
  
  let html = "";
  
  if (activeBets.length) {
    html += '<div style="font-size:9px; color:var(--neon-cyan); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px; font-weight:700;">Open Positions</div>';
    for (const bet of activeBets) {
      html += renderBetCard(bet);
    }
  }
  
  if (resolvedBets.length) {
    html += '<div style="font-size:9px; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px; margin-top:8px; font-weight:700;">Resolved</div>';
    for (const bet of resolvedBets.slice(0, 10)) {
      html += renderBetCard(bet);
    }
  }
  
  container.innerHTML = html;
}

function renderBetCard(bet) {
  const isOpen = bet.status === "open";
  const isWin = bet.pnl > 0;
  const borderColor = isOpen ? "rgba(0,212,255,0.2)" : isWin ? "rgba(0,255,136,0.2)" : "rgba(255,71,87,0.2)";
  const sideColor = bet.side === "YES" ? "var(--neon-green)" : "var(--neon-red)";
  const pnlColor = isWin ? "var(--neon-green)" : "var(--neon-red)";
  const statusIcon = isOpen ? "⏳" : isWin ? "✅" : "❌";
  
  return `<div style="padding:6px 8px; margin-bottom:4px; border:1px solid ${borderColor}; border-radius:4px; background:rgba(0,0,0,0.15);">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
      <span style="font-weight:600; color:var(--text-primary); font-size:10px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${statusIcon} ${bet.question}</span>
      <span style="font-size:9px; color:${sideColor}; font-weight:700;">${bet.side}</span>
    </div>
    <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-tertiary);">
      <span>$${bet.amount.toFixed(0)} @ ${(bet.entry_price * 100).toFixed(0)}c</span>
      ${!isOpen ? `<span style="color:${pnlColor}; font-weight:600;">${bet.pnl >= 0 ? '+' : ''}$${bet.pnl.toFixed(2)}</span>` : '<span style="color:var(--neon-cyan);">Pending</span>'}
    </div>
  </div>`;
}

function renderLogsList(logs = []) {
  const container = document.querySelector("#shadowLogsList");
  if (!container) return;
  
  if (!logs.length) {
    container.innerHTML = '<div style="text-align:center; padding:20px;">Waiting for activity...</div>';
    return;
  }
  
  container.innerHTML = logs.map((line, idx) => {
    let color = "var(--text-tertiary)";
    let fontWeight = "400";

    // Green: successful bet or win
    if (line.includes("BET PLACED") || line.includes("✅ WON") || line.includes("WON:")) {
      color = "var(--neon-green)"; fontWeight = "600";
    }
    // Red: losses or errors
    else if (line.includes("❌ LOST") || line.includes("LOST:") || line.includes("error") || line.includes("Error")) {
      color = "var(--neon-red)";
    }
    // Cyan: bot state changes and verdicts
    else if (/started|running|Verdict|Scanning|Analyzing|Resolver/i.test(line)) {
      color = "var(--neon-cyan)";
    }
    // Amber: warnings, pre-filter skips, balance warnings
    else if (/SKIP|Insufficient|exhausted|Skipped|⚠️/i.test(line)) {
      color = "var(--neon-amber, #f59e0b)";
    }
    // Newest entry gets subtle highlight
    const bg = idx === 0 ? "rgba(255,255,255,0.04)" : "transparent";
    return `<div style="color:${color}; font-weight:${fontWeight}; background:${bg}; border-bottom:1px solid rgba(255,255,255,0.03); padding:3px 4px; border-radius:2px; font-family:monospace; font-size:10px; line-height:1.5;">${line}</div>`;
  }).join("");
}

// Start button
if (btnStartShadow) {
  btnStartShadow.addEventListener("click", async () => {
    const capital = Number(document.querySelector("#shadowCapital").value) || 10000;
    const targetBets = Number(document.querySelector("#shadowTarget").value) || 20;
    const durationHrs = Number(document.querySelector("#shadowDuration").value) || 2;
    const moneyManagement = document.querySelector("#shadowMM").value || "fixed";
    const betSize = Number(document.querySelector("#shadowSize").value) || 100;
    
    const config = {
      capital,
      targetBets,
      durationMs: durationHrs * 60 * 60 * 1000,
      moneyManagement,
      betSize,
      mode: "ending"
    };
    
    try {
      const res = await fetch("/api/shadow/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config })
      });
      const data = await res.json();
      if (data.ok) updateShadowUI(data.state);
    } catch (e) {
      console.error(e);
    }
  });
}

// Stop button
if (btnStopShadow) {
  btnStopShadow.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/shadow/stop", { method: "POST" });
      const data = await res.json();
      if (data.ok) updateShadowUI(data.state);
    } catch (e) {
      console.error(e);
    }
  });
}

// Reset button
if (btnResetShadow) {
  btnResetShadow.addEventListener("click", async () => {
    const amount = Number(document.querySelector("#shadowCapital").value) || 10000;
    if (!confirm(`Reset shadow balance to $${amount.toLocaleString()}? This won't delete bet history.`)) return;
    try {
      const res = await fetch("/api/shadow/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount })
      });
      const data = await res.json();
      if (data.ok) updateShadowUI(data.state);
    } catch (e) {
      console.error(e);
    }
  });
}

// Kick off the first fetch, then use adaptive scheduling (not a fixed setInterval)
fetchShadowStatus().then(() => scheduleShadowPoll());

/* --- Init --- */
if (typeof lucide !== "undefined") {
  lucide.createIcons();
}
loadState();
renderTabs();
renderMessages();
updateInputDetection();
loadHealth();
setInterval(loadHealth, 30000);

