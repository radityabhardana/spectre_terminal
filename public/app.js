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
let cooldownUntil = 0;
let antiSpamCooldownMs = 3000;
const outputTabs = new Map();
let activeTabId = "";

// Smart input state
let selectedAction = "analyze"; // default action

/* --- Local Storage State --- */
function saveState() {
  const tabsData = Array.from(outputTabs.entries());
  localStorage.setItem("mvpm_state", JSON.stringify({ activeTabId, tabsData }));
}

function loadState() {
  try {
    const saved = localStorage.getItem("mvpm_state");
    if (!saved) return;
    const { activeTabId: savedActiveId, tabsData } = JSON.parse(saved);
    if (tabsData) {
      outputTabs.clear();
      for (const [id, tab] of tabsData) outputTabs.set(id, tab);
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

  // Slash command
  if (text.startsWith("/")) {
    return { type: "command", label: `⌘ Command: ${text.split(/\s+/)[0]}` };
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
  const modeLabels = {
    auto: "Auto", top: "Volume", search: "Search", analyze: "Deep",
    quickscan: "Quick", top3: "Top 3", analyzebest: "AI Best",
    analyzeall: "All", book: "Book",
  };
  const topLabels = {
    "/top": "Volume", "/top liquidity": "Liquidity",
    "/top new": "New", "/top ending": "Ending",
  };

  if (topLabels[lower]) {
    return { id: `top:${lower.replace("/top", "volume").trim() || "volume"}`, label: topLabels[lower] };
  }

  if (lower.startsWith("/")) {
    const [commandName, ...restParts] = command.split(/\s+/);
    const name = commandName.replace("/", "").toLowerCase();
    const rest = restParts.join(" ");
    return {
      id: `cmd:${lower}`,
      label: rest ? `${modeLabels[name] || commandName}: ${shortLabel(rest, 26)}` : modeLabels[name] || commandName,
    };
  }

  return {
    id: `${mode}:${lower || "empty"}`,
    label: command ? `${modeLabels[mode] || "Auto"}: ${shortLabel(command, 26)}` : modeLabels[mode] || "Console",
  };
}

function ensureTab(tabInfo) {
  const info = typeof tabInfo === "string" ? { id: tabInfo, label: tabInfo } : tabInfo;
  if (!outputTabs.has(info.id)) {
    outputTabs.set(info.id, { id: info.id, label: info.label || "Console", messages: [] });
  } else if (info.label) {
    outputTabs.get(info.id).label = info.label;
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
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = tab.label;
    button.title = tab.label;
    button.classList.toggle("active", tab.id === activeTabId);
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

function setCooldown(ms = antiSpamCooldownMs) {
  const durationMs = Math.max(0, Number(ms) || 0);
  if (!durationMs) return;
  cooldownUntil = Date.now() + durationMs;
  runButton.disabled = true;
  runButton.classList.remove("cancel");
  runButton.classList.add("cooldown");

  const update = () => {
    const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    if (runLabel) runLabel.textContent = remaining ? `${remaining}s` : "Run";
    if (runIcon) runIcon.textContent = remaining ? "⏳" : "▶";

    if (!remaining) {
      clearInterval(cooldownTimerId);
      cooldownTimerId = null;
      runButton.disabled = false;
      runButton.classList.remove("cooldown");
      loadHealth();
    }
  };

  clearInterval(cooldownTimerId);
  update();
  cooldownTimerId = setInterval(update, 250);
}

function isCoolingDown() {
  return Date.now() < cooldownUntil;
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
  const label = document.createElement("span");
  label.textContent = message.role === "user" ? "› Input" : message.role === "error" ? "× Error" : "◆ Result";
  const meta = document.createElement("span");
  meta.textContent = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  header.append(label, meta);

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
  const cooldown = Number(data.rateLimit?.commandCooldownMs);
  if (Number.isFinite(cooldown) && cooldown >= 0) antiSpamCooldownMs = cooldown;
}

/* --- Execute Command --- */
async function executeCommand(commandText) {
  if (busy || isCoolingDown()) return;
  const text = String(commandText || "").trim();
  if (!text) return;

  const tabInfo = tabInfoForCommand(text, "auto");
  setActiveTab(tabInfo, { reset: true });
  addUserInput(text, tabInfo.id);
  syncPolymarketEmbedFromText(text, "From input");
  activeRequest = new AbortController();
  setBusy(true);

  const fetchStart = Date.now();

  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, mode: "auto" }),
      signal: activeRequest.signal,
    });
    const data = await response.json();
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
    setCooldown();
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

    // If there's input, run immediately
    const text = commandInput.value.trim();
    if (text && !busy && !isCoolingDown()) {
      const command = buildCommand(action, text);
      executeCommand(command);
    } else if (!text) {
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
