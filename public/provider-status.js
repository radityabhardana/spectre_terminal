/* Unified live status for the engine popover. */
(function initEngineStatus() {
  const endpoint = "/api/engine-status";
  const pollMs = 8000;
  const engineKeys = ["gamma", "clob", "ai-provider", "local", "binance", "gdelt"];
  const validStates = new Set(["checking", "connected", "rate_limited", "degraded", "disconnected", "unconfigured"]);
  let pollPending = false;
  let hasSnapshot = false;
  let intervalStarted = false;

  function safeDetail(value) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  function stateLabel(state) {
    return {
      checking: "CHECKING",
      connected: "CONNECTED",
      rate_limited: "RATE LIMITED",
      degraded: "DEGRADED",
      disconnected: "DISCONNECTED",
      unconfigured: "UNCONFIGURED",
    }[state] || "CHECKING";
  }

  function engineItems(id) {
    return [...document.querySelectorAll(`[data-engine="${id}"]`)];
  }

  function ensureRowParts(item) {
    if (item.querySelector(".provider-status-state")) return;
    const labels = {
      gamma: "GAMMA",
      clob: "CLOB",
      "ai-provider": "AI PROVIDER",
      local: "LOCAL",
      binance: "BINANCE",
      gdelt: "GDELT",
    };
    item.replaceChildren();
    const dot = document.createElement("span");
    dot.className = "provider-status-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "provider-status-name";
    name.textContent = labels[item.dataset.engine] || item.dataset.engine.toUpperCase();
    const state = document.createElement("span");
    state.className = "provider-status-state";
    const latency = document.createElement("span");
    latency.className = "provider-status-latency";
    item.append(dot, name, state, latency);
  }

  function setEngineState(id, state, details = {}) {
    const items = engineItems(id);
    const latency = Number.isFinite(details.latencyMs) ? `${details.latencyMs}ms` : "";
    const error = safeDetail(details.error);
    const description = `${String(details.label || id).toUpperCase()}: ${stateLabel(state)}${error ? ` — ${error}` : ""}`;
    items.forEach((item) => {
      ensureRowParts(item);
      const stateEl = item.querySelector(".provider-status-state");
      const latencyEl = item.querySelector(".provider-status-latency");
      item.dataset.state = state;
      item.classList.toggle("ai", id === "ai-provider" && state === "connected");
      item.classList.toggle("warn", ["rate_limited", "degraded", "disconnected", "unconfigured"].includes(state));
      item.classList.toggle("muted", state === "checking");
      if (stateEl) stateEl.textContent = stateLabel(state);
      if (latencyEl) latencyEl.textContent = latency;
      item.title = description;
      item.setAttribute("aria-label", description);
    });
  }

  function setEngineError(id, message) {
    engineItems(id).forEach((item) => {
      const description = `${String(item.querySelector(".provider-status-name")?.textContent || id).trim()}: ${stateLabel(item.dataset.state)} — ${safeDetail(message)}`;
      item.title = description;
      item.setAttribute("aria-label", description);
    });
  }

  function normalizeId(id) {
    return String(id || "").trim().toLowerCase().replace(/[ _]+/g, "-");
  }

  function engineState(engine) {
    const status = String(engine?.status || "").toLowerCase();
    if (validStates.has(status)) return status;
    if (!engine || engine.reachable === false || engine.configured === false) return "disconnected";
    if (engine.reachable === true) return "connected";
    return "checking";
  }

  function rowsReady() {
    return engineKeys.every((key) => engineItems(key).length > 0);
  }

  async function pollEngineStatus() {
    if (pollPending) return;
    pollPending = true;
    if (!hasSnapshot) engineKeys.forEach((key) => setEngineState(key, "checking"));
    try {
      const response = await fetch(`${endpoint}?_=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.kind = "status error";
        throw error;
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        error.kind = "status error";
        throw error;
      }
      if (!Array.isArray(payload.engines)) {
        const error = new Error("invalid engine payload");
        error.kind = "status error";
        throw error;
      }
      const engines = new Map(payload.engines.map((engine) => [normalizeId(engine?.id), engine]));
      engineKeys.forEach((key) => {
        const engine = engines.get(key);
        setEngineState(key, engineState(engine), engine || { label: key });
      });
      hasSnapshot = true;
    } catch (error) {
      const kind = error?.kind || "network error";
      if (!hasSnapshot) engineKeys.forEach((key) => setEngineState(key, "disconnected", { label: key, error: kind }));
      else engineKeys.forEach((key) => setEngineError(key, kind));
    } finally {
      pollPending = false;
    }
  }

  function boot() {
    if (!rowsReady()) return false;
    if (intervalStarted) return true;
    intervalStarted = true;
    pollEngineStatus();
    window.setInterval(pollEngineStatus, pollMs);
    return true;
  }

  function startWhenReady() {
    if (boot()) return;
    const observer = new MutationObserver(() => {
      if (boot()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startWhenReady, { once: true });
  else startWhenReady();
})();
