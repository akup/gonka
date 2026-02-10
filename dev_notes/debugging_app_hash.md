# Debugging AppHash: How It Is Computed from Store and Keys on Block Commit

This note explains **how AppHash is computed** from the application store and all store keys when a block is committed, and how to debug mismatches (e.g. with the epoch-validator-verifier’s store proofs).

---

## 1. End-to-end flow (block commit → AppHash)

```
CometBFT calls ABCI Commit()
    → BaseApp.Commit()  (github.com/gonka-ai/cosmos-sdk / baseapp)
        → commitMultiStore.Commit()
            → rootmulti.Commit()  (cosmossdk.io/store)
                → commitStores(): for each persistent store (e.g. IAVL), store.Commit()
                → build CommitInfo: one StoreInfo per store (name + CommitID.Hash = IAVL root)
                → CommitInfo.Hash()  →  multistore root
        → that hash is returned as LastCommitID().Hash
    → BaseApp returns abci.ResponseCommit{Data: appHash}
    → CometBFT puts that value in the block header as app_hash
```

So **AppHash = multistore root = CommitInfo.Hash()**. It is **only** the root of the application state (multistore). It does **not** include transactions, events, or other block data.

---

## 2. What “all the keys” are: store names and IAVL roots

The multistore root is a **simple Merkle tree** over one leaf per **store** (not per key in the store):

- **Keys in the tree** = store **names** (e.g. `"inference"`, `"bank"`, `"staking"`, `"acc"`, …).
- **Values in the tree** = each store’s **root hash** (CommitID.Hash), i.e. the IAVL root (32 bytes) for that store after commit.

So “all the keys on block commit” in the sense of “what goes into AppHash” are:

1. The set of **store names** that have persistent (IAVL) stores.
2. For each such store, its **IAVL root hash** (32 bytes) after that block’s commit.

The **order** of stores in the tree is determined by the map/slice used when building `CommitInfo` (e.g. iteration order over `storeNames` or `StoreInfos`). Proofs (e.g. ics23:simple) then prove membership of one store’s root under this multistore root.

---

## 3. Where AppHash is computed (code locations)

All of this happens inside the SDK and store libraries; inference-chain does **not** override `Commit` or app hash.

| Step | Where | What to look for |
|------|--------|-------------------|
| ABCI Commit → app hash | **gonka-ai/cosmos-sdk** (replace in go.mod) | `baseapp/baseapp.go`: `Commit()`, call to `cms.Commit()`, then `LastCommitID()` or building `abci.ResponseCommit`. The bytes returned there become block header `app_hash`. |
| Multistore commit | **cosmossdk.io/store** (v1.1.2) or inside SDK | `store/rootmulti/store.go`: `Commit()` → `commitStores()`, building `CommitInfo` from each substore’s `Commit()` result. |
| Map store name → root | Same | `commitStores()` or equivalent: for each store, `name` + `CommitID{Hash: storeRoot}`. Only IAVL (and similar) stores; transient/memory skipped. |
| Multistore root from map | Same | `store/types/commit_info.go`: `CommitInfo.Hash()` — builds map `storeName -> CommitID.Hash`, then `maps.ProofsFromMap(ci.toMap())` and the returned root is the multistore hash. |
| Leaf/inner construction | Same | `store/internal/maps/maps.go`: `ProofsFromMap`, `HashFromByteSlices`; leaf = `0x00 || uvarint(len(key)) || key || uvarint(len(value)) || value` (value = SHA256(IAVL root)); inner = `0x01 || left || right`. |

Inference-chain only **reads** AppHash in tests, e.g. `app/sim_test.go`: `appHash := bApp.LastCommitID().Hash`.

---

## 4. How to debug: what to log and where

### 4.1 Log AppHash and height (SDK fork)

In **github.com/gonka-ai/cosmos-sdk**, in `baseapp/baseapp.go` inside `Commit()`:

- After `cms.Commit()` (or equivalent) and when building the commit response, log:
  - **Height**
  - **App hash** (the bytes that go into `ResponseCommit.Data`) in **hex**

Example (adapt to actual variable names in your SDK version):

```go
// After multistore commit, when you have the app hash:
appHash := app.lastCommitID.Hash // or commitID.Hash from cms.Commit()
fmt.Fprintf(os.Stderr, "[APP_HASH_DEBUG] height=%d app_hash_hex=%X\n", height, appHash)
```

### 4.2 Log the map (store name → IAVL root) and final root

In the same SDK fork, or in **cosmossdk.io/store** (if the store package is separate):

- In **store/types/commit_info.go** in `CommitInfo.Hash()` (or wherever the map for the multistore tree is built):
  - Log, for each store: **store name** and **IAVL root (32 bytes) in hex**.
  - Log the **final root** (return value of `Hash()`) in hex.

That confirms the entry for `"inference"` (and every other store) and the resulting AppHash.

### 4.3 Log leaf preimage for one store (e.g. `"inference"`)

In **store/internal/maps/maps.go** (or the file that builds leaves for the simple tree):

- When building the leaf for each store (key = store name, value = hashed IAVL root), if store name is `"inference"`, log the **leaf bytes before hashing** (the same bytes that get passed to `leafHash(0x00 || leaf)`).
- Compare this **byte-for-byte** with the epoch-validator-verifier’s `DEBUG_VERIFY=1` “leaf preimage” output.

### 4.4 Compare with epoch-validator-verifier

1. Run the verifier with `DEBUG_VERIFY=1` at a given height; note **expected app_hash**, **storeRoot** (from simple proof), **leaf preimage (hex)**, and **final calculated root**.
2. Run the node (with the SDK/store logging above) and let it commit the same height.
3. Compare:
   - Node’s **app_hash** vs verifier’s **expected app_hash** (same height).
   - Node’s **IAVL root for `"inference"`** in the CommitInfo map vs verifier’s **storeRoot**.
   - Node’s **leaf preimage for `"inference"`** vs verifier’s **leaf preimage** (must be identical bytes).
   - Node’s **CommitInfo.Hash()** vs verifier’s **final calculated root**.

If the node’s AppHash matches the block header but the verifier’s root does not, the difference is in leaf/inner encoding or proof path (see epoch-validator-verifier’s **docs/simple-proof-and-app-hash.md**). If the node’s own `CommitInfo.Hash()` differs from the block’s app_hash, the bug is in the chain (e.g. something overwriting or mixing the commit response).

---

## 5. Summary

| Question | Answer |
|----------|--------|
| **What is AppHash?** | The multistore root: `CommitInfo.Hash()` from the root store’s commit. |
| **What are “all the keys” that go into it?** | **Store names** (e.g. `inference`, `bank`, `staking`); each “value” is that store’s **IAVL root hash** (32 bytes). |
| **Where is it computed?** | In the SDK: `BaseApp.Commit()` → `commitMultiStore.Commit()` → rootmulti builds `CommitInfo` and `CommitInfo.Hash()`. |
| **Where to add logs?** | (1) baseapp: app hash and height; (2) store: map (name → IAVL root) and final root; (3) maps: leaf preimage for `"inference"` to compare with verifier. |
| **More detail on proofs and mismatch** | See **epoch-validator-verifier/docs/simple-proof-and-app-hash.md** and **docs/store-and-block-proofs.md**. |

---

## 6. Quick reference: multistore root construction

- **Leaf** for store with name `name` and IAVL root `root` (32 bytes):  
  `SHA256(0x00 || uvarint(len(name)) || name || uvarint(32) || SHA256(root))`
- **Inner node:**  
  `SHA256(0x01 || leftChild || rightChild)` (32-byte children)
- **AppHash** = root of this simple Merkle tree (over one leaf per persistent store).

This matches the ics23 **TendermintSpec** used by the epoch-validator-verifier when verifying store proofs against the block’s `app_hash`.

---

## 7. Logging AppHash and store names from inference-chain (tests)

To see **AppHash** and the list of **store names** that participate in the multistore from the app side (in tests only):

- Run: `APP_HASH_DEBUG=1 go test -v -run TestAppHashAfterCommit ./app`
- The test runs one block (InitChain, FinalizeBlock, Commit) and logs:
  - `app_hash_hex`: the multistore root (same value that would appear in the block header)
  - `store_name`: each store key name (same names that appear as keys in `CommitInfo` in the SDK)

See **inference-chain/app/app_hash_debug_test.go**. In production, AppHash is computed inside the SDK on each ABCI `Commit()`; to log it there, add logging in the **gonka-ai/cosmos-sdk** fork as in §4.
