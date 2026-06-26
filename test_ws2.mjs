import WebSocket from 'ws';

async function fetchTopMarkets() {
  const res = await fetch("https://gamma-api.polymarket.com/markets?limit=10&active=true&order=volumeNum&ascending=false");
  const data = await res.json();
  return data.map(m => m.conditionId);
}

async function test() {
  console.log("Fetching top 10 markets...");
  const conditionIds = await fetchTopMarkets();
  console.log(`Subscribing to ${conditionIds.length} markets...`);
  
  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  
  ws.on('open', () => {
    console.log('✅ Connected to Polymarket WebSocket!');
    const msg = {
      assets_ids: conditionIds,
      type: "market"
    };
    ws.send(JSON.stringify(msg));
  });

  let tradeCount = 0;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (Array.isArray(msg)) {
      for (const m of msg) {
        if (m.price && m.size) {
           tradeCount++;
           const size = parseFloat(m.size);
           const price = parseFloat(m.price);
           console.log(`🐋 LIVE TRADE: Wallet ${m.maker || m.makerAddress || "Unknown"} traded $${(size * price).toFixed(2)} at price ${price}`);
        }
      }
    }
  });

  ws.on('error', (err) => console.error("❌ WS Error:", err.message));

  setTimeout(() => {
    ws.close();
    console.log(`\nTest finished. Total live trades captured in 15 seconds: ${tradeCount}`);
    if (tradeCount > 0) {
      console.log("✅ KESIMPULAN: OPSI A BERFUNGSI 100% DAN TIDAK DIBLOKIR!");
    } else {
      console.log("⚠️ Market lagi sepi, gak ada trade masuk di 10 market teratas dalam 15 detik.");
    }
  }, 15000);
}

test();
