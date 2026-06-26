import WebSocket from 'ws';

const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

ws.on('open', () => {
  console.log('Connected to WebSocket!');
  // Subscribe to Trump Market (0x0b8a24d06a4b1deae95fbb0b2170362c3e16c90dd721c43717fc8a531f86d8ed)
  const msg = {
    assets_ids: ["0x0b8a24d06a4b1deae95fbb0b2170362c3e16c90dd721c43717fc8a531f86d8ed"],
    type: "market"
  };
  ws.send(JSON.stringify(msg));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (Array.isArray(msg)) {
    for (const m of msg) {
      if (m.asset_id) {
         // Is it a trade?
         console.log("Received data:", m);
      }
    }
  } else {
     console.log("Received:", msg);
  }
});

ws.on('error', console.error);

setTimeout(() => {
  ws.close();
}, 10000); // Close after 10 seconds
