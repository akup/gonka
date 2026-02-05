# Why ABCI EpochGroupData query has no proof and (sometimes) no participants

Explanation from examining the **inference-chain** codebase.

---

## 1. Why no proof

### How the query is served

- The ABCI query for EpochGroupData uses the **gRPC query path**: path like `/inference.inference.Query/EpochGroupData` or similar, which is routed to the inference module’s **gRPC query service**.
- The handler is **`keeper.EpochGroupData`** in `inference-chain/x/inference/keeper/query_epoch_group_data.go`:

```go
func (k Keeper) EpochGroupData(ctx context.Context, req *types.QueryGetEpochGroupDataRequest) (*types.QueryGetEpochGroupDataResponse, error) {
	// ...
	val, found := k.GetEpochGroupData(ctx, req.EpochIndex, req.ModelId)
	if !found {
		return nil, status.Error(codes.NotFound, "not found")
	}
	return &types.QueryGetEpochGroupDataResponse{EpochGroupData: val}, nil
}
```

- The handler **only** reads from the store (`GetEpochGroupData`) and returns the value. It **never** asks the store for a Merkle proof and does **not** attach any proof to the response.

### Cosmos SDK behavior

- In Cosmos SDK, **gRPC query handlers do not generate or return IAVL/store proofs**. They use the keeper (and thus the store) to return data only. There is no `prove` parameter in `QueryGetEpochGroupDataRequest`, and no code path in the inference module that builds proof_ops for this query.
- So when a client sends **`abci_query`** with **`prove: true`** for this path:
  - The request is still handled by the **same gRPC query handler** (keeper.EpochGroupData).
  - The handler does **not** call the store with “prove” and does **not** return proof_ops.
  - The node may leave **proof_ops empty** in the ABCI response, so the client sees **no proof**.

**Summary:** The inference chain does not implement proof generation for the EpochGroupData query. The query is a normal gRPC keeper read; Cosmos SDK gRPC queries do not add proofs. So **no proof** is by design of both the SDK and this module.

---

## 2. Why (sometimes) no participants in the ABCI response

### Chain side: participants are written

- **Parent** EpochGroupData (e.g. `model_id = ""`) **does** get participants (ValidationWeights) in the inference chain:
  1. At **EndOfPoCValidation** stage, **`onEndOfPoCValidationStage`** runs and calls **`addEpochMembers(ctx, upcomingEg, activeParticipants)`** (`inference-chain/x/inference/module/module.go`).
  2. **`upcomingEg`** is **GetEpochGroupForEpoch(upcomingEpoch)** → the **parent** epoch group (`model_id = ""`) for the upcoming epoch.
  3. **`addEpochMembers`** calls **`upcomingEg.AddMember(ctx, member)`** for each active participant.
  4. **`AddMember`** → **`updateEpochGroupWithNewMember`** in `inference-chain/x/inference/epochgroup/epoch_group.go` appends to **`GroupData.ValidationWeights`** and calls **`SetEpochGroupData`**. So the parent’s EpochGroupData in the store **does** contain ValidationWeights (participants).

So on chain, the parent EpochGroupData **is** populated with participants at EndOfPoCValidation. The keeper query **returns the full struct** from the store; it does not strip ValidationWeights.

### Why a client might see “no participants”

1. **Decoding (most likely)**  
   The ABCI response **value** is the **base64-encoded** bytes of **`QueryGetEpochGroupDataResponse`**, which contains **`EpochGroupData`**. In the **EpochGroupData** proto, **participants** are **`validation_weights`** at **field number 8**. Other fields use different numbers (e.g. field 3 is `epoch_policy`). If the client decodes with the wrong field number or wrong message type, it can end up with an empty or wrong list and think there are “no participants”. So **no participants** is often a **client-side decoding issue** (wrong field or wrong nesting).

2. **Query height**  
   If the client queries at a block height **before** the **EndOfPoCValidation** block for that epoch, the parent EpochGroupData for that epoch may not yet have had **addEpochMembers** run, so ValidationWeights can still be empty. Querying at or after that block (and before any later overwrite) should return participants.

3. **REST vs ABCI**  
   REST (gRPC-gateway) returns **JSON** with clear field names (e.g. `validation_weights`). So the same data that in ABCI is “opaque” protobuf can appear correctly as participants when queried via REST. That’s why REST “has” participants and ABCI can appear not to—same store, different encoding and decoding.

**Summary:** The chain **does** write participants into the parent EpochGroupData and the query **does** return the full value. “No participants” in the ABCI response is usually due to **client decoding** (wrong field/nesting) or **query height** (before EndOfPoCValidation). REST shows participants because it uses the same data with a different (JSON) encoding.

---

## 3. Reference: where it happens in inference-chain

| What | File | Notes |
|------|------|--------|
| EpochGroupData query (no proof) | `x/inference/keeper/query_epoch_group_data.go` | `EpochGroupData()` only does `GetEpochGroupData` and returns value; no proof. |
| Parent group gets members | `x/inference/module/module.go` | `onEndOfPoCValidationStage` → `addEpochMembers(upcomingEg, activeParticipants)`. |
| AddMember / ValidationWeights | `x/inference/epochgroup/epoch_group.go` | `AddMember` → `updateEpochGroupWithNewMember` → append to `GroupData.ValidationWeights` → `SetEpochGroupData`. |
| Parent group identity | `x/inference/keeper/power.go` | `GetEpochGroupForEpoch` → `GetEpochGroup(ctx, epoch.Index, "")` (model_id = ""). |

---

## 4. Summary

- **No proof:** The EpochGroupData query is implemented as a gRPC keeper query that only returns the value. The inference chain does not add proof generation for this query, and Cosmos SDK gRPC queries do not return store proofs. So ABCI EpochGroupData has **no proof** by design.
- **No participants (in ABCI):** The chain **does** store participants in the parent EpochGroupData and the handler returns the full value. “No participants” is typically due to **client decoding** (e.g. wrong proto field for ValidationWeights) or **query height** (before EndOfPoCValidation). Using REST or fixing decoding/height usually shows participants.
