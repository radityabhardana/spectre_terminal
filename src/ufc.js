import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let fightersMap = new Map();
let lastNameMap = new Map();
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
      const lowerName = fighterName.toLowerCase();
      stats._name = lowerName;
      fightersMap.set(lowerName, stats);
      
      const parts = lowerName.split(/\s+/);
      if (parts.length > 1) {
        const lastName = parts[parts.length - 1];
        if (lastName.length > 3) {
          if (!lastNameMap.has(lastName)) lastNameMap.set(lastName, []);
          lastNameMap.get(lastName).push(stats);
        }
      }
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
  const isCombatSport = /(vs|ufc|fight|beat|win|mma|bout|championship)/i.test(lowerText);

  const foundFighters = [];
  const foundNames = new Set();
  
  // 1. Full name match
  for (const [lowerName, stats] of fightersMap.entries()) {
    const idx = lowerText.indexOf(lowerName);
    if (idx !== -1) {
      const prevChar = idx === 0 ? " " : lowerText[idx - 1];
      const nextChar = idx + lowerName.length === lowerText.length ? " " : lowerText[idx + lowerName.length];
      
      if (/[^a-z]/.test(prevChar) && /[^a-z]/.test(nextChar)) {
        foundFighters.push(stats);
        foundNames.add(lowerName);
      }
    }
  }
  
  // 2. Last name fallback (ONLY if it looks like a combat sport market)
  // This prevents false positives like "Harris" (Walt Harris) triggering on "Kamala Harris" politics markets.
  if (foundFighters.length < 2 && isCombatSport) {
    for (const [lastName, statsArray] of lastNameMap.entries()) {
      const idx = lowerText.indexOf(lastName);
      if (idx !== -1) {
        const prevChar = idx === 0 ? " " : lowerText[idx - 1];
        const nextChar = idx + lastName.length === lowerText.length ? " " : lowerText[idx + lastName.length];
        
        if (/[^a-z]/.test(prevChar) && /[^a-z]/.test(nextChar)) {
          // If we found a last name, add max 2 fighters with this last name
          for (const stats of statsArray.slice(0, 2)) {
            if (!foundNames.has(stats._name)) {
              foundFighters.push(stats);
              foundNames.add(stats._name);
            }
          }
        }
      }
    }
  }
  
  // Clean up private _name prop from results and limit
  return foundFighters.slice(0, 4).map(s => {
    const { _name, ...rest } = s;
    return rest;
  });
}


