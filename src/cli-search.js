import { formatSearchResults } from "./format.js";
import { searchMarkets } from "./polymarket.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error("Usage: npm run search -- <keyword>");
  process.exitCode = 1;
} else {
  try {
    console.log(formatSearchResults(await searchMarkets(query, 5)));
  } catch (error) {
    console.error(`Search failed: ${error.message}`);
    process.exitCode = 1;
  }
}
