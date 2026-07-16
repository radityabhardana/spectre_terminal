import { ethers } from "ethers";
import { config } from "./config.js";

// Polygon Mainnet configuration
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const USDC_CONTRACT_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

// Minimal ERC-20 ABI for balanceOf and decimals
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

let provider = null;
let wallet = null;
let usdcContract = null;

/**
 * Initializes the wallet and provider using the private key from config.
 */
export function initWallet() {
  if (!config.walletPrivateKey) {
    return false;
  }
  
  try {
    provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    let pKey = config.walletPrivateKey;
    if (!pKey.startsWith('0x')) {
      pKey = '0x' + pKey;
    }
    wallet = new ethers.Wallet(pKey, provider);
    usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, ERC20_ABI, provider);
    console.log(`[Wallet] Initialized for address: ${wallet.address}`);
    return true;
  } catch (err) {
    console.error("[Wallet] Failed to initialize:", err.message);
    return false;
  }
}

/**
 * Fetches the current wallet state including MATIC and USDC balances.
 */
export async function getWalletBalances() {
  if (!wallet || !provider || !usdcContract) {
    return {
      connected: false,
      address: null,
      matic: 0,
      usdc: 0
    };
  }

  try {
    const [maticBalanceRaw, usdcBalanceRaw, usdcDecimals] = await Promise.all([
      provider.getBalance(wallet.address),
      usdcContract.balanceOf(wallet.address),
      usdcContract.decimals()
    ]);

    const matic = parseFloat(ethers.formatEther(maticBalanceRaw));
    const usdc = parseFloat(ethers.formatUnits(usdcBalanceRaw, usdcDecimals));

    return {
      connected: true,
      address: wallet.address,
      matic,
      usdc
    };
  } catch (err) {
    console.error("[Wallet] Failed to fetch balances:", err.message);
    return {
      connected: true,
      address: wallet.address,
      matic: 0,
      usdc: 0,
      error: err.message
    };
  }
}
