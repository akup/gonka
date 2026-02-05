import * as ed from "@noble/ed25519";
import type { BlockWithCommit, Validator } from "./block.js";

/**
 * Verify that the commit (block signatures) was produced by the given validator set.
 * CometBFT commits are signed with Ed25519; we check that > 2/3 of voting power signed.
 */
export async function verifyCommitFromValidators(
  chainId: string,
  commit: NonNullable<BlockWithCommit["commit"]>,
  blockHeight: number,
  validators: Validator[]
): Promise<{ ok: boolean; signedPower: bigint; totalPower: bigint; errors: string[] }> {
  const errors: string[] = [];
  let signedPower = BigInt(0);
  let totalPower = BigInt(0);

  const validatorById = new Map<string | number, Validator>();
  for (let i = 0; i < validators.length; i++) {
    const v = validators[i];
    validatorById.set(i, v);
    if (v.address?.length) validatorById.set(validatorAddressToId(v.address), v);
    totalPower += v.votingPower;
  }

  if (totalPower === BigInt(0)) {
    return { ok: false, signedPower: BigInt(0), totalPower: BigInt(0), errors: ["empty validator set"] };
  }

  const blockIdBytes = commit.blockId.hash;
  const height = commit.height;
  const round = BigInt(0); // commit round

  const validatorsList = [...validators];
  for (let i = 0; i < commit.signatures.length; i++) {
    const sig = commit.signatures[i];
    if (!sig.signature || sig.signature.length === 0) continue;

    const validatorId = (sig as { validatorId?: string; validatorIndex?: number }).validatorId ??
      (sig as { validatorIndex?: number }).validatorIndex;
    const validator =
      typeof validatorId === "number" && validatorsList[validatorId]
        ? validatorsList[validatorId]
        : validatorById.get(validatorId as string);
    if (!validator) {
      errors.push(`Unknown validator in commit: ${validatorId}`);
      continue;
    }

    const voteSignBytes = encodeVoteSignBytes(chainId, blockIdBytes, height, round, 2); // 2 = PrecommitType
    try {
      const pubkey = extractEd25519Pubkey(validator.pubkey);
      if (!pubkey) {
        errors.push(`Validator ${validatorId}: not Ed25519 pubkey`);
        continue;
      }
      const valid = await ed.verifyAsync(sig.signature, voteSignBytes, pubkey);
      if (valid) {
        signedPower += validator.votingPower;
      } else {
        errors.push(`Validator ${validatorId}: invalid signature`);
      }
    } catch (e) {
      errors.push(`Validator ${validatorId}: ${(e as Error).message}`);
    }
  }

  const twoThirds = (totalPower * BigInt(2) + BigInt(2)) / BigInt(3);
  const ok = signedPower >= twoThirds;

  return { ok, signedPower, totalPower, errors };
}

function validatorAddressToId(address: Uint8Array): string {
  return Buffer.from(address).toString("hex").toUpperCase().slice(0, 40);
}

function extractEd25519Pubkey(pubkey: { typeUrl?: string; value?: Uint8Array }): Uint8Array | null {
  const val = pubkey?.value;
  if (!val || val.length !== 32) return null;
  if (pubkey.typeUrl?.includes("ed25519")) return val;
  return val;
}

/**
 * Encode vote sign bytes for CometBFT: chain_id + height(8) + round(8) + type(1) + block_id.
 */
function encodeVoteSignBytes(
  chainId: string,
  blockIdHash: Uint8Array,
  height: bigint,
  round: bigint,
  type: number
): Uint8Array {
  const chainIdLen = new Uint8Array(1);
  chainIdLen[0] = chainId.length;

  const heightBytes = new Uint8Array(8);
  new DataView(heightBytes.buffer).setBigUint64(0, height, true);

  const roundBytes = new Uint8Array(8);
  new DataView(roundBytes.buffer).setBigUint64(0, round, true);

  const typeBytes = new Uint8Array(1);
  typeBytes[0] = type;

  const total =
    chainIdLen.length +
    new TextEncoder().encode(chainId).length +
    heightBytes.length +
    roundBytes.length +
    typeBytes.length +
    blockIdHash.length;

  const out = new Uint8Array(total);
  let offset = 0;
  out.set(chainIdLen, offset); offset += 1;
  out.set(new TextEncoder().encode(chainId), offset); offset += chainId.length;
  out.set(heightBytes, offset); offset += 8;
  out.set(roundBytes, offset); offset += 8;
  out.set(typeBytes, offset); offset += 1;
  out.set(blockIdHash, offset);

  return out;
}
