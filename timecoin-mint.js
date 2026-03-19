// timecoin-mint.js — Mint TIMECOIN on Tempo chain
// Usage: PRIVATE_KEY=0x... node timecoin-mint.js [count]
// Requires: npm install ethers

const { ethers } = require("ethers");

// ── Config ──
const RPC_URL = "https://rpc.tempo.xyz";
const CHAIN_ID = 4217;
const USDC_ADDRESS = "0x20c000000000000000000000b9537d11c60e8b50";
const TREASURY = "0x0CAC4C432Ae8E553E3DEacc7e6AF30dD5b14Cd20";
const MINT_PRICE_RAW = "500000"; // 0.50 USDC (6 decimals)
const API_URL = "https://api.timecoinmpp.xyz";

const CLAIM_MAX_RETRIES = 30;
const CLAIM_RETRY_DELAY_MS = 5000; // 3 seconds between retries

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claimWithRetry(txHash, walletAddress) {
  for (let attempt = 1; attempt <= CLAIM_MAX_RETRIES; attempt++) {
    try {
      console.log(`  Claim attempt ${attempt}/${CLAIM_MAX_RETRIES}...`);
      const res = await fetch(API_URL + "/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash, wallet: walletAddress }),
      });

      const result = await res.json();

      if (res.ok && result.success) {
        return result; // success
      }

      console.warn(`  Claim failed: ${result.error || JSON.stringify(result)}`);

      // If server says tx already claimed or invalid, don't retry
      if (result.error && (
        result.error.includes("already claimed") ||
        result.error.includes("already used") ||
        result.error.includes("invalid")
      )) {
        console.error(`  Non-retryable error. Skipping.`);
        return null;
      }

    } catch (err) {
      console.warn(`  Claim request error: ${err.message}`);
    }

    if (attempt < CLAIM_MAX_RETRIES) {
      console.log(`  Retrying in ${CLAIM_RETRY_DELAY_MS / 1000}s...`);
      await sleep(CLAIM_RETRY_DELAY_MS);
    }
  }

  console.error(`  ❌ All ${CLAIM_MAX_RETRIES} claim attempts failed for tx ${txHash}`);
  console.error(`  ⚠️  USDC was sent. Save this txHash and try claiming manually later.`);
  return null;
}

async function mint() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("Set PRIVATE_KEY env var: PRIVATE_KEY=0x... node timecoin-mint.js [count]");
    process.exit(1);
  }

  const mintCount = parseInt(process.argv[2]) || 1;
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(pk, provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Mints requested: ${mintCount}`);
  console.log(`Total USDC needed: ${(mintCount * 0.5).toFixed(2)}`);

  // Check USDC balance
  const balance = await usdc.balanceOf(wallet.address);
  const balanceFormatted = Number(balance) / 1e6;
  console.log(`USDC balance: ${balanceFormatted}\n`);

  const totalNeeded = BigInt(MINT_PRICE_RAW) * BigInt(mintCount);
  if (balance < totalNeeded) {
    console.error(`Insufficient USDC. Need ${Number(totalNeeded) / 1e6}, have ${balanceFormatted}`);
    process.exit(1);
  }

  let succeeded = 0;
  let failed = 0;
  const failedTxHashes = [];

  for (let i = 1; i <= mintCount; i++) {
    console.log(`═══════════════════════════════════════`);
    console.log(`Mint ${i}/${mintCount}`);
    console.log(`═══════════════════════════════════════`);

    // Step 1: Transfer USDC
    try {
      console.log(`Sending 0.50 USDC to treasury...`);
      const tx = await usdc.transfer(TREASURY, BigInt(MINT_PRICE_RAW));
      console.log(`TX: ${tx.hash}`);
      console.log(`Waiting for confirmation...`);

      const receipt = await tx.wait();
      if (receipt.status !== 1) {
        console.error(`TX failed on-chain. Skipping mint ${i}.`);
        failed++;
        continue;
      }
      console.log(`Confirmed in block ${receipt.blockNumber}`);

      // Step 2: Claim with retry (don't proceed to next mint until resolved)
      console.log(`Claiming tokens...`);
      const result = await claimWithRetry(tx.hash, wallet.address);

      if (result) {
        console.log(`✅ Mint ${i} success! Received ${result.tokens || 20000} TIMECOIN`);
        if (result.txHash) console.log(`Claim TX: ${result.txHash}`);
        succeeded++;
      } else {
        console.error(`❌ Mint ${i} claim failed. USDC was spent.`);
        failedTxHashes.push(tx.hash);
        failed++;
        // DON'T continue to next mint — ask user
        if (i < mintCount) {
          console.log(`\n⚠️  Stopping batch — claim failed. Fix before continuing.`);
          break;
        }
      }

    } catch (err) {
      if (err.code === "ACTION_REJECTED") {
        console.error(`Transaction rejected.`);
      } else {
        console.error(`Error: ${err.message}`);
      }
      failed++;
      break; // stop batch on unexpected errors
    }

    console.log();
  }

  // Summary
  console.log(`\n═══════════════════════════════════════`);
  console.log(`SUMMARY`);
  console.log(`═══════════════════════════════════════`);
  console.log(`Succeeded: ${succeeded}/${mintCount}`);
  console.log(`Failed: ${failed}`);

  if (failedTxHashes.length > 0) {
    console.log(`\n⚠️  Failed claim txHashes (USDC was sent, retry manually):`);
    failedTxHashes.forEach((h) => console.log(`  ${h}`));
  }

  const finalBalance = await usdc.balanceOf(wallet.address);
  console.log(`\nRemaining USDC: ${Number(finalBalance) / 1e6}`);
}

mint().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
