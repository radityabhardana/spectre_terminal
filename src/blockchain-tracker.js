import { ethers } from "ethers";
import { trackedWallets, getMarketMap, getSnifferState, pushWhaleEvent } from "./sniffer.js";

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const CTF_CONTRACT_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const TRANSFER_SINGLE_TOPIC = ethers.id("TransferSingle(address,address,address,uint256,uint256)");
const TRANSFER_BATCH_TOPIC = ethers.id("TransferBatch(address,address,address,uint256[],uint256[])");
const POLL_INTERVAL_MS = 3000;
const LOG_RATE_LIMIT_MS = 60000;
const LIVE_PRICE_MAX_AGE_MS = 30000;
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
const abiCoder = ethers.AbiCoder.defaultAbiCoder();

let provider = null;
let pollInterval = null;
let pollInFlightGeneration = null;
let pollGeneration = 0;
let lastBlockChecked = 0;
let lastErrorLogAt = 0;

const blockchainHealth = {
  configured: Boolean(POLYGON_RPC_URL),
  state: POLYGON_RPC_URL ? "STOPPED" : "OFFLINE",
  lastBlock: null,
  lastPollAt: null,
  lastMatchAt: null,
  errorCount: 0,
  lastError: null,
};

function safeErrorMessage(error) {
  let message = String(error?.shortMessage || error?.message || error || "Unknown Polygon error");
  if (POLYGON_RPC_URL) message = message.replaceAll(POLYGON_RPC_URL, "[redacted RPC]");
  return message.replace(/\bhttps?:\/\/[^\s]+/gi, "[redacted RPC]").slice(0, 300);
}

function recordTrackerError(error, context) {
  const message = safeErrorMessage(error);
  blockchainHealth.errorCount += 1;
  blockchainHealth.lastError = message;
  blockchainHealth.state = "DEGRADED";
  const now = Date.now();
  if (now - lastErrorLogAt >= LOG_RATE_LIMIT_MS) {
    lastErrorLogAt = now;
    console.error(`[Blockchain Tracker] ${context} error (${blockchainHealth.errorCount} total): ${message}`);
  }
}

function topicAddress(topic) {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40).toLowerCase()}`;
}

export function decodeErc1155TransferLog(log) {
  if (!Array.isArray(log?.topics) || log.topics.length < 4) return null;
  const topic = String(log.topics[0]).toLowerCase();
  const fromAddress = topicAddress(log.topics[2]);
  const toAddress = topicAddress(log.topics[3]);
  if (!fromAddress || !toAddress) return null;

  if (topic === TRANSFER_SINGLE_TOPIC.toLowerCase()) {
    const [id, value] = abiCoder.decode(["uint256", "uint256"], log.data);
    return {
      fromAddress,
      toAddress,
      transfers: [{ assetId: id.toString(), shares: Number(ethers.formatUnits(value, 6)) }],
    };
  }
  if (topic === TRANSFER_BATCH_TOPIC.toLowerCase()) {
    const [ids, values] = abiCoder.decode(["uint256[]", "uint256[]"], log.data);
    if (ids.length !== values.length) throw new Error("TransferBatch IDs and values length mismatch");
    return {
      fromAddress,
      toAddress,
      transfers: ids.map((id, index) => ({
        assetId: id.toString(),
        shares: Number(ethers.formatUnits(values[index], 6)),
      })),
    };
  }
  return null;
}

function findMarketForAsset(assetId) {
  const marketMap = getMarketMap();
  for (const market of Object.values(marketMap)) {
    if (!Array.isArray(market.clobTokenIds) || market.clobTokenIds.length < 2) continue;
    if (String(market.clobTokenIds[0]) === assetId) return { market, outcome: "UP" };
    if (String(market.clobTokenIds[1]) === assetId) return { market, outcome: "DOWN" };
  }
  return null;
}

function triggerAlert(marketInfo, outcome, sizeUsdc, shares, price, side, walletAddress, nickname, txHash, valuationUnavailable) {
  pushWhaleEvent({
    market_id: marketInfo.id,
    market_question: marketInfo.question,
    market_slug: marketInfo.slug,
    duration_type: marketInfo.duration_type,
    asset: marketInfo.asset,
    outcome,
    sizeUsdc,
    shares,
    price,
    side,
    maker: walletAddress,
    timestamp: Date.now(),
    isTracked: true,
    wallet_nickname: nickname,
    txHash,
    event_type: "TOKEN_TRANSFER",
    valuationUnavailable,
  });
}

function parseTransferLog(log) {
  const decoded = decodeErc1155TransferLog(log);
  if (!decoded) return 0;

  // Map.has is intentional: an empty nickname still represents a tracked wallet.
  const hasTrackedFrom = trackedWallets.has(decoded.fromAddress);
  const hasTrackedTo = trackedWallets.has(decoded.toAddress);
  if (!hasTrackedFrom && !hasTrackedTo) return 0;

  let matches = 0;
  for (const transfer of decoded.transfers) {
    if (!Number.isFinite(transfer.shares) || transfer.shares <= 0) continue;
    const marketMatch = findMarketForAsset(transfer.assetId);
    if (!marketMatch) continue;
    const livePrice = Number(global.livePrices?.[transfer.assetId]);
    const livePriceAt = Number(global.livePriceTimestamps?.[transfer.assetId]);
    const hasFreshPrice = Number.isFinite(livePrice)
      && livePrice > 0
      && Number.isFinite(livePriceAt)
      && Date.now() - livePriceAt <= LIVE_PRICE_MAX_AGE_MS;
    const price = hasFreshPrice ? livePrice : null;
    const sizeUsdc = hasFreshPrice ? transfer.shares * livePrice : null;

    if (hasTrackedFrom) {
      triggerAlert(
        marketMatch.market,
        marketMatch.outcome,
        sizeUsdc,
        transfer.shares,
        price,
        decoded.toAddress === ZERO_ADDRESS ? "BURN" : "TRANSFER_OUT",
        decoded.fromAddress,
        trackedWallets.get(decoded.fromAddress),
        log.transactionHash,
        !hasFreshPrice,
      );
      matches += 1;
    }
    if (hasTrackedTo) {
      triggerAlert(
        marketMatch.market,
        marketMatch.outcome,
        sizeUsdc,
        transfer.shares,
        price,
        decoded.fromAddress === ZERO_ADDRESS ? "MINT" : "TRANSFER_IN",
        decoded.toAddress,
        trackedWallets.get(decoded.toAddress),
        log.transactionHash,
        !hasFreshPrice,
      );
      matches += 1;
    }
  }
  return matches;
}

async function pollLogs(generation) {
  if (!provider || pollInFlightGeneration !== null || generation !== pollGeneration) return;
  pollInFlightGeneration = generation;
  blockchainHealth.lastPollAt = Date.now();
  let parserFailed = false;
  try {
    const currentBlock = await provider.getBlockNumber();
    if (generation !== pollGeneration) return;
    if (getSnifferState() && Object.keys(getMarketMap()).length === 0) {
      blockchainHealth.state = "WAITING_FOR_MARKETS";
      blockchainHealth.lastBlock = currentBlock;
      return;
    }
    if (lastBlockChecked === 0) lastBlockChecked = Math.max(0, currentBlock - 1);

    if (currentBlock > lastBlockChecked) {
      const logs = await provider.getLogs({
        address: CTF_CONTRACT_ADDRESS,
        topics: [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]],
        fromBlock: lastBlockChecked + 1,
        toBlock: currentBlock,
      });
      if (generation !== pollGeneration) return;
      if (getSnifferState()) {
        for (const log of logs) {
          try {
            const matches = parseTransferLog(log);
            if (matches > 0) blockchainHealth.lastMatchAt = Date.now();
          } catch (error) {
            recordTrackerError(error, "parser");
            parserFailed = true;
          }
        }
      }
      lastBlockChecked = currentBlock;
    }
    blockchainHealth.lastBlock = currentBlock;
    if (!parserFailed) {
      blockchainHealth.state = getSnifferState() ? "RUNNING" : "PAUSED";
      blockchainHealth.lastError = null;
    }
  } catch (error) {
    if (generation === pollGeneration) recordTrackerError(error, "poll");
  } finally {
    if (pollInFlightGeneration === generation) pollInFlightGeneration = null;
  }
}

export function initBlockchainTracker() {
  if (!POLYGON_RPC_URL) {
    blockchainHealth.state = "OFFLINE";
    console.warn("[Blockchain Tracker] POLYGON_RPC_URL is not configured; wallet tracking is offline.");
    return false;
  }
  if (pollInterval) return true;

  try {
    pollGeneration += 1;
    const generation = pollGeneration;
    provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    lastBlockChecked = 0;
    blockchainHealth.state = "CONNECTING";
    console.log("[Blockchain Tracker] Polygon RPC configured; starting wallet tracker.");
    pollLogs(generation);
    pollInterval = setInterval(() => pollLogs(generation), POLL_INTERVAL_MS);
    return true;
  } catch (error) {
    recordTrackerError(error, "initialization");
    return false;
  }
}

export function stopBlockchainTracker() {
  pollGeneration += 1;
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
  pollInFlightGeneration = null;
  if (provider && typeof provider.destroy === "function") {
    try {
      provider.destroy();
    } catch (error) {
      recordTrackerError(error, "shutdown");
    }
  }
  provider = null;
  blockchainHealth.state = blockchainHealth.configured ? "STOPPED" : "OFFLINE";
  return getBlockchainTrackerHealth();
}

export function getBlockchainTrackerHealth() {
  return { ...blockchainHealth };
}
