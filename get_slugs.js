import { fetchJson } from './src/utils.js';

async function run() {
  const res = await fetchJson('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=1000');
  const slugs = new Set();
  for (const ev of res) {
    if (ev.seriesSlug && ev.seriesSlug.includes('btc')) {
      slugs.add(ev.seriesSlug);
    }
  }
  console.log(Array.from(slugs).sort());
}
run();
