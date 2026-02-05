# Epoch Validator Verifier

TypeScript project that connects to CometBFT RPC nodes and verifies that the block where a new epoch starts was signed by the **previous** epoch's validators. It also fetches epoch/block data and optionally validates merkle proofs.

## What it does

1. **RPC with failover** – Connects to the first available node from a list (`RPC_URL_1`, `RPC_URL_2`, or `config.ts`).
2. **Latest epoch** – Gets the latest epoch ID and the block height where that epoch started via ABCI query to the inference module (`EpochInfo`).
3. **Block at new epoch start** – Fetches the block at that height; its `LastCommit` is the commit (signatures) for the **previous** block.
4. **Previous validators** – Gets the consensus validator set at height `(new epoch start - 1)`.
5. **Merkle proof (optional)** – Runs ABCI query with `prove=true` for epoch group data and checks the proof against the block’s `app_hash` (full ICS23 verification is not implemented; see `merkle.ts`).
6. **Commit verification** – Verifies that the new epoch block’s `LastCommit` is signed by >2/3 of the previous epoch’s validators (Ed25519).

## Setup

```bash
cd epoch-validator-verifier
npm install
```

## Configuration

- **RPC nodes**: Set `RPC_URL_1` and optionally `RPC_URL_2` in the environment, or edit `src/config.ts` and set `RPC_NODES`.
- **REST API (optional)**: Set `API_BASE_URL` (e.g. `http://host:1317`) to fetch EpochGroupData via **regular HTTP GET** (REST / gRPC-gateway) instead of ABCI query. Same data, no JSON-RPC `abci_query`.
- **Query paths**: Inference module paths are in `src/config.ts` (`QUERY_EPOCH_INFO_PATH`, `QUERY_EPOCH_GROUP_DATA_PATH`, `EPOCH_GROUP_DATA_REST_PATH`). Adjust if your chain uses different module names.

## Run

```bash
# With env
RPC_URL_1=https://rpc.example.com:26657 npm run dev

# Or build and run
npm run build
RPC_URL_1=http://localhost:26657 npm start
```

## REST (regular HTTP GET) for EpochGroupData

When `API_BASE_URL` is set, the verifier uses a **regular HTTP GET** to the gRPC-gateway instead of ABCI query:

```bash
# Example: same host as RPC, API usually on port 1317
API_BASE_URL=http://185.92.223.230:1317 npm run dev
```

Manual GET (same as REST path). **Many nodes require the `x-cosmos-block-height` header**; otherwise you may get `invalid height: context did not contain latest block height`:

```bash
# EpochGroupData for epoch 157, model_id empty. Use a valid block height (e.g. epoch start or current).
curl -s "http://10.7.112.12:1317/productscience/inference/inference/epoch_group_data/157" \
  -H "x-cosmos-block-height: 2459069"
```

To get a valid height: `curl -s http://HOST:26657/status | jq .result.sync_info.latest_block_height` (use that value in the header). If you still get `invalid height`, try the epoch’s start block height or omit the header (some nodes default to latest). Response is JSON (e.g. `epoch_group_data.validation_weights`). No ABCI, no JSON-RPC — just HTTP GET.

## Manual curl (same as abciQueryWithProof)

You can get the **same JSON response** as `abciQueryWithProof` by calling the Tendermint RPC yourself. The node expects **JSON-RPC 2.0** over HTTP POST. Use your RPC base URL (e.g. `http://185.92.223.230:26657`).

**Important:** The `data` param must be **hex** (not base64). `prove: true` requests proof ops in the response.

**EpochGroupData** (same as `abciQueryWithProof` for EpochGroupData):

```bash
# Replace RPC_URL and optionally height. Data = hex-encoded QueryGetEpochGroupDataRequest.
# Example: epoch_index=158, model_id="" → protobuf varint 158 for field 1 → hex 089e01
curl -s -X POST "http://185.92.223.230:26657" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "abci_query",
    "params": {
      "path": "/inference.inference.Query/EpochGroupData",
      "data": "089e01",
      "prove": true,
      "height": "2443133"
    }
  }'
```

- Response: `result.response` has `code`, `value` (base64), `height`, `proof_ops` (if the node returns proofs).
- `result.response.code === 0` and non-empty `result.response.value` = success.
- To pretty-print: `curl ... | jq .`

**EpochInfo** (no proof):

```bash
curl -s -X POST "http://185.92.223.230:26657" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"abci_query","params":{"path":"/inference.inference.Query/EpochInfo","data":""}}'
```

**Hex for other epochs:** For `epoch_index = N` and `model_id = ""`, the request is a single protobuf varint: field 1 = N. Encode as hex (e.g. N=1 → `0801`, N=158 → `089e01`, N=256 → `088001`). You can run the verifier once and copy the request bytes from the code, or use a small script to encode N to varint hex.

## Validators list and weight, proved

To get **validator list and weight (voting power)** from the block and **prove it is valid**: use **`getValidatorsWithProofContext(height)`** from `src/block.ts`. You get `validators` (each has `votingPower` = weight), `validatorsHashFromHeader`, and `block`; the commit attests to the header (hence to `validators_hash`). Full verification: see [docs/validators-with-proof.md](docs/validators-with-proof.md).

To get the **consensus validator set at a height with proof context** (the block header’s `validators_hash` that the chain commits to), use **`getValidatorsWithProofContext(height)`** from `src/block.ts`:

- Returns `{ validators, block, validatorsHashFromHeader }`.
- The “proof” is: the commit (signed by previous validators) attests to the header; the header contains `validators_hash` for this validator set.
- Full verification (optional): recompute Tendermint’s ValidatorSet hash (proto encoding + SHA256) and compare to `validatorsHashFromHeader`; see [docs/validators-with-proof.md](docs/validators-with-proof.md).

For **app-state IAVL proofs** (e.g. staking validators under `app_hash`), use `abci_query` with `prove: true` to the relevant store path; see the same doc.

**Store data with a proof, and block data signed:** For how to get **store data with an IAVL proof** (store path + key + `prove: true`) and whether you can get **all block data signed and with a proof**, see [docs/store-and-block-proofs.md](docs/store-and-block-proofs.md).

**Proven participants (added at EndBlock):** How to get **proven** participants and how the client can be sure they are validated: [docs/proven-participants.md](docs/proven-participants.md).

**Store path for EpochData:** Path `/store/inference/key` and example curl to get EpochGroupData by store key: [docs/store-path-epoch-data.md](docs/store-path-epoch-data.md). To find a key that has data and decode its value: `npx tsx scripts/find-and-decode-store-key.ts`.

## Project layout

- `src/config.ts` – RPC node list and ABCI query paths.
- `src/rpc-client.ts` – Tendermint RPC client with failover.
- `src/epoch.ts` – Latest epoch info and epoch start block height (EpochInfo, EpochGroupData).
- `src/block.ts` – Block, commit, and validators at a height.
- `src/merkle.ts` – ABCI query with `prove=true` and proof verification stub (ICS23 not fully implemented).
- `src/commit-verify.ts` – Verifies commit signatures against a validator set (Ed25519, >2/3 power).
- `src/index.ts` – Main flow: epoch → block → validators → merkle → commit verification.

## Notes

- **Vote sign bytes**: CometBFT uses canonical protobuf encoding for vote sign bytes. The current implementation uses a simplified encoding; for production you may want to use the exact CanonicalVote encoding.
- **Merkle proofs**: Full verification of Cosmos SDK store proofs (IAVL/ICS23) requires an ICS23 implementation in JS; `verifyProofAgainstRoot` is a placeholder.
- **Validator set**: This uses the **consensus** validator set from `/validators` (CometBFT), not the inference module’s “epoch group” participants. Use this when you care about chain consensus; for app-level “epoch validators” you’d query the inference module and verify with merkle proofs.
