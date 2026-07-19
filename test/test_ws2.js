/**
 * Test: subscribe and count incoming messages to verify WS stability.
 * Run: node test/test_ws2.js
 */

import WebSocket from 'ws';
import { getShortTermMarkets } from '../src/polymarket.js';

async function testLimit() {
  const btc = await getShortTermMarkets('btc');
  const eth = await getShortTermMarkets('eth');
  const doge = await getShortTermMarkets('doge');
  const allShorts = [...btc, ...eth, ...doge];
  const shortIds = allShorts.flatMap(m => m.clobTokenIds || []).filter(Boolean);

  console.log(`Total IDs: ${shortIds.length}`);

  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  ws.on('open', async () => {
    console.log('WS Open');
    const CHUNK_SIZE = 50;
    let sentCount = 0;
    for (let i = 0; i < shortIds.length; i += CHUNK_SIZE) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const chunk = shortIds.slice(i, i + CHUNK_SIZE);
      ws.send(JSON.stringify({ assets_ids: chunk, type: 'market' }));
      sentCount += chunk.length;
      console.log(`Sent ${sentCount}/${shortIds.length}`);
      await new Promise(r => setTimeout(r, 700));
    }
    console.log('Done subscribing. Waiting to see if it drops...');
  });

  let msgCount = 0;
  ws.on('message', (data) => {
    msgCount++;
    if (msgCount % 100 === 0) console.log(`Received ${msgCount} messages`);
  });

  ws.on('close', (code, reason) => {
    console.log(`WS Closed: ${code} ${reason}`);
    process.exit(1);
  });
}
testLimit();
