# How to get **proven** participants (and how the client can be sure they are validated)

Participants are added in **EndBlock** (SetNewValidators stage), not in a transaction. This doc explains: (1) how to get participants with a **cryptographic proof** that they are the committed state, and (2) how the client can be sure they are **validated**.

---

## What “proven” and “validated” mean here

- **Proven (cryptographically):** The client receives the participant list **plus an IAVL Merkle proof** that this value is under the block’s **app_hash**. So the client can verify: “this exact value is what the chain committed to at this height.”
- **Validated (chain-side):** The chain only adds participants that passed its checks (PoC, store commits, validations, etc.). So by the time a participant list is in state, it has been **validated by the chain’s EndBlock logic**.
- **Validated (client-side):** The client can be sure in two ways: (1) **IAVL proof** — proves this value is in committed state; (2) **block commit** — proves the block (hence **app_hash**) was agreed by >2/3 of validators. So “validated” for the client means: the block was signed, and (if you have a proof) this value is under that block’s app_hash.

---

## How to get **proven** participants

You have two levels of assurance.

### Option 1: Full proof (IAVL proof vs app_hash) — strongest

If the **node** returns **proof_ops** for the inference store:

1. **Query by store path (raw key-value), not by gRPC path.**
   - **Path:** `/store/inference/key` (inference module store key is `inference`; see `inference-chain/x/inference/types/keys.go` — `StoreKey = ModuleName`).
   - **Data:** The **store key** for the parent EpochGroupData, in **hex**.  
     Key = prefix `0x0A` + 8 bytes big-endian `epoch_index` + 1 byte length `0x00` for empty `model_id`. Example: epoch 158 → `0a000000000000009e00`. See [store-path-epoch-data.md](store-path-epoch-data.md) for the full key encoding and example curl.
   - **Params:** `prove: true`, `height: H` (the block **after** EndBlock has run for that epoch, so participants are already in state).

2. **Get the block at height H** and read **app_hash** from the header.

3. **Verify proof_ops against app_hash** (e.g. with ICS23 / `verifyProofAgainstRoot` in `src/merkle.ts`). Decode the response **value** as `EpochGroupData` (protobuf); **participants** are `validation_weights`.

4. **Optional:** Verify the **block commit** (signed by >2/3 of previous validators) so you know the block — and thus **app_hash** — was agreed by the chain.

**Result:** You have the participant list **and** a proof that this exact value is in the committed state at height H. The client is sure they are “validated” in the sense: (a) the chain only wrote participants that passed its checks, and (b) the client has cryptographically verified that this value is under the attested app_hash.

**Caveat:** Many nodes **do not** return proof_ops for the inference store (or for gRPC-style paths). If your node returns empty proof_ops for this query, you cannot get Option 1 without changing node/chain config to enable proofs for this store.

---

### Option 2: Block-level attestation only (no IAVL proof) — weaker but often enough

If the node **does not** return proof_ops for EpochGroupData:

1. **Get the block at height H** (after EndBlock for that epoch). The **commit** is signed by >2/3 of the previous validators and attests to the **header**, including **app_hash**. So you have: “the chain agreed on this block and this app_hash.”

2. **Get participants at height H** via **REST** with **`x-cosmos-block-height: H`**:  
   `GET /productscience/inference/inference/epoch_group_data/{epoch_index}`  
   Decode **validation_weights** as the participant list.

3. You **do not** have an IAVL proof that this EpochGroupData value is under app_hash. You have: “block H was committed (signed), and the REST API returned this participant list for height H.” So you are **trusting the node’s REST response** for the value, but you **do** know that the block (and hence app_hash) was validated by the chain.

**Result:** You have participants and the guarantee that the **block** was validated (signed). You do **not** have a proof that this exact participant list is under app_hash. For many use cases this is acceptable: the chain only adds validated participants in EndBlock, and the block itself is attested.

---

## How the client can be sure they are “validated”

- **Chain-side:** Participants are added in **EndBlock** by `addEpochMembers` only for **active participants** that passed the chain’s checks (store commits, validations, PoC, etc.). So once a participant is in **EpochGroupData.ValidationWeights**, the chain has already “validated” them.

- **Client-side:**
  - **With IAVL proof (Option 1):** You verify the proof against **app_hash**. So you are sure: (1) this value is in the committed state, and (2) the block (commit) was signed by validators → app_hash is attested → this value is what the chain committed to.
  - **Without IAVL proof (Option 2):** You are sure the **block** was validated (commit signed). You are **not** cryptographically sure that the exact participant list you received is under app_hash; you rely on the node returning the correct state for height H. So “validated” here means “block was validated; participants are whatever the node says for that height.”

---

## Summary

| Goal | Method | What the client can be sure of |
|------|--------|---------------------------------|
| **Proven participants** (strongest) | Store-path `abci_query` with `prove: true` for EpochGroupData key → verify proof_ops vs **app_hash** | This exact participant list is in committed state; block attested by validators. |
| **Validated block + participants** (no IAVL proof) | Block at H (commit signed) + REST EpochGroupData at height H | Block was validated; participants are what the node returned for H (trust node for value). |
| **Why participants are “validated”** | EndBlock only adds active participants that passed chain checks | By the time they are in state, the chain has already validated them. |

**Practical takeaway:** To get **proven** participants you need the node to return **proof_ops** for the inference store (store path `/store/inference/key` and the EpochGroupData key). If the node does not return proofs, use **REST at height H + block at H** to get participants and block-level assurance that the block (and app_hash) was validated; the client then trusts the node for the exact value. In both cases, the chain has already validated who gets added as participants in EndBlock.
