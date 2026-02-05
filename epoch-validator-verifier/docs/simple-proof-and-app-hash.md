# Simple proof (ics23:simple) and app_hash

This doc explains how **app_hash** is produced in the inference-chain and how the **ics23:simple** multistore proof is built, so you can debug why `verifyMembership(..., tendermintSpec, expectedRoot, ...)` might fail.

---

## 1. How app_hash is obtained in inference-chain

- **Source:** The inference-chain app uses **Cosmos SDK BaseApp** (from `github.com/gonka-ai/cosmos-sdk` via `go.mod` replace). It does **not** override `Commit` or app hash.
- **Value:** `app_hash` in the block header is set by Tendermint/CometBFT from the application’s **commit response**. The application returns it from **BaseApp.Commit()**, which returns **multistore.LastCommitID().Hash**.
- **In code:** In `inference-chain/app/sim_test.go`, `appHash := bApp.LastCommitID().Hash` is used. So **app_hash = multistore root** (the hash returned when the root store commits).
- **Conclusion:** app_hash is **only** the root of the **multistore** (application state). It does **not** include transactions, events, or other block data.

---

## 2. How the multistore root is built (cosmossdk.io/store v1)

The inference-chain uses **cosmossdk.io/store v1.1.2**. The multistore is implemented in the **same repo** (cosmos-sdk, store/v1.1.2). Flow:

1. **Commit()** (e.g. in `store/rootmulti/store.go`):  
   `commitStores()` builds a **CommitInfo** with one **StoreInfo** per substore (name + CommitID with hash). Only IAVL (and similar) stores are included; transient/memory are skipped. **CommitInfo.Hash()** is the multistore root.

2. **CommitInfo.Hash()** (`store/types/commit_info.go`):  
   Builds a map `storeName -> storeInfo.GetHash()` (i.e. store name → **CommitID.Hash**, the IAVL root bytes). Then calls **maps.ProofsFromMap(ci.toMap())** and uses the returned root as the multistore hash.

3. **maps.ProofsFromMap** (`store/internal/maps/maps.go`):  
   - For each store: key = store **name** (e.g. `"inference"`), value = **raw** IAVL root (CommitID.Hash, 32 bytes).  
   - When building the tree, the **value** stored in the leaf is **tmhash.Sum(value)** = SHA256(IAVL root). So leaf value in the tree is 32 bytes (hash of the store root).  
   - Leaf bytes (before hashing): **KVPair.Bytes()** = `uvarint(len(key)) || key || uvarint(len(value)) || value` (value = SHA256(store root)).  
   - Root is computed via **tree.HashFromByteSlices(kvsBytes)** which uses **CometBFT merkle.ProofsFromByteSlices**.

4. **CometBFT merkle** (`cometbft/crypto/merkle/`):  
   - **leafHash(leaf)** = **tmhash.Sum(0x00 || leaf)** (see `hash.go`: `leafPrefix = []byte{0}`).  
   - So multistore leaf = **SHA256(0x00 || uvarint(len(name)) || name || uvarint(32) || SHA256(iavl_root))**.
   - Inner nodes: **innerHash(left, right)** = **tmhash.Sum(0x01 || left || right)**.

So the **standard** multistore root is a simple Merkle tree over leaves built from store name + hashed store root, with **0x00** leaf prefix and **0x01** inner prefix, and **uvarint** length encoding.

---

## 3. How the simple proof is generated and verified

- **Generation:** On a store-path query with `prove: true`, the rootmulti **Query** handler gets the IAVL proof from the substore, then appends **commitInfo.ProofOp(storeName)**.  
  **ProofOpFromMap** (`store/types/proof.go`) uses **maps.ProofsFromMap** to get the CometBFT proof for that store name, then **sdkproofs.ConvertExistenceProof** to turn it into an **ICS23 ExistenceProof** with:
  - **key** = store name (e.g. `"inference"`)
  - **value** = **raw** IAVL root (CommitID.Hash, 32 bytes)  
  The proof op type is **"ics23:simple"** and the spec used in SDK is **ics23.TendermintSpec** (from **github.com/cosmos/ics23/go**).

- **Verification (this repo):** We use **@confio/ics23** `tendermintSpec` and **verifyMembership(simpleProof, tendermintSpec, expectedRoot, storeKey, storeRoot)**.  
  **tendermintSpec** is:
  - **leafSpec:** prefix `[0]`, hash SHA256, prehashValue SHA256, prehashKey NO_HASH, length VAR_PROTO.
  - **innerSpec:** childOrder [0,1], minPrefixLength 1, maxPrefixLength 1, childSize **32**, hash SHA256.

  So the verifier builds the leaf as: **SHA256(0x00 || uvarint(len(key)) || key || uvarint(len(value)) || SHA256(value))**. With key = store name and value = 32-byte IAVL root, this matches the chain’s leaf construction. So **if the chain uses the same construction**, the calculated root from the simple proof should equal **app_hash**.

---

## 4. Why verification might fail (root mismatch)

If **calculated root from simple proof ≠ app_hash** at the same height:

1. **SDK fork (gonka-ai/cosmos-sdk)**  
   The inference-chain replaces `github.com/cosmos/cosmos-sdk` with **github.com/gonka-ai/cosmos-sdk v0.53.3-ps15**. If the fork changed any of the following, the multistore root or proof encoding may differ:
   - **store/internal/maps** (leaf encoding, use of tmhash, KVPair.Bytes)
   - **store/types/commit_info.go** (what goes into the map, Hash())
   - **store/types/proof.go** (ProofOpFromMap, ConvertExistenceProof)
   - **store/rootmulti** (which stores are included, CommitInfo build)
   - Dependency on **cosmossdk.io/store** or **github.com/cosmos/ics23/go** (e.g. different TendermintSpec or conversion).

2. **Different ICS23 simple-tree spec**  
   If the chain’s **ics23.TendermintSpec** (or equivalent) differs from **@confio/ics23**’s `tendermintSpec` (e.g. leaf prefix, inner child size, length encoding), the verifier will compute a different root.

3. **Height mismatch**  
   The block used for **app_hash** must be the **same height** as the query response; otherwise the roots are for different states.

4. **Node bug**  
   Proof generation on the node could be wrong (e.g. wrong store name, wrong value, or wrong conversion to ICS23).

---

## 5. What to check in the modified SDK

To see why the simple op does not verify against app_hash:

1. **Confirm app_hash source**  
   In the app, ensure **BaseApp.Commit()** returns **multistore.Commit()** and that **LastCommitID().Hash** is what ends up in the block header (no extra hashing or mixing with txs/events).

2. **Inspect multistore root construction**  
   In the SDK (or fork) used by the chain:
   - **store/types/commit_info.go** – `CommitInfo.Hash()` and what goes into the map.
   - **store/internal/maps/maps.go** – how leaves are built (KVPair.Bytes, tmhash.Sum), and that **tree** / **merkle** use **0x00** leaf prefix (CometBFT `leafHash(leaf) = tmhash.Sum(0x00 || leaf)`).

3. **Inspect simple proof encoding**  
   - **store/types/proof.go** – **ProofOpFromMap** and that the existence proof uses **store name** as key and **raw CommitID.Hash** (IAVL root) as value.
   - **store/internal/proofs** (if present) – **ConvertExistenceProof** from CometBFT proof to ICS23; it must match the same leaf encoding as the multistore (0x00 prefix, uvarint lengths, value = SHA256(store root) in the leaf).

4. **Compare with ics23-go TendermintSpec**  
   In **github.com/cosmos/ics23/go**, check **TendermintSpec** (leaf prefix, inner spec, length op). The **@confio/ics23** `tendermintSpec` in this repo should match that so that the calculated root from the simple proof equals **CommitInfo.Hash()**.

If the fork uses a different leaf or inner encoding, you would need either to change the chain to match the standard spec or to use a **custom spec** in the verifier that matches the fork (e.g. via an env-driven or config-driven spec in `src/merkle.ts`).

---

## 6. How to debug root mismatch (building the root from the store)

When **calculated root ≠ app_hash**, you need to see exactly how the verifier builds the root and compare that with how the chain builds **CommitInfo.Hash()**.

### 6.1 Run the verifier with step-by-step debug

1. Set **DEBUG_VERIFY=1** and run the verifier (e.g. `DEBUG_VERIFY=1 npx ts-node src/index.ts`).
2. When the simple op fails, the log will show:
   - **calculated root from simple proof** (hex) and **expected app_hash** (hex).
   - **Step-by-step root build**:
     - **Leaf preimage** (hex): the exact bytes hashed for the multistore leaf:  
       `0x00 || varint(len(storeName)) || storeName || varint(32) || SHA256(iavlRoot)`.
     - **Leaf hash** (hex): SHA256(leaf preimage).
     - For each **inner** step: prefix length, suffix length, child hash, and result hash (SHA256(prefix || child || suffix)).
     - **Final calculated root** (hex).

3. Compare these values with the chain:
   - **Leaf preimage**: In the SDK’s `store/internal/maps` (or equivalent), the leaf for store `"inference"` should be built as the same bytes (0x00, then protobuf-style varint of key length, key, varint of value length, value = SHA256(IAVL root)). If the chain uses different byte order, different varint encoding, or a different leaf prefix, the leaf hash will differ.
   - **Inner steps**: Each step should be SHA256(0x01 || leftChild || rightChild) with 32-byte children. If the chain uses a different inner prefix or different child size, the root will differ.
   - **Final root**: Must equal **CommitInfo.Hash()** at the same height.

### 6.2 Compare with the chain (gonka-ai/cosmos-sdk)

In the SDK fork used by the inference-chain:

1. **Log the multistore root at commit**  
   In `store/rootmulti` or wherever `Commit()` is called, log the map passed to `CommitInfo.Hash()`: for each store name, the 32-byte IAVL root. Ensure the entry for `"inference"` matches the **storeRoot** (value) from the simple proof.

2. **Log the leaf bytes for the inference store**  
   In `store/internal/maps` (or the code that builds leaves for the simple tree), for the key `"inference"` and value = raw IAVL root (32 bytes), log the leaf bytes **before** hashing (the same as “leaf preimage” in the verifier). They must be identical byte-for-byte to the verifier’s **leaf preimage** (including varint encoding).

3. **Log the root returned by ProofsFromMap / HashFromByteSlices**  
   Confirm it equals the **app_hash** in the block header at that height. If the chain’s root matches the header but the verifier’s calculated root does not, the difference is in leaf encoding, inner node encoding, or the proof path (e.g. different tree order).

### 6.3 Quick checklist

| What to compare | Verifier (DEBUG_VERIFY=1) | Chain (SDK fork) |
|-----------------|---------------------------|------------------|
| Store name → IAVL root | simple op key (store name), value (store root) | Map passed to CommitInfo.Hash() |
| Leaf preimage | `[debug root build] leaf preimage` | Leaf bytes before tmhash.Sum in maps / KVPair.Bytes |
| Leaf hash | `[debug root build] leaf hash` | SHA256(0x00 \|\| leaf preimage) |
| Inner nodes | prefix 0x01, childSize 32, SHA256(prefix \|\| left \|\| right) | CometBFT merkle innerHash |
| Final root | `[debug root build] final calculated root` | CommitInfo.Hash() = app_hash |

If the leaf preimage or any inner step differs, adjust either the chain’s store/proof code or the verifier’s spec (e.g. custom spec in `src/merkle.ts`) until they match.

---

## 7. How to add debugging in inference-chain (and the SDK) to see app hash and compare proofs

App hash is computed **inside the SDK** when the multistore commits; inference-chain does not override `Commit()`. So you add logging in two places: (1) **inference-chain** to log the app_hash when you have access to it, (2) **the SDK fork (gonka-ai/cosmos-sdk)** and optionally **cosmossdk.io/store** to log how the root is built. No changes are required in the epoch-validator-verifier code.

### 7.1 Logging app_hash from inference-chain (optional)

The app does not receive the ABCI `Commit` response directly; `BaseApp.Commit()` runs inside the SDK. To log app_hash from the **app** side you can:

- **Option A – baseAppOption that wraps CommitMultiStore**  
  In `app/app.go`, in `New()`, add a `baseAppOption` that runs after the app is built and, if the SDK exposes a way to get the commit multi-store from the built app, wrap it in a type that implements the same interface and logs in `Commit()` (e.g. log `commitID.Hash` and delegate to the real store). Whether this is possible depends on whether the runtime/app builder exposes the store.

- **Option B – log in the SDK (recommended)**  
  Skip app-level logging and add all logging in the SDK fork (see below). Then run the node and compare logs with the verifier’s `DEBUG_VERIFY=1` output.

### 7.2 Logging in the SDK fork (gonka-ai/cosmos-sdk)

Clone or open the repo that `go.mod` replaces: `github.com/gonka-ai/cosmos-sdk v0.53.3-ps15`. Add the following.

**1. Log app_hash and commit response (BaseApp.Commit)**

- **File:** `baseapp/baseapp.go` (or wherever `Commit()` is implemented).
- **Place:** Inside `Commit()`, right after the multistore is committed and the app hash is obtained (e.g. when building `abci.ResponseCommit` or when calling `LastCommitID()`).
- **Log:**
  - The returned **app hash** (e.g. `lastCommitInfo.Hash` or `commitID.Hash`) in **hex**.
  - Optionally the **height** so you can match it to the verifier’s query height.

Example (adapt to actual variable names in that version):

```go
// After cms.Commit() or equivalent, when you have the app hash:
appHash := app.lastCommitID.Hash // or whatever the field is
fmt.Fprintf(os.Stderr, "[APP_HASH_DEBUG] height=%d app_hash_hex=%X\n", height, appHash)
```

**2. Log the map passed to CommitInfo.Hash() (store name → IAVL root)**

The multistore root is `CommitInfo.Hash()`. To see what goes into it:

- **File:** Either in the same SDK repo under `store/` (if the fork embeds cosmossdk.io/store) or in the **cosmossdk.io/store** module (see §7.3).
- **Look for:** `CommitInfo.Hash()` (e.g. in `store/types/commit_info.go`).
- **Place:** At the start of `Hash()`, or where the map `storeName -> CommitID.Hash` is built (e.g. from `ci.StoreInfos` or `toMap()`).
- **Log:**
  - For each store name: **name** and **IAVL root (32 bytes) in hex**.
  - Then log the **final root** (return value of `Hash()`) in hex.

That way you can confirm the entry for `"inference"` matches the **storeRoot** (value) from the simple proof in the verifier.

**3. Log leaf preimage for the "inference" store (optional but very useful)**

To compare byte-for-byte with the verifier’s **leaf preimage**:

- **File:** Where the simple Merkle tree is built from the store map—usually **`store/internal/maps/maps.go`** (or equivalent in cosmossdk.io/store). Look for `ProofsFromMap`, `HashFromMap`, or code that builds `KVPair` / leaf bytes.
- **Place:** When building the leaf for each store (key = store name, value = hashed IAVL root), add a condition: if store name is `"inference"`, log the **leaf bytes before hashing** (the same bytes that get passed to `leafHash(0x00 || leaf)`).
- **Log:** For the inference store only: `leaf_preimage_hex=%X` (full bytes). This must match the verifier’s `[debug root build] leaf preimage` (hex).

### 7.3 If the store lives in cosmossdk.io/store (separate module)

Inference-chain uses **cosmossdk.io/store v1.1.2**. If that’s a separate repo (not vendored into gonka-ai/cosmos-sdk), add the same logging there:

- **CommitInfo.Hash()** – in `store/types/commit_info.go`: log the map (store name → IAVL root hex) and the final root hex.
- **Leaf bytes for "inference"** – in `store/internal/maps/maps.go` (or the file that builds leaves for the simple tree): when building the leaf for `"inference"`, log the leaf preimage hex.

Paths may differ slightly (e.g. `store/v2` vs `store/v1`); search for `ProofsFromMap`, `CommitInfo`, and `Hash()`.

### 7.4 Comparing with the verifier

1. Run the **verifier** with `DEBUG_VERIFY=1` at a given height; note **expected app_hash**, **storeRoot (from simple proof)**, **leaf preimage (hex)**, and **final calculated root**.
2. Run the **node** (inference-chain with the SDK logging above) and let it commit the same height (or trigger a query with proof at that height so the node has committed it).
3. Compare:
   - **app_hash** in the node log vs **expected app_hash** in the verifier (should match if same height).
   - **IAVL root for "inference"** in the node’s CommitInfo map vs **storeRoot** in the verifier (should match).
   - **Leaf preimage for "inference"** in the node log vs **leaf preimage** in the verifier (must be identical bytes).
   - **Final root** from the node’s `CommitInfo.Hash()` vs **final calculated root** in the verifier.

If the node’s app_hash matches the block header but the verifier’s calculated root does not, the difference is in how the leaf or inner nodes are encoded (see §6). If the node’s own **CommitInfo.Hash()** already differs from the block’s app_hash, the bug is in the chain (e.g. something else overwriting or mixing the commit response).

---

## 8. Summary

| Item | Source |
|------|--------|
| **app_hash** | Multistore root only; from BaseApp.LastCommitID().Hash = CommitInfo.Hash(). |
| **Multistore root** | Simple Merkle tree over leaves: SHA256(0x00 \|\| uvarint(len(name)) \|\| name \|\| uvarint(32) \|\| SHA256(iavl_root)); inner nodes 0x01 \|\| left \|\| right. |
| **Simple proof** | ICS23 existence proof: key = store name, value = raw IAVL root (32 bytes); spec = TendermintSpec. |
| **Verifier** | @confio/ics23 tendermintSpec; verifyMembership(..., expectedRoot = app_hash). |
| **If mismatch** | Run with DEBUG_VERIFY=1 (see §6), compare leaf preimage and inner steps with chain; check gonka-ai/cosmos-sdk fork (store maps, CommitInfo, ProofOpFromMap, ics23 conversion and spec). |
| **Debugging in chain** | Add logging in gonka-ai/cosmos-sdk (BaseApp.Commit, CommitInfo.Hash, store map) and optionally cosmossdk.io/store (CommitInfo.Hash, maps leaf for "inference"); see §7. |
