/**
 * Validate that all short-term market token IDs are well-formed strings.
 * Run: node scripts/check_ids.js
 */

import { getShortTermMarkets } from '../src/polymarket.js';

async function run() {
  const btc = await getShortTermMarkets('btc');
  const eth = await getShortTermMarkets('eth');
  const doge = await getShortTermMarkets('doge');
  const allShorts = [...btc, ...eth, ...doge];
  const shortIds = allShorts.flatMap(m => m.clobTokenIds || []).filter(Boolean);

  console.log(`Total: ${shortIds.length}`);
  const bad = shortIds.filter(id => typeof id !== 'string' || id.length < 10);
  console.log('Bad IDs:', bad);
}
run();
