# Getting the Validators List with Proof

How to get **validator list and weight (voting power)** from the chain and **prove it is valid**.

---

## Quick answer: validator list + weight, proved

1. **Get the data and proof material**  
   Use **`getValidatorsWithProofContext(height)`** from `src/block.ts`:
   - **`validators`** – list of consensus validators; each has `pubkey`, **`votingPower`** (weight), and `address`.
   - **`validatorsHashFromHeader`** – the hash of this validator set as committed in the block header (the chain's commitment).
   - **`block`** – the block at that height; its **commit** is signed by the previous validators and attests to this header (hence to `validators_hash`).

2. **Why this is proved**  
   - The **commit** at height `H` is signed by >2/3 of the validators at `H-1`.  
   - That commit attests to the **header** at `H`, which contains `validators_hash`.  
   - So the chain has committed to the validator set hash; you have the **list + weight** from `/validators` and the **committed hash** from the block; together that's the proof context.

3. **Optional full verification**  
   To cryptographically prove that your list matches the header: compute Tendermint's ValidatorSet hash (proto encoding + SHA256) and check it equals `validatorsHashFromHeader`. This repo does not implement that hash; see section 1 below and [Tendermint types](https://github.com/tendermint/tendermint/blob/main/proto/tendermint/types/validator.proto).

**Example (TypeScript):**

```ts
import { getValidatorsWithProofContext } from "./block.js";

const height = 2459069;
const { validators, validatorsHashFromHeader, block } = await getValidatorsWithProofContext(height);

// Validator list and weight (voting power)
for (const v of validators) {
  console.log("address:", v.address, "voting_power (weight):", v.votingPower.toString());
}

// Proof: header (with validators_hash) is attested by the commit
console.log("validators_hash from block header (hex):", validatorsHashFromHeader && Buffer.from(validatorsHashFromHeader).toString("hex"));
// Commit is in block.commit; verify it's signed by previous validators to fully trust the header.
```

---

## 1. Tendermint consensus proof (validators + header hash)

**What you get:** The validator list at height `H` plus the block header's `validators_hash` at that height. The chain commits to this hash in the block; the commit (signed by the previous validators) attests to the header.

**How:**

- Use **`getValidatorsWithProofContext(height)`** from `./block.js`:
  - Returns `{ validators, block, validatorsHashFromHeader }`.
  - `validators` = list from Tendermint RPC `/validators?height=H`.
  - `validatorsHashFromHeader` = `header.validators_hash` from the block at `H` (the hash the chain commits to for this validator set).

**Verification:**

- The **commit** at height `H` (in the block at `H`, or as `last_commit` in block `H+1`) is signed by >2/3 of the validators at `H-1`. That commit attests to the header at `H`, which includes `validators_hash`.
- **Full verification** of the list: recompute Tendermint's validator set hash and compare to `validatorsHashFromHeader`:
  - Tendermint uses `validators_hash = SHA256(ProtoEncoding(ValidatorSet))` (proto encoding of the validator set).
  - Implementing this in JS/TS requires the same proto definitions and encoding as Tendermint (e.g. from `tendermint/proto/tendermint/types`). This repo does not implement that hash; you can use a light client library or a small Go helper that computes the hash.

**RPC:**

- Block (with header): `GET /block?height=H` or JSON-RPC `block`.
- Validators: `GET /validators?height=H` or JSON-RPC `validators`.
- No ABCI `prove` flag is involved; this is pure Tendermint consensus data.

---

## 2. Application-state IAVL proof (ABCI query with `prove=true`)

**What you get:** A Merkle proof (proof_ops) that a specific *application state* value (e.g. a validator or validator set stored in app state) is under the app hash at a given height.

**How:**

- Call **`abci_query`** with `prove: true` and the path/key that corresponds to the validators in **app state** (e.g. Cosmos staking module).
- Example (conceptual): path like `/store/staking/key` with the key that stores the validator set or a single validator.
- The response can include `proof_ops`; verify it against the block's `app_hash` using ICS23 (e.g. `verifyProofAgainstRoot` in `./merkle.js`).

**Caveats:**

- Not all nodes enable proofs for all stores (proofs can be disabled or only for certain paths).
- This proves **app state** (e.g. staking module state), not the **consensus validator set** that Tendermint uses for signing. For many chains these align, but the key/layout is app-specific.
- This repo's inference EpochGroupData ABCI query does **not** return proofs on your chain; other modules (e.g. staking) might.

**When to use:**

- When you need an IAVL proof against `app_hash` for a value that lives in app state (e.g. staking validators).
- When you don't need the consensus validator set, but the app's view of validators.

---

## Summary

| Goal | Method | Proof type |
|------|--------|------------|
| Consensus validators at height H with attestation from the chain | `getValidatorsWithProofContext(H)` | Header's `validators_hash` + commit (full check = recompute ValidatorSet hash in proto) |
| App-state value (e.g. staking validators) under app_hash | `abci_query(path, key, height, prove: true)` | IAVL proof_ops vs `app_hash` |

For **consensus validators list with proof**, use **`getValidatorsWithProofContext(height)`**; the proof is the header's `validators_hash` plus the signed commit; optional full check is to recompute the validator set hash and compare.
