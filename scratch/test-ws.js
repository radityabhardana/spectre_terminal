import WebSocket from 'ws';

console.log("Testing Binance WS...");
const binanceWs = new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr");
binanceWs.on('open', () => console.log("Binance Open"));
binanceWs.on('close', (code, reason) => console.log(`Binance Close: ${code} ${reason.toString()}`));
binanceWs.on('error', err => console.log("Binance Error:", err.message));
binanceWs.on('unexpected-response', (req, res) => console.log("Binance Unexpected Response:", res.statusCode));

console.log("Testing Polymarket WS...");
const polyWs = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
polyWs.on('open', () => console.log("Poly Open"));
polyWs.on('close', (code, reason) => console.log(`Poly Close: ${code} ${reason.toString()}`));
polyWs.on('error', err => console.log("Poly Error:", err.message));
polyWs.on('unexpected-response', (req, res) => console.log("Poly Unexpected Response:", res.statusCode));

setTimeout(() => {
  console.log("Test finished.");
  binanceWs.close();
  polyWs.close();
}, 8000);
