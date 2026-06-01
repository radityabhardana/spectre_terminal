import { formatSearchResults } from "./format.js";
import { SEARCH_ENGINE_VERSION, searchMarkets } from "./polymarket.js";

const keyword = process.argv.slice(2).join(" ").trim();

if (!keyword) {
  console.error('Usage: npm run search -- "Colombia Presidential Election"');
  process.exit(1);
}

const markets = await searchMarkets(keyword, 5);
console.log(`Search engine: ${SEARCH_ENGINE_VERSION}\n`);
console.log(formatSearchResults(markets));
