import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const dataDir = path.resolve(process.cwd(), "data");
const cachePath = path.join(dataDir, "cache.json");

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function getCache(key, ttlSeconds = config.cacheTtlSeconds) {
  const cache = readJson(cachePath, {});
  const hit = cache[key];
  if (!hit) return null;

  const ageSeconds = (Date.now() - hit.savedAt) / 1000;
  if (ageSeconds > ttlSeconds) return null;
  return hit.value;
}

export function setCache(key, value) {
  const cache = readJson(cachePath, {});
  cache[key] = { savedAt: Date.now(), value };
  writeJson(cachePath, cache);
}

export function appendAnalysisLog(entry) {
  ensureDataDir();
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.join(dataDir, "analysis_log.jsonl"), `${line}\n`);
}
