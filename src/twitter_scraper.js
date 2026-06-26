import { getCache, setCache } from "./storage.js";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scrapes DuckDuckGo HTML search for recent tweets matching the query.
 * This is a free fallback since Twitter API is paid.
 */
export async function scrapeTwitter(keyword) {
  try {
    const cleanKeyword = normalizeText(keyword);
    // Limit keywords to avoid DDG overly specific fails
    const queryWords = cleanKeyword.split(" ").slice(0, 4).join(" ");
    const query = `site:twitter.com "${queryWords}"`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const key = `ddg_twitter:${queryWords}`;
    const cached = getCache(key, 900); // 15 mins cache
    if (cached) return cached;
    
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });
    
    if (!res.ok) return [];
    const html = await res.text();
    
    const snippets = [];
    // DuckDuckGo HTML results have `<a class="result__snippet ...">text</a>`
    const regex = /<a class="result__snippet[^>]*>(.*?)<\/a>/gs;
    let match;
    
    while ((match = regex.exec(html)) !== null) {
      // Remove HTML tags (like <b>)
      let text = match[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
      // Only keep snippets that look like they might be tweets (ignore profile bios)
      if (text.length > 20 && !text.includes("followers")) {
         snippets.push(text);
      }
    }

    const result = snippets.slice(0, 5); // Take top 5
    setCache(key, result);
    return result;
  } catch (err) {
    console.error("[TwitterScraper] Error:", err.message);
    return [];
  }
}
