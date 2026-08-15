import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TRACKER_CONFIG_PATH = path.join(projectRoot, "data", "tracker_config.json");
export const LEGACY_TRACKER_CONFIG_PATH = path.join(projectRoot, "tracker_config.json");
export const TRACKER_CONFIG_MIN_USD = 10;
export const TRACKER_CONFIG_MAX_USD = 1_000_000_000;
export const TRACKER_WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const DEFAULT_MIN_USD = 1000;

function cloneDefaultTrackerConfig() {
  return { minUsd: DEFAULT_MIN_USD, wallets: [] };
}

function safeNickname(value) {
  if (typeof value !== "string") return "";
  return Array.from(value).slice(0, 40).join("");
}

export function normalizeTrackerWallet(value) {
  if (!value || typeof value !== "object") return null;
  const address = String(value.address || "");
  if (!TRACKER_WALLET_ADDRESS_RE.test(address)) return null;
  return {
    address: address.toLowerCase(),
    nickname: safeNickname(value.nickname),
  };
}

export function normalizeTrackerConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  const minUsd = typeof input.minUsd === "number" && Number.isFinite(input.minUsd)
    && input.minUsd >= TRACKER_CONFIG_MIN_USD
    && input.minUsd <= TRACKER_CONFIG_MAX_USD
    ? input.minUsd
    : DEFAULT_MIN_USD;
  const wallets = [];
  const seen = new Set();
  for (const candidate of Array.isArray(input.wallets) ? input.wallets : []) {
    const wallet = normalizeTrackerWallet(candidate);
    if (!wallet || seen.has(wallet.address)) continue;
    seen.add(wallet.address);
    wallets.push(wallet);
  }
  return { minUsd, wallets };
}

function secureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function secureFile(filePath) {
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

export function loadTrackerConfig({
  configPath = TRACKER_CONFIG_PATH,
  legacyConfigPath = LEGACY_TRACKER_CONFIG_PATH,
} = {}) {
  secureDirectory(path.dirname(configPath));
  const sourcePath = fs.existsSync(configPath)
    ? configPath
    : fs.existsSync(legacyConfigPath)
      ? legacyConfigPath
      : null;

  if (!sourcePath) return cloneDefaultTrackerConfig();

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch {
    return cloneDefaultTrackerConfig();
  }

  const normalized = normalizeTrackerConfig(parsed);
  secureFile(sourcePath);
  if (sourcePath === legacyConfigPath && !fs.existsSync(configPath)) {
    persistTrackerConfig(normalized, { configPath });
  }
  return normalized;
}

export function persistTrackerConfig(value, { configPath = TRACKER_CONFIG_PATH } = {}) {
  const normalized = normalizeTrackerConfig(value);
  const directory = path.dirname(configPath);
  secureDirectory(directory);
  const temporaryPath = `${configPath}.tmp`;
  const body = `${JSON.stringify(normalized, null, 2)}\n`;

  try {
    fs.writeFileSync(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
    secureFile(temporaryPath);
    fs.renameSync(temporaryPath, configPath);
    secureFile(configPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original persistence error; cleanup is best effort.
      }
    }
    throw error;
  }

  return normalized;
}
