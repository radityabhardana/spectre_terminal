import { ClobClient } from "@polymarket/clob-client";
import { wallet } from "./wallet.js";
import { config } from "./config.js";
import fs from "fs";
import path from "path";

const CLOB_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon Mainnet

let clobClient = null;

export async function initTradeModule() {
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

  const credsPath = path.join(process.cwd(), ".gemini", "clob_creds.json");
  let creds = null;
  
  try {
    if (fs.existsSync(credsPath)) {
      creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
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
      creds = await tempClient.createApiKey();
      
      const dir = path.dirname(credsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
      
      clobClient = new ClobClient(CLOB_URL, CHAIN_ID, signerAdapter, creds);
      console.log("[Trade] CLOB API keys generated and saved successfully.");
    } catch (e) {
      console.error("[Trade] Failed to generate CLOB API keys:", e);
      return false;
    }
  }
  
  return true;
}

export async function executeMarketOrder(tokenId, side, sizeUsdc) {
  if (!clobClient) {
    throw new Error("CLOB Client not initialized. Please ensure wallet is connected.");
  }
  
  try {
    const orderbook = await clobClient.getOrderBook(tokenId);
    
    let sharesToBuy = 0;
    let usdcRemaining = parseFloat(sizeUsdc);
    let worstPrice = 0;
    
    // side === 'BUY' buys YES tokens (if tokenId is YES), side === 'SELL' sells them.
    // Wait, in CLOB, side is ALWAYS BUY if we are buying a token (YES or NO).
    // The user decides UP/DOWN which maps to a YES token or NO token.
    // So if the user wants to buy NO, we pass the NO tokenId, and side is STILL 'BUY'.
    const actualSide = "BUY";
    const books = orderbook.asks;
    
    // Sort asks ascending for BUY
    books.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    for (const level of books) {
      if (usdcRemaining <= 0) break;
      const price = parseFloat(level.price);
      const size = parseFloat(level.size); // in shares
      
      const costForLevel = size * price;
      
      if (usdcRemaining > costForLevel) {
        sharesToBuy += size;
        usdcRemaining -= costForLevel;
        worstPrice = price;
      } else {
        const partialShares = usdcRemaining / price;
        sharesToBuy += partialShares;
        usdcRemaining = 0;
        worstPrice = price;
      }
    }
    
    if (usdcRemaining > 0 && sharesToBuy === 0) {
      throw new Error(`Insufficient liquidity for ${sizeUsdc} USDC.`);
    }

    // Set a limit price 5% worse than the worst price needed, capped at 0.99
    const executionPrice = Math.min(worstPrice * 1.05, 0.99);
    
    // Round shares to 2 decimal places to match tick size / share size requirements
    const roundedShares = Math.floor(sharesToBuy * 100) / 100;
    const roundedPrice = Math.round(executionPrice * 1000) / 1000;

    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: roundedPrice,
      side: actualSide,
      size: roundedShares,
      feeRateBps: 0
    });
    
    const res = await clobClient.postOrder(order);
    return res;
  } catch (err) {
    console.error("[Trade] executeMarketOrder Error:", err);
    throw err;
  }
}
