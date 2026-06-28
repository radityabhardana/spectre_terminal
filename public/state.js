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

