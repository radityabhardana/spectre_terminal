import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { wallet } from "./wallet.js";
import { config } from "./config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const CLOB_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon Mainnet

let clobClient = null;
let initPromise = null;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validCredentials(creds) {
  return Boolean(creds?.key && creds?.secret && creds?.passphrase);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out; order state is unknown`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function initTradeModule() {
  if (initPromise) return initPromise;
  initPromise = initializeTradeModule();
  return initPromise;
}

async function initializeTradeModule() {
  if (!config.enableLiveTrading) return false;
  if (!wallet) {
    console.log("[Trade] No wallet initialized, skipping ClobClient.");
    return false;
  }

  // Create an adapter for ClobClient since it expects ethers v5 (_signTypedData)
  const signerAdapter = new Proxy(wallet, {
    get(target, prop) {
      if (prop === '_signTypedData') {
        return target.signTypedData.bind(target);
      }
      return Reflect.get(target, prop);
    }
  });

  const credsPath = path.join(projectRoot, ".gemini", "clob_creds.json");
  let creds = validCredentials({
    key: config.clobApiKey,
    secret: config.clobApiSecret,
    passphrase: config.clobApiPassphrase,
  }) ? {
    key: config.clobApiKey,
    secret: config.clobApiSecret,
    passphrase: config.clobApiPassphrase,
  } : null;
  
  try {
    if (!creds && fs.existsSync(credsPath)) {
      const stored = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
      if (validCredentials(stored)) creds = stored;
    }
  } catch (e) {
    console.error("[Trade] Failed to load CLOB credentials", e.message);
  }

  if (creds) {
    try {
      clobClient = new ClobClient(CLOB_URL, CHAIN_ID, signerAdapter, creds);
      console.log("[Trade] CLOB Client initialized using stored credentials.");
    } catch (e) {
      console.error("[Trade] Failed to init with creds:", e.message);
      creds = null; // Will regenerate
    }
  } 

  if (!creds) {
    try {
      console.log("[Trade] Generating new CLOB API keys...");
      const tempClient = new ClobClient(CLOB_URL, CHAIN_ID, signerAdapter);
      creds = await tempClient.createOrDeriveApiKey();
      if (!validCredentials(creds)) throw new Error("CLOB returned invalid API credentials");
      
      const dir = path.dirname(credsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
      fs.chmodSync(credsPath, 0o600);
      
      clobClient = new ClobClient(CLOB_URL, CHAIN_ID, signerAdapter, creds);
      console.log("[Trade] CLOB API keys generated and saved successfully.");
    } catch (e) {
      console.error("[Trade] Failed to generate CLOB API keys:", e);
      return false;
    }
  }
  
  return true;
}

export async function executeMarketOrder(tokenId, side, sizeUsdc, maxEntryPrice = config.tradeMaxPrice) {
  if (!clobClient) {
    throw new Error("CLOB Client not initialized. Please ensure wallet is connected.");
  }
  
  try {
    const amount = Number(sizeUsdc);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid USDC amount");
    if (side !== "BUY") throw new Error("Only BUY market orders are supported");

    const executionPrice = await clobClient.calculateMarketPrice(tokenId, Side.BUY, amount, OrderType.FOK);
    const priceCap = Math.min(config.tradeMaxPrice, Number(maxEntryPrice));
    if (!Number.isFinite(priceCap) || priceCap <= 0) throw new Error("Invalid maximum entry price");
    if (!Number.isFinite(executionPrice) || executionPrice <= 0 || executionPrice > priceCap) {
      throw new Error(`Executable price ${executionPrice} exceeds the signal cap ${priceCap}`);
    }

    const res = await withTimeout(clobClient.createAndPostMarketOrder({
      tokenID: tokenId,
      amount,
      price: executionPrice,
      side: Side.BUY,
      orderType: OrderType.FOK,
    }, undefined, OrderType.FOK), 15_000, "CLOB FOK submission");

    if (!res || res.success !== true || !res.orderID || res.error || res.errorMsg) {
      throw new Error(res?.errorMsg || res?.error || "CLOB rejected the order or returned an unknown result");
    }
    if (!/matched|filled/i.test(String(res.status || ""))) {
      throw new Error(`CLOB returned non-terminal order status '${res.status || "unknown"}'; reconciliation required`);
    }
    return res;
  } catch (err) {
    console.error("[Trade] executeMarketOrder Error:", err);
    throw err;
  }
}
