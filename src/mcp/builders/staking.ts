import type { StakeParams, UnstakeParams, ClaimParams, StakeResult } from "../types";

const XRD_STOKENET = "resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc";
const XRD_MAINNET  = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";

function xrdAddress(notarizerAddress: string): string {
  return notarizerAddress.includes("tdx_2") ? XRD_STOKENET : XRD_MAINNET;
}

export function buildStakeManifest(params: StakeParams): StakeResult {
  const {
    validatorAddress, amount, vaultAddress,
    notarizerAddress, badgeResourceAddress, badgeLocalId,
  } = params;

  const xrd = xrdAddress(notarizerAddress);

  const manifest = `CALL_METHOD
    Address("${notarizerAddress}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${vaultAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${notarizerAddress}")
    "create_proof_of_non_fungibles"
    Address("${badgeResourceAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${badgeLocalId}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${validatorAddress}")
    Decimal("${amount}")
    Address("${xrd}")
    "stake xrd"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${xrd}")
    Bucket("xrd_bucket")
;
CALL_METHOD
    Address("${validatorAddress}")
    "stake"
    Bucket("xrd_bucket")
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_batch"
    Expression("ENTIRE_WORKTOP")
;`;

  return {
    manifest,
    description: `Stake ${amount} XRD en validador ${validatorAddress.slice(0, 30)}...`,
  };
}

export function buildUnstakeManifest(params: UnstakeParams): StakeResult {
  const {
    validatorAddress, lsuAmount, lsuResourceAddress, vaultAddress,
    notarizerAddress, badgeResourceAddress, badgeLocalId,
  } = params;

  const manifest = `CALL_METHOD
    Address("${notarizerAddress}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${vaultAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${notarizerAddress}")
    "create_proof_of_non_fungibles"
    Address("${badgeResourceAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${badgeLocalId}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${validatorAddress}")
    Decimal("${lsuAmount}")
    Address("${lsuResourceAddress}")
    "unstake lsu"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${lsuResourceAddress}")
    Bucket("lsu_bucket")
;
CALL_METHOD
    Address("${validatorAddress}")
    "unstake"
    Bucket("lsu_bucket")
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_batch"
    Expression("ENTIRE_WORKTOP")
;`;

  return {
    manifest,
    description: `Unstake ${lsuAmount} LSU del validador ${validatorAddress.slice(0, 30)}...`,
  };
}
export function buildClaimManifest(params: ClaimParams): StakeResult {
  const {
    validatorAddress, claimNftResourceAddress, claimNftIds, vaultAddress,
    notarizerAddress, badgeResourceAddress, badgeLocalId,
  } = params;

  const nftClaims = claimNftIds.map((id, index) => `
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_nft"
    Address("${validatorAddress}")
    Address("${claimNftResourceAddress}")
    NonFungibleLocalId("${id}")
    "claim xrd unbonded"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${claimNftResourceAddress}")
    Bucket("claim_nft_bucket_${index}")
;
CALL_METHOD
    Address("${validatorAddress}")
    "claim_xrd"
    Bucket("claim_nft_bucket_${index}")
;`).join("\n");

  const manifest = `CALL_METHOD
    Address("${notarizerAddress}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${vaultAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${notarizerAddress}")
    "create_proof_of_non_fungibles"
    Address("${badgeResourceAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${badgeLocalId}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
${nftClaims}
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

  return {
    manifest,
    description: `Claim XRD del validador ${validatorAddress.slice(0, 30)}... — ${claimNftIds.length} NFT(s)`,
  };
}
