import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

import { decodeErc1155TransferLog, getBlockchainTrackerHealth } from "../src/blockchain-tracker.js";

function addressTopic(address) {
  return ethers.zeroPadValue(address, 32);
}

test("Polygon health does not expose its RPC endpoint", () => {
  const health = getBlockchainTrackerHealth();
  assert.equal(typeof health.configured, "boolean");
  assert.equal(Object.hasOwn(health, "rpcUrl"), false);
  if (process.env.POLYGON_RPC_URL) {
    assert.equal(JSON.stringify(health).includes(process.env.POLYGON_RPC_URL), false);
  }
});

test("wallet tracker decodes ERC-1155 TransferBatch entries", () => {
  const fromAddress = "0x1111111111111111111111111111111111111111";
  const toAddress = "0x2222222222222222222222222222222222222222";
  const log = {
    topics: [
      ethers.id("TransferBatch(address,address,address,uint256[],uint256[])"),
      addressTopic("0x3333333333333333333333333333333333333333"),
      addressTopic(fromAddress),
      addressTopic(toAddress),
    ],
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[]", "uint256[]"],
      [[123n, 456n], [1500000n, 2750000n]],
    ),
  };

  assert.deepEqual(decodeErc1155TransferLog(log), {
    fromAddress,
    toAddress,
    transfers: [
      { assetId: "123", shares: 1.5 },
      { assetId: "456", shares: 2.75 },
    ],
  });
});

test("wallet tracker decodes ERC-1155 TransferSingle entries", () => {
  const fromAddress = "0x1111111111111111111111111111111111111111";
  const toAddress = "0x2222222222222222222222222222222222222222";
  const log = {
    topics: [
      ethers.id("TransferSingle(address,address,address,uint256,uint256)"),
      addressTopic("0x3333333333333333333333333333333333333333"),
      addressTopic(fromAddress),
      addressTopic(toAddress),
    ],
    data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [123n, 2500000n]),
  };

  assert.deepEqual(decodeErc1155TransferLog(log), {
    fromAddress,
    toAddress,
    transfers: [{ assetId: "123", shares: 2.5 }],
  });
});
