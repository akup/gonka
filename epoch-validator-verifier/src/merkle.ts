import { createHash } from "crypto";
import { verifyMembership, calculateExistenceRoot } from "@confio/ics23";
import { ics23 } from "@confio/ics23";
import { iavlSpec, tendermintSpec } from "@confio/ics23";
import { getRpcClient } from "./rpc-client.js";

export interface AbciQueryWithProofResult {
  value: Uint8Array;
  proofOps: ProofOp[] | null;
  height: number;
}

export interface ProofOp {
  type: string;
  key: Uint8Array;
  data: Uint8Array;
}

/** Raw RPC response.response may use snake_case (proof_ops). */
interface RawAbciResponse {
  code?: number;
  key?: string;
  value?: string;
  height?: string;
  proof_ops?: { ops?: Array<{ type?: string; key?: string; data?: string }> };
  proofOps?: { ops?: Array<{ type?: string; key?: string; data?: string }> };
}

/**
 * Fetch raw abci_query JSON-RPC response to read proof_ops (Tendermint uses snake_case).
 * CosmJs decoder reads proofOps (camelCase) so proofs can be missing when node sends proof_ops.
 */
async function rawAbciQueryWithProof(
  rpcUrl: string,
  path: string,
  data: Uint8Array,
  height?: number
): Promise<{ value: Uint8Array; proofOps: ProofOp[]; height: number; code: number }> {
  // Tendermint RPC abci_query expects data as hex (same as CosmJs encodeAbciQueryParams)
  const dataHex = Buffer.from(data).toString("hex");
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "abci_query",
    params: {
      path,
      data: dataHex,
      prove: true,
      ...(height != null && { height: String(height) }),
    },
  };
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`abci_query raw fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { result?: { response?: RawAbciResponse }; error?: { message?: string } };
  if (json.error) {
    throw new Error(`abci_query error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  const response = json.result?.response;
  if (!response) {
    throw new Error("abci_query: missing result.response");
  }
  const code = response.code ?? 0;
  const value =
    response.value != null
      ? Uint8Array.from(Buffer.from(response.value, "base64"))
      : new Uint8Array(0);
  const heightNum = response.height != null ? parseInt(response.height, 10) : 0;
  const proofOps: ProofOp[] = [];
  const ops = response.proof_ops?.ops ?? response.proofOps?.ops ?? [];
  for (const op of ops) {
    proofOps.push({
      type: op.type ?? "",
      key: op.key != null ? Uint8Array.from(Buffer.from(op.key, "base64")) : new Uint8Array(0),
      data: op.data != null ? Uint8Array.from(Buffer.from(op.data, "base64")) : new Uint8Array(0),
    });
  }
  return { value, proofOps, height: heightNum, code };
}

/**
 * Run ABCI query with prove=true to get value and merkle proof.
 * Uses raw JSON-RPC so proof_ops (snake_case) from the node are read correctly.
 */
export async function abciQueryWithProof(
  path: string,
  data: Uint8Array,
  height?: number
): Promise<AbciQueryWithProofResult> {
  const { url } = await getRpcClient();

  const raw = await rawAbciQueryWithProof(url, path, data, height);

  if (raw.code !== 0) {
    throw new Error(`ABCI query failed: code=${raw.code}`);
  }

  return {
    value: raw.value,
    proofOps: raw.proofOps.length > 0 ? raw.proofOps : null,
    height: raw.height,
  };
}

/** Format bytes as hex for debug logs; cap length to avoid huge output. */
function hexSlice(b: Uint8Array, maxLen = 64): string {
  const hex = Buffer.from(b).toString("hex");
  return hex.length <= maxLen ? hex : hex.slice(0, maxLen) + "...";
}

/** Protobuf-style varint encode (same as @confio/ics23 VAR_PROTO). */
function encodeVarintProto(n: number): Uint8Array {
  const enc: number[] = [];
  let l = n;
  while (l >= 128) {
    enc.push((l % 128) + 128);
    l = Math.floor(l / 128);
  }
  enc.push(l);
  return new Uint8Array(enc);
}

/**
 * Debug: build multistore root from simple proof step-by-step (same as @confio/ics23 tendermintSpec).
 * Use this to compare leaf preimage and intermediate hashes with the chain's CommitInfo.Hash().
 */
function debugBuildRootFromSimpleProof(
  storeKey: Uint8Array,
  storeRoot: Uint8Array,
  exist: ics23.IExistenceProof
): void {
  const key = exist.key ?? storeKey;
  const value = exist.value ?? storeRoot;
  const path = exist.path ?? [];

  // Leaf (tendermintSpec): prefix 0x00, key unhashed + VAR_PROTO, value SHA256 + VAR_PROTO, then SHA256(leafPreimage)
  const pkey = new Uint8Array([...encodeVarintProto(key.length), ...key]);
  const valueHash = createHash("sha256").update(value).digest();
  const pvalue = new Uint8Array([...encodeVarintProto(valueHash.length), ...valueHash]);
  const leafPrefix = new Uint8Array([0]); // tendermintSpec leaf prefix
  const leafPreimage = new Uint8Array([...leafPrefix, ...pkey, ...pvalue]);
  const leafHash = createHash("sha256").update(leafPreimage).digest();

  console.log("  [debug root build] leaf preimage length:", leafPreimage.length, "hex:", hexSlice(leafPreimage, 128));
  console.log("  [debug root build] leaf hash (hex):", hexSlice(leafHash));

  let current = leafHash;
  path.forEach((inner, i) => {
    const prefix = inner.prefix ?? new Uint8Array(0);
    const suffix = inner.suffix ?? new Uint8Array(0);
    const childHashHex = hexSlice(current);
    const preimage = new Uint8Array([...prefix, ...current, ...suffix]);
    current = createHash("sha256").update(preimage).digest();
    console.log("  [debug root build] inner[" + i + "] prefixLen:", prefix.length, "suffixLen:", suffix.length, "childHash:", childHashHex, "-> result:", hexSlice(current));
  });

  console.log("  [debug root build] final calculated root (hex):", hexSlice(current));
}

/**
 * Verify that the proof commits to the given key/value and matches the expected root (app_hash).
 * Uses ICS23 (Cosmos proof format): supports single IAVL op or multistore (first op = store root, second = IAVL).
 * When DEBUG_VERIFY=1, logs step-by-step verification details.
 */
export function verifyProofAgainstRoot(
  proofOps: ProofOp[],
  key: Uint8Array,
  value: Uint8Array,
  expectedRoot: Uint8Array
): boolean {
  const debug = process.env.DEBUG_VERIFY === "1" || process.env.DEBUG_VERIFY === "true";

  if (debug) {
    console.log("[verify] Step 0: inputs");
    console.log("  expectedRoot (app_hash) length:", expectedRoot.length, "hex:", hexSlice(expectedRoot));
    console.log("  key length:", key.length, "hex:", hexSlice(Buffer.from(key)));
    console.log("  value length:", value.length);
    console.log("  proofOps count:", proofOps.length);
    proofOps.forEach((op, i) => {
      console.log("  op[" + i + "] type:", op.type, "keyLen:", op.key.length, "keyHex:", hexSlice(op.key), "dataLen:", op.data.length);
    });
  }

  if (expectedRoot.length === 0 || proofOps.length === 0) {
    if (debug) console.log("[verify] FAIL: empty expectedRoot or proofOps");
    return false;
  }

  const CommitmentProof = ics23.CommitmentProof;
  if (!CommitmentProof?.decode) {
    if (debug) console.log("[verify] FAIL: CommitmentProof.decode not available");
    return false;
  }

  try {
    if (proofOps.length === 1) {
      if (debug) console.log("[verify] Step 1: single-op (IAVL root = app_hash)");
      const proof = decodeCommitmentProof(proofOps[0].data, CommitmentProof);
      const opKey = proofOps[0].key.length > 0 ? proofOps[0].key : key;
      const ok = verifyMembership(proof, iavlSpec, expectedRoot, opKey, value);
      if (debug) console.log("[verify] single-op verifyMembership(iavlSpec):", ok ? "OK" : "FAIL");
      return ok;
    }

    // Multistore: one op = store root under app_hash (ics23:simple), one op = IAVL key/value (ics23:iavl).
    // Node may return [iavl, simple] or [simple, iavl]; identify by type.
    const simpleOp = proofOps.find((op) => op.type.includes("simple"));
    const iavlOp = proofOps.find((op) => op.type.includes("iavl"));
    if (!simpleOp || !iavlOp) {
      if (debug) console.log("[verify] FAIL: multistore requires one ics23:simple and one ics23:iavl op");
      return false;
    }

    if (debug) console.log("[verify] Step 1: multistore — verify simple op (store root under app_hash)");
    const simpleProof = decodeCommitmentProof(simpleOp.data, CommitmentProof);
    const storeKey = simpleOp.key;
    const storeRoot = getExistenceProofValue(simpleProof);
    if (debug) {
      console.log("  storeKey (simple op key) hex:", hexSlice(storeKey), "ascii:", storeKey.length <= 32 ? Buffer.from(storeKey).toString("utf8").replace(/[^\x20-\x7e]/g, ".") : "(long)");
      console.log("  storeRoot (from simple proof) length:", storeRoot?.length ?? 0, "hex:", storeRoot ? hexSlice(storeRoot) : "null");
    }
    if (!storeRoot) {
      if (debug) console.log("[verify] FAIL: could not get store root from simple proof");
      return false;
    }

    // tendermintSpec must match the chain's multistore simple tree (0x00 leaf prefix, uvarint lengths, childSize 32).
    // If the chain uses gonka-ai/cosmos-sdk or another fork with different store/proof encoding, root may mismatch; see docs/simple-proof-and-app-hash.md.
    if (debug) console.log("[verify] Step 2: verify simple op (store root membership under app_hash, tendermint/simple spec)");
    const simpleOk = verifyMembership(simpleProof, tendermintSpec, expectedRoot, storeKey, storeRoot);
    if (debug) {
      console.log("  verifyMembership(tendermintSpec, expectedRoot, storeKey, storeRoot):", simpleOk ? "OK" : "FAIL");
      if (!simpleOk && simpleProof.exist?.key && simpleProof.exist?.value) {
        try {
          const calculatedRoot = calculateExistenceRoot(simpleProof.exist);
          console.log("  [debug] calculated root from simple proof (hex):", hexSlice(calculatedRoot));
          console.log("  [debug] expected app_hash (hex):", hexSlice(expectedRoot));
          console.log("  [debug] roots equal:", calculatedRoot.length === expectedRoot.length && calculatedRoot.every((b, i) => b === expectedRoot[i]));
          console.log("  [debug] --- step-by-step root build (compare with chain CommitInfo.Hash) ---");
          debugBuildRootFromSimpleProof(storeKey, storeRoot, simpleProof.exist);
        } catch (e) {
          console.log("  [debug] calculateExistenceRoot failed:", (e as Error).message);
        }
      }
    }
    if (!simpleOk) return false;

    if (debug) console.log("[verify] Step 3: verify IAVL op (key/value under store root)");
    const opKey = iavlOp.key.length > 0 ? iavlOp.key : key;
    if (debug) console.log("  opKey hex:", hexSlice(Buffer.from(opKey)), "valueLen:", value.length);
    const iavlOk = verifyMembership(decodeCommitmentProof(iavlOp.data, CommitmentProof), iavlSpec, storeRoot, opKey, value);
    if (debug) console.log("  verifyMembership(iavlSpec, storeRoot, opKey, value):", iavlOk ? "OK" : "FAIL");
    return iavlOk;
  } catch (e) {
    const msg = (e as Error).message;
    console.warn("Merkle proof verification failed:", msg);
    if (debug) console.warn("  stack:", (e as Error).stack);
    return false;
  }
}

function decodeCommitmentProof(
  data: Uint8Array,
  CommitmentProof: { decode: (r: Uint8Array, len?: number) => ics23.ICommitmentProof }
): ics23.ICommitmentProof {
  return CommitmentProof.decode(data) as ics23.ICommitmentProof;
}

function getExistenceProofValue(proof: ics23.ICommitmentProof): Uint8Array | null {
  if (proof.exist?.value?.length) return proof.exist.value;
  const decompressed = (proof as { compressed?: { entries?: Array<{ exist?: { value?: Uint8Array } }> } }).compressed;
  const first = decompressed?.entries?.[0]?.exist?.value;
  if (first?.length) return first;
  const batch = (proof as { batch?: { entries?: Array<{ exist?: { value?: Uint8Array } }> } }).batch;
  const batchFirst = batch?.entries?.[0]?.exist?.value;
  return batchFirst ?? null;
}

function toUint8Array(x: string | Uint8Array | undefined): Uint8Array {
  if (x == null) return new Uint8Array(0);
  if (typeof x === "string") return Uint8Array.from(Buffer.from(x, "base64"));
  return x;
}
