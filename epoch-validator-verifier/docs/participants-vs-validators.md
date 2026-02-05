# Participants vs validators in the inference chain

Where the inference chain decides **which participants become validators** and **which validators actually sign blocks**.

---

## 1. Who becomes an epoch-group participant (candidate validator)?

**Flow:** `ComputeNewWeights` (V1 or V2) → **active participants** → `addEpochMembers` adds **all** of them to the upcoming epoch group.

**Who is included (V2, `chainvalidation.go`):**

A participant becomes an **active participant** only if all of the following hold:

- They have a **store commit** (PoC V2) for the epoch.
- They have at least one **validation** (PoC validation) for the epoch.
- **Claimed weight** from store commit + node weight distribution is **≥ 1**.
- **ValidatorKey** is set (participant has registered their consensus key).
- They have a **seed** for the epoch.
- They **pass PoC validation** (majority of current validators voted “valid” for them).

**Who is excluded:**

- No store commit → excluded.
- No validations → excluded.
- Zero or negative claimed weight → excluded.
- Missing ValidatorKey → excluded.
- No seed → excluded.
- Failed PoC validation (majority invalid/fraud) → excluded.

**Code:** `inference-chain/x/inference/module/chainvalidation.go` — `WeightCalculator.validatedParticipant()`, `Calculate()`.  
**Code:** `inference-chain/x/inference/module/module.go` — `addEpochMembers()` (adds every active participant to the upcoming epoch group).

So: **participants who became validators** = those who passed the above checks and were added to the epoch group. **Participants who did not become validators** = those excluded by one of the conditions above (no commit, no validations, no weight, no ValidatorKey, no seed, or failed validation).

---

## 2. Who becomes a bonded validator (staking)?

**Flow:** When the epoch group is “changed”, the chain calls:

1. **`currentEpochGroup.GetComputeResults(ctx)`** — builds one `ComputeResult` per **epoch group member** (operator address, consensus pubkey, weight).
2. **`applyEarlyNetworkProtection(ctx, computeResult)`** — may adjust results (e.g. genesis guardian enhancement); does not drop participants.
3. **`Staking.SetComputeValidators(ctx, finalComputeResult, isTestnet)`** — bonds **all** of them in staking.

So **every epoch-group member** (every active participant from step 1) is turned into a **bonded validator** in the staking module. There is **no trimming by the inference module** at this step; all participants that made it into the epoch group become bonded validators.

**Code:** `inference-chain/x/inference/module/module.go` — `currentEpochGroup.IsChanged`, `GetComputeResults`, `applyEarlyNetworkProtection`, `SetComputeValidators`.  
**Code:** `inference-chain/x/inference/epochgroup/epoch_group.go` — `GetComputeResults()` (iterates `GetGroupMembers()` and appends one `ComputeResult` per member).

---

## 3. Who actually signs blocks (active consensus set)?

**Flow:** Tendermint/CometBFT gets the validator set from the **staking module**. The staking module uses **`MaxValidators`** (e.g. **100**). When building the consensus validator set (e.g. for `IterateBondedValidatorsByPower`), only the **top `MaxValidators` by power** are included.

So:

- **All** epoch-group participants are **bonded** validators (step 2).
- Only the **top `MaxValidators` (e.g. 100) by voting power** are in the **active set** that signs blocks.

Participants **beyond the top 100 by power** are still bonded validators (they can vote in governance, earn rewards, etc.) but **do not sign blocks** and do not appear in the Tendermint `/validators` response (which is capped by the staking module’s active set).

**Code / reference:** `inference-chain/app/tally_integration_test.go` — documents that `SetComputeValidators` bonds more than 100 validators, while `IterateBondedValidatorsByPower` is limited to `maxValidators` (100). Staking params: `MaxValidators` (e.g. in genesis or app params).

---

## Summary

| Stage | Who is included | Who is excluded |
|-------|-----------------|-----------------|
| **1. Active participant** | Store commit + validations + weight ≥ 1 + ValidatorKey + seed + pass PoC validation | No commit, no validations, no weight, no key, no seed, or failed validation |
| **2. Bonded validator** | All epoch-group members (all active participants) | — (no further filter here) |
| **3. Block signer (active set)** | Top **MaxValidators** (e.g. 100) by power | Bonded validators ranked below the top MaxValidators |

So: **participants who “became validators”** = those who passed step 1 and are in the epoch group (and thus bonded in step 2). **Participants who “do not sign blocks”** = either they never became active participants (step 1), or they are bonded but outside the top MaxValidators by power (step 3).
