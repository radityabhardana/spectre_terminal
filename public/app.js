const modeSelect = document.querySelector("#modeSelect");
const commandInput = document.querySelector("#commandInput");
const runButton = document.querySelector("#runButton");
const clearButton = document.querySelector("#clearButton");
const deckTabsEl = document.querySelector("#deckTabs");
const messagesEl = document.querySelector("#messages");
const emptyState = document.querySelector("#emptyState");
const loadingState = document.querySelector("#loadingState");
const timerText = document.querySelector("#timerText");
const versionText = document.querySelector("#versionText");
const qwenStatus = document.querySelector("#qwenStatus");
const polyFrame = document.querySelector("#polyFrame");
const polyEmpty = document.querySelector("#polyEmpty");
const polyTitle = document.querySelector("#polyTitle");
const polyOpenLink = document.querySelector("#polyOpenLink");

const CLIENT_VERSION = "public-search-v2-event-wide-analysis-v14-top-market-discovery";
let busy = false;
let timerId = null;
let startedAt = 0;
let versionWarningShown = false;
const outputTabs = new Map();
let activeTabId = "";

function shortLabel(value, max = 34) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function tabInfoForCommand(requestText, mode = "auto") {
  const command = String(requestText || "").trim();
  const lower = command.toLowerCase();
  const modeLabels = {
    auto: "Auto",
    top: "Volume",
    search: "Search",
    analyze: "Deep",
    quickscan: "Quick",
    top3: "Top 3",
    analyzebest: "AI Best",
    analyzeall: "All",
    book: "Book",
  };
  const topLabels = {
    "/top": "Volume",
    "/top liquidity": "Liquidity",
    "/top new": "New",
    "/top ending": "Ending",
  };

  if (topLabels[lower]) return { id: `top:${lower.replace("/top", "volume").trim() || "volume"}`, label: topLabels[lower] };

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
    outputTabs.set(info.id, {
      id: info.id,
      label: info.label || "Console",
      messages: [],
    });
  } else if (info.label) {
    outputTabs.get(info.id).label = info.label;
  }
  return outputTabs.get(info.id);
}

function activeTab() {
  return activeTabId ? outputTabs.get(activeTabId) : null;
}

function updateCommandDeckState() {
  document.querySelectorAll("[data-command]").forEach((button) => {
    const tab = tabInfoForCommand(button.dataset.command || "", "auto");
    button.classList.toggle("active", tab.id === activeTabId);
  });

  document.querySelectorAll(".quick-actions button").forEach((button) => {
    const mode = button.dataset.mode || "auto";
    button.classList.toggle("active", activeTabId.startsWith(`${mode}:`) || activeTabId.startsWith(`cmd:/${mode}`));
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
}

function setBusy(nextBusy) {
  busy = nextBusy;
  runButton.disabled = busy;
  modeSelect.disabled = busy;
  commandInput.disabled = busy;
  loadingState.classList.toggle("hidden", !busy);

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

function clearMessages() {
  const tab = activeTab();
  if (tab) tab.messages = [];
  renderMessages();
}

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
      eventIndex >= 0 && parts[eventIndex + 1]
        ? parts[eventIndex + 1]
        : marketIndex >= 0 && parts[marketIndex + 1]
          ? parts[marketIndex + 1]
          : parts.at(-1);

    return decodeURIComponent(slug || "");
  } catch {
    return "";
  }
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

function renderMessages() {
  messagesEl.innerHTML = "";
  const tab = activeTab();
  const messages = tab?.messages || [];
  emptyState.classList.toggle("hidden", messages.length > 0);
  for (const message of messages) appendMessageElement(message);
  const embedMessage = [...messages].reverse().find((message) => polymarketUrlsFromText(message.text).length);
  if (embedMessage) syncPolymarketEmbedFromText(embedMessage.text, "From result");
  messagesEl.scrollTop = 0;
}

function appendMessageElement(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role || "assistant"}`;

  const header = document.createElement("div");
  header.className = "message-header";
  const label = document.createElement("span");
  label.textContent = message.role === "user" ? "Input" : message.role === "error" ? "Error" : "Result";
  const meta = document.createElement("span");
  meta.textContent = new Date().toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
  header.append(label, meta);

  const body = document.createElement("pre");
  body.textContent = message.text || "";
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
      action.addEventListener("click", () => runCommand(button.command, "auto"));
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
      requestAnimationFrame(() => {
        messagesEl.scrollTop = 0;
      });
    }
    syncPolymarketEmbedFromText(message.text, "From result");
  }
}

function addUserInput(text, tabId = activeTabId) {
  addMessage({ role: "user", text }, tabId);
}

function addError(text, tabId = activeTabId) {
  addMessage({ role: "error", text }, tabId);
}

function warnIfServerVersionMismatch(data = {}, tabId = activeTabId) {
  if (!data.version || data.version === CLIENT_VERSION || versionWarningShown) return;
  versionWarningShown = true;
  addError(`Server masih jalan versi lama (${data.version}). Stop proses npm lama, lalu jalankan npm.cmd start lagi supaya fitur Top Markets aktif.`, tabId);
}

async function runCommand(textOverride = "", modeOverride = "") {
  if (busy) return;

  const mode = modeOverride || modeSelect.value;
  const text = String(textOverride || commandInput.value || "").trim();
  const requestText = !text && mode === "top" ? "/top" : text;
  if (!requestText && mode !== "top") {
    commandInput.focus();
    return;
  }

  const tabInfo = tabInfoForCommand(requestText, mode);
  setActiveTab(tabInfo, { reset: true });

  addUserInput(text || tabInfo.label, tabInfo.id);
  syncPolymarketEmbedFromText(text, "From input");
  setBusy(true);

  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: requestText, mode }),
    });
    const data = await response.json();
    warnIfServerVersionMismatch(data, tabInfo.id);

    if (!data.ok) {
      addError(data.error || "Request gagal.", tabInfo.id);
      for (const message of data.messages || []) addMessage(message, tabInfo.id);
      return;
    }

    for (const message of data.messages || []) addMessage(message, tabInfo.id);
  } catch (error) {
    addError(error.message || String(error), tabInfo.id);
  } finally {
    setBusy(false);
  }
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    versionText.textContent = data.version || "Engine ready";
    warnIfServerVersionMismatch(data);
    const serverOutdated = data.version && data.version !== CLIENT_VERSION;
    qwenStatus.textContent = serverOutdated ? "Server old" : data.qwenLabel || "Qwen status unknown";
    qwenStatus.classList.toggle("warn", !data.qwenConfigured || serverOutdated);
  } catch {
    versionText.textContent = "Engine offline";
    qwenStatus.textContent = "Offline";
    qwenStatus.classList.add("warn");
  }
}

runButton.addEventListener("click", () => runCommand());
clearButton.addEventListener("click", clearMessages);

function openDeckCommand(command) {
  const tabInfo = tabInfoForCommand(command, "auto");
  if (outputTabs.has(tabInfo.id) && activeTabId !== tabInfo.id) {
    setActiveTab(tabInfo.id);
    return;
  }
  runCommand(command, "auto");
}

commandInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runCommand();
  }
});

document.querySelectorAll(".quick-actions button").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode || "auto";
    const modeOption = modeSelect.querySelector(`option[value="${mode}"]`);
    if (modeOption) modeSelect.value = mode;

    if (commandInput.value.trim()) {
      runCommand("", mode);
      return;
    }

    commandInput.focus();
  });
});

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    openDeckCommand(button.dataset.command || "");
  });
});

renderTabs();
renderMessages();
loadHealth();
