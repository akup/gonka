# Where validators are stored in the inference chain

Summary from the **inference-chain** codebase (Cosmos SDK inference module).

## Store and key

- **Module store**: inference module store (`types.StoreKey = "inference"`).
- **EpochGroupData** is stored under:
  - **Prefix**: `EpochGroupDataPrefix` (collections prefix `10`).
  - **Key**: `collections.Join(epochIndex, modelId)` → `(epoch_index, model_id)`.
- **Keeper**: `keeper.EpochGroupDataMap` — `collections.Map[collections.Pair[uint64, string], types.EpochGroupData]`.

So one **EpochGroupData** per `(epoch_index, model_id)`.

- **Parent EpochGroup** (all participants, no model filter): `model_id = ""`.
- **Per-model EpochGroup**: `model_id = "<model_id>"`.

Files:

- `inference-chain/x/inference/types/keys.go` — `EpochGroupDataPrefix = collections.NewPrefix(10)`.
- `inference-chain/x/inference/keeper/epoch_group_data.go` — `SetEpochGroupData`, `GetEpochGroupData` using `EpochGroupDataMap.Set/Get(ctx, collections.Join(epochIndex, modelId), ...)`.
- `inference-chain/x/inference/keeper/keeper.go` — `EpochGroupDataMap` definition.

## Proto: EpochGroupData and ValidationWeight

From `inference-chain/proto/inference/inference/epoch_group_data.proto`:

```protobuf
message EpochGroupData {
  uint64 poc_start_block_height = 1;
  uint64 epoch_group_id = 2;
  string epoch_policy = 3;           // group policy address (e.g. bech32)
  int64 effective_block_height = 4;
  int64 last_block_height = 5;
  repeated SeedSignature member_seed_signatures = 6;
  repeated ValidationWeight validation_weights = 8;   // <-- validators/participants
  // ... 9–18
  uint64 epoch_index = 16;
  // ...
}

message ValidationWeight {
  string member_address = 1;
  int64 weight = 2;
  int32 reputation = 3;
  repeated MLNodeInfo ml_nodes = 4;
  int64 confirmation_weight = 5;
}
```

So **validators** (participants with weights) are the **`validation_weights`** field (field number **8**) inside **EpochGroupData**.

## Where ValidationWeights are written

- **EpochGroup (parent and per-model)** is created in `epochgroup/epoch_group.go`:
  - `CreateGroup()` creates the group, sets `EpochGroupId`, `EpochPolicy`, and calls `SetEpochGroupData`.
  - `AddMember()` / `updateEpochGroupWithNewMember()` append to `GroupData.ValidationWeights` and call `SetEpochGroupData`.
- So both **parent** (`model_id == ""`) and **sub-groups** (per `model_id`) get `ValidationWeights` when members are added.
- Other updates (e.g. confirmation PoC) can update existing EpochGroupData and call `SetEpochGroupData` again (`confirmation_poc.go`, `module.go`).

## Query

- **gRPC/ABCI**: `QueryGetEpochGroupData(epoch_index, model_id)` → returns one **EpochGroupData** (including `validation_weights`) from the store.
- Implementation: `inference-chain/x/inference/keeper/query_epoch_group_data.go` — `EpochGroupData(ctx, req)` does `GetEpochGroupData(ctx, req.EpochIndex, req.ModelId)` and returns it as `QueryGetEpochGroupDataResponse{EpochGroupData: val}`. No stripping of `validation_weights`.

## Why your client might see 0 validation_weights

1. **Decoding**: Our TS decoder expects `validation_weights` at field **8** and supports field numbers 2,3,4,5,8. The chain uses field **8**; field **3** is `epoch_policy` (string), which matches the “single 64-byte” value you saw.
2. **Parent vs sub-group**: You query with `model_id = ""` (parent). If the chain only populates `ValidationWeights` on **sub-groups** (per model) and not on the parent in some code paths, the parent EpochGroupData could have empty `validation_weights`.
3. **Epoch lifecycle**: If that epoch’s parent EpochGroup was created but members were never added to the parent (only to sub-groups), the stored parent would have 0 `validation_weights`.

To get validators from the chain you can:

- Keep querying **EpochGroupData(epoch_index, "")** and, if the chain fills parent `validation_weights`, they will appear in field 8.
- Or query **EpochGroupData(epoch_index, model_id)** for a specific `model_id`; those entries are the ones that definitely get `ValidationWeights` in `AddMember` / `updateEpochGroupWithNewMember`.

## Store key format (for direct store queries)

If you ever query the store by key (e.g. for proofs):

- Module store key: inference module’s store (name `StoreKey`).
- EpochGroupData key: under prefix `EpochGroupDataPrefix` (10), then the encoding of `(epoch_index, model_id)` (collections encoding for `Pair[uint64, string]`).

The exact byte layout is defined by Cosmossdk `collections`; the key is not a human-readable string like `/epoch_group_data/158/` but the binary encoding used by `collections.Join(epochIndex, modelId)`.
