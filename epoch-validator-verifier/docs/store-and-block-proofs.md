# Getting store data with a proof, and block data signed

Answers to: (1) How do I get **store data with a proof**? (2) Can I get **all block data signed and with a proof**?

---

## 1. Way to get store data with a proof

### Option A: ABCI query by **store path** (raw key-value, with IAVL proof)

**Mechanism:**

- Use **`abci_query`** with:
  - **path**: Store path. In Cosmos SDK this is typically **`/store/<store_key>/key`** (e.g. `/store/inference/key` for the inference module store). The exact path and store names are app-specific; check the chain’s baseapp/store configuration.
  - **data**: The **key** you want to query, in **hex** (Tendermint RPC expects hex).
  - **prove**: **`true`**.
  - **height**: Block height (optional; omit for latest).

- The **application** (Cosmos SDK baseapp) must handle this path by delegating to the **multistore** and requesting a proof from the IAVL store. Not all paths do this: **gRPC query handlers** (e.g. EpochGroupData) only return values and do **not** return proofs.

- The response can include **`proof_ops`** (IAVL/ICS23 proof). Verify it against the block’s **`app_hash`** at that height using ICS23 (e.g. `verifyProofAgainstRoot` in `src/merkle.ts`).

**Requirements:**

- The **node** must have **proof generation enabled** for that store. Many public nodes disable proofs or enable them only for certain stores (e.g. bank, staking).
- You must know the **store key name** and the **key encoding** (e.g. how EpochGroupData is keyed: `collections.Join(epochIndex, modelId)` in the inference module).

**Summary:** Store data **with a proof** = `abci_query` with **store path** (not gRPC path) + **key** (hex) + **prove: true**, then verify **proof_ops** against **app_hash**. This only works if the node returns proof_ops for that path/store.

---

### Option B: gRPC-style ABCI query (e.g. EpochGroupData)

- If you use a **gRPC query path** (e.g. `/productscience.inference.inference.Query/EpochGroupData` or similar), the handler is a **keeper gRPC query** that only returns the value. It **does not** ask the store for a proof, so the response has **no proof_ops**.
- So: **no proof** for store data when using gRPC query paths; use **store path + key** (Option A) if you need a proof, and only when the node supports it.

---

### Option C: REST (gRPC-gateway)

- REST returns **JSON** from the same gRPC handlers. It does **not** return any Merkle proof. So you get **store data** (e.g. EpochGroupData with participants) but **no proof**.

---

## 2. Is it possible to get “all block data” signed and with a proof?

This can mean two different things.

### 2a. Block itself: signed (yes)

- **Block** = header + transactions + commit (and possibly last_commit).
- The **commit** is signed by >2/3 of the previous block’s validators. So the **block is attested** by the chain: the commit attests to the **header** (including `app_hash`, `data_hash`, `validators_hash`, etc.).
- You get this via Tendermint RPC: **`/block?height=H`** (or JSON-RPC `block`). You get the full block and the commit; that is “all block data **signed**” (the commit is the attestation).
- So: **Yes** — you can get the entire block (header + txs + commit) with the commit as the **signature/attestation**. No extra “proof” call; the commit *is* the attestation.

---

### 2b. All application state with a proof (no single “proof of everything”)

- **“All block data with a proof”** in the sense of “every byte of app state proven” would mean: for every key in the app store(s), a Merkle proof that that key/value is under the **app_hash**.
- There is **no single RPC** that returns “all state + one giant proof.” Instead:
  - The **block header** commits to **app_hash** (root of the app state tree).
  - To **prove** a specific piece of state, you query that key with **`abci_query`** and **`prove: true`** (store path + key, as in §1) and verify **proof_ops** against **app_hash**.
- So you can have:
  - **Block (signed)** = header + txs + commit (commit attests to header, hence to app_hash).
  - **Per-key store proofs** = for each key you care about, one `abci_query(..., prove: true)` and verify against **app_hash**.

**Summary:** You **cannot** get “all block data” in one response with one proof. You **can** get (1) the **full block signed** (commit attests to header/app_hash), and (2) **store data with a proof** per key, verified against that same **app_hash**, when the node supports proof generation for that store.

---

## 3. Practical summary

| Goal | Method | Signed / proof |
|------|--------|-----------------|
| **Store value with IAVL proof** | `abci_query` with **store path** (e.g. `/store/<store>/key`), **key** (hex), **prove: true** | proof_ops; verify against **app_hash** (node must return proofs). |
| **Store value, no proof** | gRPC query (ABCI gRPC path or REST) | No proof. |
| **Block signed (attestation)** | `/block?height=H` | Commit signed by validators; attests to header (and thus app_hash). |
| **“All block data” signed** | Same: get block at H | Yes — full block + commit. |
| **“All” state with proofs** | No single API | Per-key store proofs + verify vs app_hash; block gives you app_hash and attestation. |

For **store data with a proof**: use **store-path ABCI query** + **prove: true** and verify **proof_ops** against **app_hash** (see `src/merkle.ts`). For **block data signed**: use **block RPC**; the commit is the attestation.

---

## 4. How app_hash is built (multistore only; no txs, no events)

**Cosmos SDK (and inference-chain):**

- **app_hash** in the block header is **only** the root of the **multistore** (application state). It does **not** include transactions, events, or any other block data.
- The multistore is a **simple Merkle tree** of substores: for each substore (e.g. `inference`, `bank`, `staking`), the tree uses the store **name**, **height**, and **store root hash** (IAVL root) to build leaf nodes, then hashes up to a single root. That root is the **app_hash**.
- **Commit flow:** At end of block, BaseApp calls `Commit()` on the multistore; each IAVL store commits and returns its root hash; the multistore builds the simple tree from those roots and returns `CommitID{Hash: root}`. That hash is what becomes **app_hash** in the block header.
- **Inference-chain:** Uses standard Cosmos SDK BaseApp. It does **not** override `Commit` or app hash. The sim test uses `bApp.LastCommitID().Hash` — i.e. the multistore commit hash. So **app_hash = multistore root only**; transactions and events are in the block body and block results, not in app_hash.

**If store proof root ≠ app_hash:** The store-path proof (ics23:simple) proves “key `inference` → IAVL root” under some root. That root **should** equal the block’s app_hash if the chain builds app_hash exactly as the standard multistore (simple tree of store name + height + store root). A mismatch usually means: (1) the chain uses an **SDK fork** (e.g. gonka-ai/cosmos-sdk) with a different multistore or simple-tree layout/spec, or (2) a different **ICS23 simple-tree spec** (e.g. leaf encoding), or (3) proof generated at a different height. It does **not** mean “app_hash includes transactions/events” — in Cosmos SDK, app_hash is purely the multistore root.
