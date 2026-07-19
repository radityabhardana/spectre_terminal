/**
 * Fetch and print all BTC-related series slugs from Polymarket Gamma API.
 * NOTE: requires src/polymarket.js to export a fetchJson utility.
 * Run: node scripts/get_slugs.js
 */

async function run() {
  const res = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=1000');
  const data = await res.json();
  const slugs = new Set();
  for (const ev of data) {
    if (ev.seriesSlug && ev.seriesSlug.includes('btc')) {
      slugs.add(ev.seriesSlug);
    }
  }
  console.log(Array.from(slugs).sort());
}
run();
