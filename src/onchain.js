import { ethers } from "ethers";

// Fallback to multiple RPCs for reliability since free public RPCs can be flaky
const RPC_URLS = [
  process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
];

// USDC contract on Polygon
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
// Polymarket CTF Exchange
const POLYMARKET_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

const usdcAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

let activeProvider = null;

function getProvider() {
  if (!activeProvider) {
    // Gunakan StaticJsonRpcProvider buat ngelewatin cek chainId berulang yang sering bikin free RPC nge-block (could not detect network)
    activeProvider = new ethers.providers.StaticJsonRpcProvider(RPC_URLS[0], 137);
  }
  return activeProvider;
}

/**
 * Memindai jaringan Polygon secara langsung untuk mendeteksi pergerakan USDC
 * ke arah Polymarket Exchange (Whale Deposits/Trades).
 * 
 * @param {number} minSizeUsdc - Batas minimum transfer paus (misal 1000)
 * @param {number} blocksToScan - Seberapa jauh ke belakang kita scan (100 block ~ 3 menit)
 * @returns {Promise<Array>} Array of whale activity
 */
export async function scanOnChainWhales(minSizeUsdc = 500, blocksToScan = 50) {
  try {
    const provider = getProvider();
    const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);
    
    // Filter semua transfer USDC menuju Polymarket Exchange
    const filter = usdcContract.filters.Transfer(null, POLYMARKET_EXCHANGE);
    
    const currentBlock = await provider.getBlockNumber();
    const startBlock = currentBlock - blocksToScan;
    
    const logs = await usdcContract.queryFilter(filter, startBlock, currentBlock);
    
    const whales = [];
    
    for (const log of logs) {
      const fromWallet = log.args[0];
      const value = Number(ethers.utils.formatUnits(log.args[2], 6)); // USDC 6 decimals
      
      if (value >= minSizeUsdc) {
        // Ambil timestamp dari block
        const block = await provider.getBlock(log.blockNumber);
        
        whales.push({
          source: "ON-CHAIN",
          wallet: fromWallet,
          sizeUsdc: value,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          timestamp: block ? block.timestamp * 1000 : Date.now(),
        });
      }
    }
    
    // Urutkan dari yang paling gede
    return whales.sort((a, b) => b.sizeUsdc - a.sizeUsdc);
  } catch (error) {
    console.error("❌ [OnChain] Gagal nge-scan Polygon RPC:", error.message);
    return [];
  }
}

export function formatOnChainWhales(whales, minSizeUsdc = 500) {
  if (!whales || whales.length === 0) {
    return `🐋 *[ON-CHAIN] Tidak ada paus ≥ $${minSizeUsdc.toLocaleString()} masuk ke Polymarket dalam 5 menit terakhir.*\n\n_Sistem tracker on-chain lu aktif, tapi market lagi sepi._`;
  }

  let text = `🐋 *ON-CHAIN WHALE TRACKER* (≥ $${minSizeUsdc.toLocaleString()})\n`;
  text += `_Scanned directly from Polygon Blockchain (Crucix Clone)_\n\n`;

  for (const w of whales.slice(0, 15)) {
    const size = "$" + w.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const walletShort = `${w.wallet.slice(0, 6)}...${w.wallet.slice(-4)}`;
    const timeAgo = Math.round((Date.now() - w.timestamp) / 1000 / 60);
    
    text += `🟢 *${size}* masuk ke Polymarket\n`;
    text += `  👤 Wallet: \`${walletShort}\` (${timeAgo} menit lalu)\n`;
    text += `  🔗 Hash: \`${w.txHash.slice(0, 10)}...\`\n\n`;
  }

  return text.trim();
}
