# Store path and curl example: EpochGroupData (EpochData) by store path

How to query **inference** module state (including **EpochGroupData**) via the **store path** (raw key-value) so that the node can return **proof_ops** when `prove: true`.

---

## Store path for inference data

- **Path:** `/store/inference/key`
- **Source:** Inference module uses `StoreKey = ModuleName` → `"inference"` (`inference-chain/x/inference/types/keys.go`). Cosmos SDK baseapp routes `/store/<storeKey>/key` to the multistore; the **data** param is the raw key in **hex**.

---

## Key encoding for EpochGroupData

EpochGroupData is stored in the inference keeper as:

- **Map:** `EpochGroupDataMap` with **prefix** `EpochGroupDataPrefix` = byte `0x0A` (prefix 10).
- **Key codec:** `collections.PairKeyCodec(collections.Uint64Key, collections.StringKey)` → key = `(epoch_index, model_id)`.

So the **full store key** is:

1. **Prefix:** 1 byte `0x0A`
2. **epoch_index:** 8 bytes, **big-endian** (e.g. 158 → `00 00 00 00 00 00 00 9e`)
3. **model_id (string):** Terminal encoding = raw string bytes, **no length prefix, no trailing delimiter**. For empty `""` = 0 bytes.

**Parent EpochGroupData (participants list):** `model_id = ""` → key = `0A` + `uint64_be(epoch_index)` **only** (9 bytes). Confirmed: `data=0a000000000000009e` and `data=0a0000000000000001` return value.

**Examples (hex):**

| epoch_index | model_id | key (hex) |
|-------------|----------|------------|
| 1 | "" | `0a0000000000000001` |
| 157 | "" | `0a000000000000009d` |
| 158 | "" | `0a000000000000009e` |

*(Exact encoding may depend on your Cosmos SDK / collections version; if the node returns “key not found”, double-check the key codec in the chain.)*

---

## Example curl: EpochGroupData by store path

**Parent EpochGroupData (epoch 158, model_id empty)** at latest height, with proof requested:

```bash
# Key = 0a000000000000009e (9 bytes). Omit height for latest.
curl -s -X POST "http://RPC_URL:26657" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "abci_query",
    "params": {
      "path": "/store/inference/key",
      "data": "0a000000000000009e",
      "prove": true
    }
  }'
```

- **path:** `/store/inference/key` — inference store, raw key query.
- **data:** Key in **hex**. For epoch 158 and parent group: `0a000000000000009e` (9 bytes).
- **prove:** `true` — request Merkle proof (if the node supports it for this store).
- **height:** Block height (optional; omit for latest). If **value is null**, the key is not set at that height — try omitting height (query latest) or a height after the epoch’s EndOfPoCValidation.

**Try curl (epoch 1, parent — guaranteed to have data):**

```bash
# Key for epoch 1 parent = 0a0000000000000001 (9 bytes). Returns EpochGroupData (base64 value).
curl -s -X POST "http://185.92.223.230:26657" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "abci_query",
    "params": {
      "path": "/store/inference/key",
      "data": "0a0000000000000001",
      "prove": false
    }
  }' | jq '.result.response | {code, value: (.value != null), key, height}'
```

To decode the value: `... | jq -r '.result.response.value' | base64 -d` gives raw EpochGroupData protobuf. Use `scripts/find-and-decode-store-key.ts` to find a key and decode in one go.

**Response:**

- `result.response.code`: 0 = success.
- `result.response.value`: **base64**-encoded raw value (protobuf `EpochGroupData`). Decode with the chain’s `EpochGroupData` proto; participants are `validation_weights`. Can be **null** if the key has no value at that height (key not set → absence).
- `result.response.proof_ops`: Present if the node returns proofs for this store; verify against the block’s **app_hash** (e.g. ICS23).

---

## Decoding the response

Example response (abbreviated):

```json
{
  "result": {
    "response": {
      "code": 0,
      "key": "CgAAAAAAAACeAA==",
      "value": null,
      "proofOps": { "ops": [ ... ] },
      "height": "2427742"
    }
  }
}
```

| Field | Meaning |
|-------|--------|
| **code** | 0 = success. |
| **key** | Base64-encoded **key** that was queried. Decode: `CgAAAAAAAACe` → 9 bytes `0x0A` + epoch_index 158 (8 bytes BE) = prefix + uint64, no trailing byte for empty model_id. |
| **value** | Base64-encoded raw **EpochGroupData** protobuf, or **null** if the key has no value at that height. When null, the key is “not set” at that block; **proof_ops** can still be an absence proof. When non-null, decode as protobuf `EpochGroupData`; participants are field **validation_weights** (e.g. field 8). |
| **proof_ops** | Two ops (order may vary): **ics23:iavl** — IAVL proof for this key in the inference store; **ics23:simple** — simple tree proof that the inference store root is under **app_hash**. The verifier identifies each by type and verifies simple against app_hash, then IAVL against the store root. |
| **height** | Block height at which the query was executed. |

So in the example above, **value: null** means at height 2427742 there is **no** EpochGroupData stored for epoch 158 parent (`model_id=""`); the **proof_ops** still prove that fact against **app_hash**.

### Proof verification troubleshooting

- **Step-by-step debug:** Run with `DEBUG_VERIFY=1` (e.g. `DEBUG_VERIFY=1 node dist/index.js`) to log inputs, op types, store key/value, and each verification step. If the simple proof fails, the log shows the **calculated root** from the proof vs the block’s **app_hash**.
- **Op order:** Nodes may return `[ics23:iavl, ics23:simple]` or `[ics23:simple, ics23:iavl]`. The code picks the simple op (store root under app_hash) and the IAVL op (key/value under store root) by type, so order does not matter.
- **Root mismatch:** If the simple proof’s calculated root does not equal the block’s app_hash at the same height, verification fails. Possible causes: chain uses a different multistore/app hash structure (e.g. SDK fork), different ICS23 simple-tree spec, or a node proof-generation bug. Ensure the block height used for app_hash matches the query response height. **Note:** In Cosmos SDK, app_hash is **only** the multistore root (no transactions or events); see `docs/store-and-block-proofs.md` §4. For how app_hash is built and how to check the modified SDK (e.g. gonka-ai/cosmos-sdk), see **`docs/simple-proof-and-app-hash.md`**. For **how to debug building the root from the store** (step-by-step leaf preimage and inner hashes to compare with the chain), run with **DEBUG_VERIFY=1** and see that doc §6.

**Other epochs:** For epoch index `N`, parent key hex = `0a` + 8-byte big-endian hex of `N` (9 bytes total). Example: N=1 → `0a0000000000000001`, N=158 → `0a000000000000009e`.

---

## Summary

| Item | Value |
|------|--------|
| **Store path** | `/store/inference/key` |
| **Key (parent EpochGroupData)** | `0x0A` + uint64_be(epoch_index) (9 bytes; empty model_id = 0 bytes) |
| **Example key hex (epoch 158)** | `0a000000000000009e` |
| **data param** | Key in **hex** (Tendermint RPC) |
| **Response value** | Base64 protobuf `EpochGroupData`; decode to get `validation_weights` (participants) |
