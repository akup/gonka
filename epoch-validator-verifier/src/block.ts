import { getRpcClient } from "./rpc-client.js";

/** Header may include validatorsHash / nextValidatorsHash from RPC (for proof verification). */
export interface BlockHeaderWithProof {
  height: bigint;
  appHash: Uint8Array;
  chainId: string;
  validatorsHash?: Uint8Array;
  nextValidatorsHash?: Uint8Array;
}

export interface BlockWithCommit {
  block: {
    header: BlockHeaderWithProof;
    lastCommit: { height: bigint; blockId: { hash: Uint8Array }; signatures: Array<{ validatorId?: string; signature?: Uint8Array }> } | null;
  };
  commit: { height: bigint; blockId: { hash: Uint8Array }; signatures: Array<{ validatorId?: string; signature?: Uint8Array }> } | null;
}

export interface Validator {
  pubkey: { typeUrl?: string; value?: Uint8Array };
  votingPower: bigint;
  address?: Uint8Array;
}

/**
 * Get block at height. The block includes LastCommit (signatures for the previous block).
 */
export async function getBlock(height: number): Promise<BlockWithCommit> {
  const { client } = await getRpcClient();
  const res = await client.block(height);
  if (!res.block) throw new Error(`No block at height ${height}`);
  const block = res.block as unknown as BlockWithCommit["block"];
  return {
    block,
    commit: block.lastCommit ?? null,
  };
}

/**
 * Get commit for a specific height (optional; commit is also in block at height+1 as lastCommit).
 */
export async function getCommit(height: number): Promise<BlockWithCommit["commit"]> {
  const { client } = await getRpcClient();
  const res = await client.commit(height);
  const commit = (res as { signedHeader?: { commit?: BlockWithCommit["commit"] } }).signedHeader?.commit ?? null;
  return commit;
}

/** Page size for validators RPC. Many nodes cap reported total at 100; we paginate by page size to get all. */
const VALIDATORS_PER_PAGE = 100;

/** True if the RPC error means "only page 1 is allowed" (node returns all validators in one page). */
function isSinglePageOnlyError(err: unknown): boolean {
  const s =
    (err instanceof Error ? err.message : "") +
    (typeof (err as { data?: string })?.data === "string" ? (err as { data: string }).data : "") +
    JSON.stringify(err);
  return /page should be within\s*\[\s*1\s*,\s*1\s*\]/i.test(s);
}

/**
 * Get full validator set at a given height (consensus validators who signed that height).
 * Paginates until a page returns fewer than per_page items. If the node only allows page 1
 * (e.g. "page should be within [1, 1]"), we use the validators from the first page.
 */
export async function getValidators(height: number): Promise<Validator[]> {
  const { client } = await getRpcClient();
  const all: Validator[] = [];
  let page = 1;
  for (;;) {
    try {
      const res = await client.validators({
        height,
        page,
        per_page: VALIDATORS_PER_PAGE,
      });
      const list = res.validators ?? [];
      all.push(...([...list] as Validator[]));
      if (list.length < VALIDATORS_PER_PAGE) break;
      page++;
    } catch (err) {
      if (page > 1 && isSinglePageOnlyError(err)) break;
      throw err;
    }
  }
  return all;
}

export interface ValidatorsWithProofContext {
  validators: Validator[];
  block: BlockWithCommit;
  /** Hash of this validator set as committed in the block header (Tendermint consensus proof). */
  validatorsHashFromHeader: Uint8Array | undefined;
}

/**
 * Get validator set at a given height together with the block header's validators_hash.
 * Use this when you need a "proof" that the validator set is the one committed in the chain:
 * - The block at height H has header.validators_hash = hash(validator set at H).
 * - The commit (signed by validators at H-1) attests to that header.
 * Full verification: recompute Tendermint's ValidatorSet hash (proto encoding + SHA256) and
 * compare to validatorsHashFromHeader; see docs/validators-with-proof.md.
 */
export async function getValidatorsWithProofContext(height: number): Promise<ValidatorsWithProofContext> {
  const [validators, block] = await Promise.all([getValidators(height), getBlock(height)]);
  const header = block.block.header as BlockHeaderWithProof;
  const validatorsHashFromHeader = header.validatorsHash;
  return {
    validators,
    block,
    validatorsHashFromHeader,
  };
}
