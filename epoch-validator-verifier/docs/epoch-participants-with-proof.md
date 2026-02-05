# Getting new participants of an epoch with a proof

## Why doesn’t EpochData include participants and a proof?

### Participants

- **ABCI query** (`abci_query` for `QueryGetEpochGroupData`): On your chain, the **parent** EpochGroupData (e.g. `model_id = ""`) can return **without** `validation_weights` in the response (see [inference-chain-validators.md](inference-chain-validators.md)). So “EpochData” from ABCI may look like it doesn’t include participants.
- **REST (gRPC-gateway)** GET to `/productscience/inference/inference/epoch_group_data/{epoch_index}` **does** return the full EpochGroupData, including `validation_weights` (participants), when you send the `x-cosmos-block-height` header. So you *can* get participants; the gap is only when using ABCI and/or parent group.

So: **participants** are in EpochGroupData in state; whether your client sees them depends on **how** you query (REST vs ABCI) and **which** EpochGroupData (parent vs per-model).

### Proof

- **ABCI query with `prove: true`**: For this inference query path, the node returns **no `proof_ops`** (or empty). So you get the value (when present) but **no Merkle proof**. That’s a **node/module configuration** choice: the inference store (or this query) is not set up to generate IAVL proofs.
- **REST**: REST is just HTTP JSON from the gRPC-gateway; it does **not** return any Merkle proof. You get the data, not a proof.

So: **EpochData doesn’t “include” a proof** because (1) ABCI for this path doesn’t return proof_ops, and (2) REST doesn’t provide proofs at all.

---

## Is there a “tx that added participants” I can get with a Merkle proof?

**No.** New participants are **not** added by a user-signed transaction. They are added in **EndBlock** (block lifecycle):

1. At **SetNewValidators** stage height, the inference module runs **`onSetNewValidatorsStage`** from **`EndBlock`**.
2. That calls **`addEpochMembers`**, which calls **`upcomingEg.AddMember(ctx, member)`** for each active participant.
3. **`AddMember`** / **`updateEpochGroupWithNewMember`** update **EpochGroupData** (including **validation_weights**) and call **`SetEpochGroupData`** in the keeper.

So the **participants list is written in app state during EndBlock**, not in a transaction. There is **no “tx that added participants”** to fetch and prove with a tx Merkle proof. The only thing you could prove with a **tx proof** would be that some *other* tx is in the block, not the participant list.

**Code:** `inference-chain/x/inference/module/module.go` — `EndBlock` → `StartStage` → `onSetNewValidatorsStage` → `addEpochMembers`; `epochgroup/epoch_group.go` — `AddMember` → `updateEpochGroupWithNewMember` → `SetEpochGroupData`.

---

## What can you do to get “new participants with a proof”?

### 1. Use REST for participants + block commit as attestation (no IAVL proof)

- **GET** EpochGroupData (with `x-cosmos-block-height: H`) from the REST API to get **participants** (`validation_weights`).
- **Get block at H** (and commit). The **commit** is signed by the previous validators and attests to the **header**, including **app_hash**.
- You then have: “At height H, the chain committed to app_hash; the REST response says EpochGroupData at H has these participants.” You do **not** have an IAVL proof that this EpochGroupData value is under app_hash; you’re trusting the REST response and the fact that the block was committed.

This gives you **participants** and **block-level attestation**, but **no Merkle proof of the EpochGroupData value**.

### 2. Enable IAVL proofs for the inference store (chain/node change)

- If the node is configured to **generate proofs** for the inference module store (and for the EpochGroupData key), then **`abci_query`** with **`prove: true`** and the right path/key would return **proof_ops**.
- You would then **verify** that proof against the block’s **app_hash** (e.g. with ICS23). That gives you **participants + Merkle proof** that the returned value is in the committed state.

This requires **chain/node configuration** (e.g. enabling proof generation for that store or query). Many nodes disable proofs for performance or only enable them for certain stores.

### 3. Query by store key (if proofs are enabled)

- EpochGroupData is stored under the inference store with key encoding **`(epoch_index, model_id)`** (see [inference-chain-validators.md](inference-chain-validators.md)).
- If the node supports **ABCI query by store key** with **`prove: true`** for that store, you could query that key and get **proof_ops** for the raw value, then decode to EpochGroupData (including participants) and verify the proof against **app_hash**.

Again, this only works if the node actually returns proof_ops for that store/key.

---

## Summary

| Question | Answer |
|----------|--------|
| Why doesn’t EpochData include participants? | ABCI parent EpochGroupData on your chain may omit `validation_weights`; REST with `x-cosmos-block-height` does include them. |
| Why doesn’t it include a proof? | ABCI for this path returns no proof_ops; REST doesn’t provide proofs. |
| Can I get the tx that added participants with a Merkle proof? | No. Participants are added in **EndBlock**, not in a transaction; there is no such tx. |
| How to get new participants with a proof? | (1) REST + block commit = participants + attestation, no IAVL proof. (2) Enable IAVL proofs for inference store and use abci_query with prove=true for EpochGroupData (or store key) and verify against app_hash. |

**How to get proven participants and how the client can be sure they are validated:** See [proven-participants.md](proven-participants.md).
