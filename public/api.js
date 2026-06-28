/* --- API & WebSocket --- */
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
    if (sbLatency) {
      sbLatency.textContent = `${latency}ms`;
      if (latency < 100) sbLatency.style.color = 'var(--neon-green)';
      else if (latency < 300) sbLatency.style.color = 'var(--neon-amber)';
      else sbLatency.style.color = 'var(--neon-red)';
    }
    if (sbQwenDot) sbQwenDot.className = qwenConfigured ? "status-bar-dot ai" : "status-bar-dot warn";
    if (sbQwenLabel) sbQwenLabel.textContent = qwenConfigured ? "Qwen: • loaded" : "Qwen: ? missing";
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

