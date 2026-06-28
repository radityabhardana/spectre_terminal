/* --- UI & Rendering --- */
/* --- Rendering --- */
function renderMessages() {
  messagesEl.innerHTML = "";
  const tab = activeTab();
  const messages = tab?.messages || [];
  emptyState.classList.toggle("hidden", messages.length > 0 && !messages.every(m => m.deleted));
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
        html += `<div class="analysis-card">${sectionContent}</div>`;
      } else {
        if (currentSection === "KESIMPULAN CEPAT" || currentSection === "ENTRY VERDICT") {
          const isDanger = sectionContent.includes("SKIP") || sectionContent.includes("TIDAK LAYAK");
          const isWarn = sectionContent.includes("WAIT") || sectionContent.includes("HATI-HATI");
          const cls = isDanger ? "danger" : (isWarn ? "warning" : "");
          html += `<div class="verdict-banner ${cls}">
            <div class="verdict-title">${currentSection}</div>
            ${sectionContent}
          </div>`;
        } else {
          // Normal card
          let content = sectionContent;
          if (currentSection === "SNAPSHOT DATA" && metricGrid) {
            content += `<div class="metric-grid">${metricGrid}</div>`;
          }
          let icon = getIconForSection(currentSection);
          html += `<div class="analysis-card">
            <div class="analysis-card-title"><i data-lucide="${icon}" style="width:14px;height:14px;"></i> ${currentSection}</div>
            ${content}
          </div>`;
        }
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
          sectionContent += `<div class="msg-kv" style="flex-direction:column; align-items:flex-start; margin-top:8px; background:rgba(0,0,0,0.2); padding:8px; border-radius:6px; border:1px solid var(--border);"><span class="live-ticker" data-tokens="${payload}" style="width:100%; display:flex; flex-direction:column; gap:6px;">⏳ Syncing CLOB & Crypto Feed...</span></div>`;
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
          metricGrid += `<div class="metric-box"><span class="metric-label">${key}</span><span class="metric-value">${val}</span></div>`;
        } else {
           sectionContent += `<div class="text-row"><span class="label">${key}:</span><span class="val">${val}</span></div>`;
        }
      } 
      // List items
      else if (line.trim().startsWith("- ")) {
        sectionContent += `<div class="msg-li" style="font-size:12px; color:var(--text-secondary); margin-bottom:2px; padding-left:10px; border-left:2px solid var(--border);">${line.replace("- ", "")}</div>`;
      } 
      // Normal text
      else {
        let htmlLine = line
          .replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--text-primary);">$1</strong>')
          .replace(/\*(.*?)\*/g, '<strong style="color:var(--text-primary);">$1</strong>')
          .replace(/_(.*?)_/g, '<em style="color:var(--text-tertiary);">$1</em>')
          .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);color:var(--neon-green);padding:2px 4px;border-radius:4px;">$1</code>');
        sectionContent += `<div class="msg-text" style="font-size:12px; color:var(--text-secondary); margin-bottom:4px; line-height:1.5;">${htmlLine}</div>`;
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
        const polyFrame = document.querySelector("#polyFrame");
        
        if (polyLiveTicker && polyMidpoint && polyFrame && !polyFrame.classList.contains("hidden")) {
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

