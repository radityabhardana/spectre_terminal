const { ethers } = require("ethers");

const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const POLYMARKET_EXCHANGE = "0x4bFB41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

const usdcAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);

console.log("Listening for USDC transfers to Polymarket CTF Exchange...");

const filter = usdcContract.filters.Transfer(null, POLYMARKET_EXCHANGE);

async function test() {
  const currentBlock = await provider.getBlockNumber();
  console.log("Current block:", currentBlock);
  // Scan last 100 blocks
  const logs = await usdcContract.queryFilter(filter, currentBlock - 100, currentBlock);
  console.log(`Found ${logs.length} USDC transfers to Polymarket in the last 100 blocks.`);
  for (const log of logs) {
    const from = log.args[0];
    const value = ethers.utils.formatUnits(log.args[2], 6); // USDC has 6 decimals
    if (parseFloat(value) >= 500) {
       console.log(`- 🐋 WHALE DEPOSIT: ${from} deposited $${value} USDC`);
    } else {
       console.log(`- ${from} deposited $${value} USDC`);
    }
  }
}

test().catch(console.error);
