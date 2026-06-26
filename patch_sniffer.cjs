const fs = require('fs');
let sniffer = fs.readFileSync('src/sniffer.js', 'utf-8');

const importRegex = /import \{ listTopMarkets \} from "\.\/polymarket\.js";/;
sniffer = sniffer.replace(importRegex, 'import { listTopMarkets, getShortTermMarkets } from "./polymarket.js";');

const globalLivePrices = `\nglobal.livePrices = {};\n`;
sniffer = sniffer.replace('const snifferMinUsd = 50000;', globalLivePrices + 'const snifferMinUsd = 50000;');

const wsHandlerRegex = /ws\.on\('message', \(data\) => \{[\s\S]*?const parsed = JSON\.parse\(data\.toString\(\)\);\n\s*const messages = Array\.isArray\(parsed\) \? parsed : \[parsed\];/;
const newWsHandler = `ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        
        for (const m of messages) {
          if ((m.event_type === "price_change" || m.event_type === "book") && m.asset_id) {
            // Update live price cache
            if (m.price !== undefined) {
              global.livePrices[m.asset_id] = parseFloat(m.price);
            } else if (m.bids && m.bids.length > 0) {
              global.livePrices[m.asset_id] = parseFloat(m.bids[0].price);
            } else if (m.asks && m.asks.length > 0) {
              global.livePrices[m.asset_id] = parseFloat(m.asks[0].price);
            }
          }
        }

        if (!isSnifferActive) return;
        
        for (const m of messages) {`;

sniffer = sniffer.replace(wsHandlerRegex, newWsHandler);

const wsOpenRegex = /ws\.on\('open', \(\) => \{[\s\S]*?ws\.send\(JSON\.stringify\(\{\n\s*assets_ids: clobIds,\n\s*type: "market"\n\s*\}\)\);\n\s*\}\);/;

const newWsOpen = `ws.on('open', async () => {
      console.log('✅ [Sniffer] Terhubung ke Polymarket Live Feed!');
      
      // Kirim satu payload langsung untuk top markets
      ws.send(JSON.stringify({
        assets_ids: clobIds,
        type: "market"
      }));

      // Fungsi untuk subscribe ke live prices untuk short markets
      const updateShortMarketSubs = async () => {
        try {
          const btc = await getShortTermMarkets("btc");
          const eth = await getShortTermMarkets("eth");
          const doge = await getShortTermMarkets("doge");
          const allShorts = [...btc, ...eth, ...doge];
          const shortIds = allShorts.flatMap(m => m.clobTokenIds || []).filter(Boolean);
          
          if (shortIds.length > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              assets_ids: shortIds,
              type: "market"
            }));
            console.log(\`[Sniffer] Subscribed to \${shortIds.length} short market tokens for Live Prices\`);
          }
        } catch (e) {
          console.error("[Sniffer] Failed to update short market subscriptions:", e.message);
        }
      };

      await updateShortMarketSubs();
      setInterval(updateShortMarketSubs, 5 * 60 * 1000);
    });`;

sniffer = sniffer.replace(wsOpenRegex, newWsOpen);

fs.writeFileSync('src/sniffer.js', sniffer);
console.log('Patched sniffer.js');
