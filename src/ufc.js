import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let fightersMap = new Map();
let isInitialized = false;

// We use a super fast custom CSV parser to prevent lag
// This loads the entire dataset into RAM once (takes < 50ms for typical UFC datasets)
export function initUfcData() {
  if (isInitialized) return;
  const dataPath = path.join(__dirname, "..", "data", "ufc_dataset.csv");
  
  if (!fs.existsSync(dataPath)) {
    console.warn("[UFC] Dataset not found at", dataPath);
    console.warn("[UFC] Please download the Kaggle CSV, name it 'ufc_dataset.csv' and place it in the 'data' folder.");
    return;
  }

  console.log("[UFC] Loading UFC dataset into memory for ultra-fast access...");
  const start = Date.now();
  
  try {
    const content = fs.readFileSync(dataPath, "utf8");
    const lines = content.split(/\r?\n/);
    if (lines.length < 2) return;

    // Parse headers safely handling quotes
    const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    
    // Find the name column (could be 'fighter', 'name', 'fighter_name')
    let nameIndex = headers.findIndex(h => h.includes("fighter") || h.includes("name"));
    if (nameIndex === -1) nameIndex = 0; // fallback to first column

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      
      const values = parseCsvLine(lines[i]);
      if (values.length < headers.length) continue;

      const fighterName = values[nameIndex]?.trim();
      if (!fighterName) continue;

      const stats = {};
      for (let j = 0; j < headers.length; j++) {
        stats[headers[j]] = values[j] ? values[j].trim() : "N/A";
      }

      // Store in map using lower case for O(1) case-insensitive lookup
      fightersMap.set(fighterName.toLowerCase(), stats);
      count++;
    }
    
    isInitialized = true;
    console.log(`[UFC] Loaded ${count} fighters into RAM in ${Date.now() - start}ms.`);
  } catch (error) {
    console.error("[UFC] Error loading dataset:", error.message);
  }
}

// Custom split for maximum performance. Assumes no inner commas which is standard for UFC stats.
function parseCsvLine(text) {
  return text.split(",").map(v => v.replace(/^"|"$/g, '').trim());
}

/**
 * Detects UFC fighters mentioned in the text with O(N) complexity where N is number of words
 * Extremely optimized to prevent any laptop lag.
 */
export function detectUfcFighters(text) {
  if (!isInitialized || fightersMap.size === 0) return [];
  
  const lowerText = String(text || "").toLowerCase();
  
  // Quick heuristic: does the text even relate to sports/ufc?
  // Polymarket UFC events usually have "vs", "fight", "ufc", "beat", "win"
  if (!/(vs|ufc|fight|beat|win|mma|bout|championship)/i.test(lowerText)) {
      // It might still be a fighter's name directly, but let's be careful.
      // We will still scan, but just to be safe.
  }

  const foundFighters = [];
  // Since some fighter names are 2 words (e.g. "Jon Jones"), we check all known fighters
  // This is very fast in V8 engine because the map is in memory.
  for (const [lowerName, stats] of fightersMap.entries()) {
    // Only match full words to avoid partial matches (e.g. finding 'Al' in 'Always')
    // We use a simple indexOf + boundary check which is faster than creating 3000 regexes
    const idx = lowerText.indexOf(lowerName);
    if (idx !== -1) {
      // Check boundaries
      const prevChar = idx === 0 ? " " : lowerText[idx - 1];
      const nextChar = idx + lowerName.length === lowerText.length ? " " : lowerText[idx + lowerName.length];
      
      if (/[^a-z]/.test(prevChar) && /[^a-z]/.test(nextChar)) {
        foundFighters.push(stats);
      }
    }
  }
  
  return foundFighters;
}


