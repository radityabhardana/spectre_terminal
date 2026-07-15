import { ethers } from "ethers";
import { trackedWallets, marketMap, snifferMinUsd, getSnifferState, pushWhaleEvent } from "./sniffer.js";

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const CTF_CONTRACT_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

let provider;
export function initBlockchainTracker() {
  if (!POLYGON_RPC_URL) {
    console.warn("⚠️ [Blockchain Tracker] POLYGON_RPC_URL not set in .env. Wallet tracking will not work.");
    return;
  }

  try {
    provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    console.log(`🔗 [Blockchain Tracker] Connected to Polygon RPC: ${POLYGON_RPC_URL.split("://")[1].split("/")[0]}...`);

    const filter = {
      address: CTF_CONTRACT_ADDRESS,
      topics: [TRANSFER_SINGLE_TOPIC]
    };

    provider.on(filter, (log) => {
      if (!getSnifferState()) return; // Pause tracking if sniffer is inactive

      try {
        parseTransferSingleLog(log);
      } catch (err) {
        console.error("❌ [Blockchain Tracker] Error parsing log:", err.message);
      }
    });

  } catch (err) {
    console.error("❌ [Blockchain Tracker] Failed to initialize:", err.message);
  }
}

function parseTransferSingleLog(log) {
  // TransferSingle(address operator, address from, address to, uint256 id, uint256 value)
  
  if (!log.topics || log.topics.length < 4) return;
  
  const fromAddress = "0x" + log.topics[2].slice(26).toLowerCase();
  const toAddress = "0x" + log.topics[3].slice(26).toLowerCase();

  const trackedFrom = trackedWallets.get(fromAddress);
  const trackedTo = trackedWallets.get(toAddress);

  if (!trackedFrom && !trackedTo) return; // Ignore if not tracked

  // Extract ID (assetId) and Value (shares/size) from data
  const data = log.data.replace("0x", "");
  if (data.length < 128) return;

  const assetIdHex = "0x" + data.slice(0, 64);
  const valueHex = "0x" + data.slice(64, 128);

  const assetIdStr = BigInt(assetIdHex).toString();
  const shares = Number(BigInt(valueHex)) / 1e6; // Polymarket CTF tokens have 6 decimals

  if (shares <= 0) return;

  // We need to match assetId to our marketMap
  let foundMarketInfo = null;
  let outcome = "UNKNOWN";

  for (const mId in marketMap) {
    const m = marketMap[mId];
    if (m.clobTokenIds && m.clobTokenIds.length >= 2) {
      if (m.clobTokenIds[0] === assetIdStr) {
        foundMarketInfo = m;
        outcome = "UP";
        break;
      } else if (m.clobTokenIds[1] === assetIdStr) {
        foundMarketInfo = m;
        outcome = "DOWN";
        break;
      }
    }
  }

  if (!foundMarketInfo) return;

  // Find approximate price from global.livePrices (updated by WS)
  const price = global.livePrices && global.livePrices[assetIdStr] ? global.livePrices[assetIdStr] : 0.5; 
  const sizeUsdc = shares * price;

  // For `from`, they are selling or burning
  if (trackedFrom) {
    triggerAlert(foundMarketInfo, outcome, sizeUsdc, shares, price, "SELL", fromAddress, trackedFrom, log.transactionHash);
  }

  // For `to`, they are buying or minting
  if (trackedTo) {
    triggerAlert(foundMarketInfo, outcome, sizeUsdc, shares, price, "BUY", toAddress, trackedTo, log.transactionHash);
  }
}

function triggerAlert(marketInfo, outcome, sizeUsdc, shares, price, side, walletAddress, nickname, txHash) {
  const whaleObj = {
    market_id: marketInfo.id,
    market_question: marketInfo.question,
    market_slug: marketInfo.slug,
    duration_type: marketInfo.duration_type,
    asset: marketInfo.asset,
    outcome: outcome,
    sizeUsdc: sizeUsdc,
    price: price,
    side: side,
    maker: walletAddress,
    timestamp: Date.now(),
    isTracked: true,
    wallet_nickname: nickname,
    txHash: txHash
  };

  pushWhaleEvent(whaleObj);
}
