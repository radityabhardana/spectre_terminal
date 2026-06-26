// Quick test of fetchBinanceTechData function
const interval = "5m";
const symbol = "BTCUSDT";
const klineUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=60`;
const tickerUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;

const [klineRes, tickerRes] = await Promise.all([
  fetch(klineUrl, { headers: { 'Cache-Control': 'no-cache' } }),
  fetch(tickerUrl, { headers: { 'Cache-Control': 'no-cache' } }),
]);

const klines = await klineRes.json();
const ticker = await tickerRes.json();

const closes = klines.map(k => parseFloat(k[4]));
const volumes = klines.map(k => parseFloat(k[5]));

// RSI-14
const rsiPeriod = 14;
let gains = 0, losses = 0;
for (let i = closes.length - rsiPeriod; i < closes.length; i++) {
  const diff = closes[i] - closes[i - 1];
  if (diff >= 0) gains += diff; else losses += Math.abs(diff);
}
const avgGain = gains / rsiPeriod;
const avgLoss = losses / rsiPeriod;
const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
const rsi = Math.round(100 - (100 / (1 + rs)));

// EMA helper
const ema = (data, period) => {
  const k = 2 / (period + 1);
  let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return val;
};

const ema12 = ema(closes, 12);
const ema26 = ema(closes, 26);
const macdLine = parseFloat((ema12 - ema26).toFixed(2));

const recentCandles = klines.slice(-5).map(k => ({
  time: new Date(k[0]).toISOString().slice(11, 16),
  open: parseFloat(k[1]).toFixed(2),
  close: parseFloat(k[4]).toFixed(2),
  direction: parseFloat(k[4]) >= parseFloat(k[1]) ? '▲' : '▼',
  vol: parseFloat(k[5]).toFixed(1)
}));

const avgVol10 = volumes.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;
const lastVol = volumes[volumes.length - 1];
const volRatio = parseFloat((lastVol / avgVol10).toFixed(2));

console.log("=== BINANCE TECH DATA TEST ===");
console.log(`Current BTC: $${parseFloat(ticker.lastPrice).toFixed(2)}`);
console.log(`24h Change: ${parseFloat(ticker.priceChangePercent).toFixed(2)}%`);
console.log(`RSI-14: ${rsi} → ${rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : rsi > 55 ? 'BULLISH ZONE' : rsi < 45 ? 'BEARISH ZONE' : 'NEUTRAL'}`);
console.log(`MACD Line: ${macdLine} (ema12=${ema12.toFixed(2)}, ema26=${ema26.toFixed(2)})`);
console.log(`Volume Ratio: ${volRatio}x`);
console.log("Recent 5m candles:");
recentCandles.forEach(c => console.log(`  ${c.time} ${c.direction} $${c.close} vol:${c.vol}`));
