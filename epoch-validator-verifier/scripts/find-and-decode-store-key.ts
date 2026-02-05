/**
 * Check all EpochGroupData store keys (epochs 1..latest), report response for each, decode when value present.
 * Usage: npx tsx scripts/find-and-decode-store-key.ts
 * Or:    RPC_URL_1=http://... npx tsx scripts/find-and-decode-store-key.ts
 */

import "dotenv/config";
import { getRpcClient } from "../src/rpc-client.js";
import { getLatestEpochInfo, getEpochGroupDataByStoreKey, epochGroupDataStoreKeyHex } from "../src/epoch.js";
import type { EpochGroupDataDecoded } from "../src/epoch.js";
import { INFERENCE_STORE_PATH } from "../src/config.js";

interface EpochResult {
  epochIndex: number;
  keyHex: string;
  valueLength: number;
  decoded: EpochGroupDataDecoded | null;
}

async function main(): Promise<void> {
  const { url } = await getRpcClient();
  console.log("RPC:", url);

  console.log("1. Getting latest epoch (EpochInfo)...");
  const epochInfo = await getLatestEpochInfo();
  const latestEpoch = epochInfo.latestEpoch.index;
  console.log("   Latest epoch index:", latestEpoch);

  const storePath = INFERENCE_STORE_PATH;
  const results: EpochResult[] = [];

  console.log("2. Checking store keys for all epochs 1.." + latestEpoch + " (no height = latest)...");
  for (let epochIndex = 1; epochIndex <= latestEpoch; epochIndex++) {
    const keyHex = epochGroupDataStoreKeyHex(epochIndex, "");
    const r = await getEpochGroupDataByStoreKey(epochIndex, "", undefined);
    results.push({
      epochIndex,
      keyHex,
      valueLength: r.value.length,
      decoded: r.decoded,
    });
    const status = r.value.length === 0 ? "no value" : r.decoded ? "decoded, " + (r.decoded.validationWeights?.length ?? 0) + " participants" : "value present, decode failed";
    console.log("   Epoch", String(epochIndex).padStart(3), "key", keyHex, "->", status);
  }

  const withValue = results.filter((x) => x.valueLength > 0);
  const decodedOk = results.filter((x) => x.decoded != null);

  console.log("\n3. Summary:");
  console.log("   Epochs with value:", withValue.length, "/", results.length);
  console.log("   Epochs decoded:", decodedOk.length);

  if (decodedOk.length > 0) {
    console.log("\n4. Decoded EpochGroupData (all with value):");
    for (const { epochIndex, keyHex, decoded } of decodedOk) {
      if (!decoded) continue;
      console.log("\n   --- Epoch " + epochIndex + " ---");
      console.log("   epochIndex:", decoded.epochIndex, "pocStartBlockHeight:", decoded.pocStartBlockHeight, "participants:", decoded.validationWeights?.length ?? 0);
      if (decoded.validationWeights && decoded.validationWeights.length > 0) {
        console.log("   First 3:", decoded.validationWeights.slice(0, 3).map((p) => p.memberAddress + " weight=" + p.weight).join("; "));
      }
    }
    const first = decodedOk[0];
    console.log("\n5. Curl example (epoch " + first.epochIndex + "):");
    console.log(
      `curl -s -X POST "${url}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"abci_query","params":{"path":"${storePath}","data":"${first.keyHex}","prove":false}}'`
    );
  }

  if (withValue.length === 0) {
    console.log("\nNo epoch returned value.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
