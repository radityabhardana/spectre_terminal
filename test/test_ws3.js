/**
 * Test: minimal WebSocket ping/pong test with BTC tokens only.
 * Run: node test/test_ws3.js
 */

import WebSocket from 'ws';
import { getShortTermMarkets } from '../src/polymarket.js';

async function testLimit() {
  const btc = await getShortTermMarkets('btc');
  const shortIds = btc.flatMap(m => m.clobTokenIds || []).filter(Boolean);

  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  ws.on('open', async () => {
    console.log('WS Open');
    const chunk = shortIds.slice(0, 50);
    ws.send(JSON.stringify({ assets_ids: chunk, type: 'market' }));
    console.log('Sent subscriptions');
  });

  setInterval(() => {
    console.log('Sending ping');
    ws.ping();
  }, 5000);

  ws.on('close', (code, reason) => {
    console.log(`WS Closed: ${code} ${reason}`);
    process.exit(1);
  });
}
testLimit();
