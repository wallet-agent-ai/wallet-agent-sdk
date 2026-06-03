// ─── Caviar LSU Pool Adapter ───────────────────────────────────────────────────
// Implementa add_liquidity y remove_liquidity para el LSU Pool de Caviar.
// El LSU Pool permite depositar LSU tokens (Liquid Staking Units) de cualquier
// validador de Radix y recibir LSULP tokens a cambio.
//
// Package mainnet: package_rdx1pkfrtmv980h85c9nvhxa7c9y0z4vxzt25c3gdzywz5l52g5t0hdeey
// Blueprint: LsuPool
// Component: component_rdx1cppy08xgra5tv5melsjtj79c0ngvrlmzl8hhs7vwtzknp9xxs63mfp
//
// ─── Por qué usar el LSU Pool ─────────────────────────────────────────────────
// Al depositar LSUs en el pool:
//   1. Sigues ganando staking rewards sobre tus LSUs
//   2. Además ganas fees de swap (0.05% por cada XRD↔LSU intercambio)
//   = Doble rendimiento sobre el mismo capital
//
// ─── Firmas de métodos ────────────────────────────────────────────────────────
// add_liquidity(
//   lsu_bucket: Bucket,          ← LSU tokens de cualquier validador
//   credit_receipt: Enum<0u8>()  ← None (primera vez) o Some(proof) para añadir a posición existente
// ) → LSULP tokens + credit_receipt NFT
//
// remove_liquidity(
//   lsulp_bucket: Bucket,                    ← LSULP tokens a quemar
//   lsu_resource: ResourceAddress,            ← qué LSU quieres recibir
//   credit_receipt_proof: Enum<1u8>(Proof)   ← proof del credit_receipt NFT
// ) → LSU tokens del validador elegido
//
// ─── IMPORTANTE ───────────────────────────────────────────────────────────────
// El credit_receipt NFT se emite al hacer add_liquidity.
// Se guarda en el vault via deposit_any.
// Es NECESARIO para hacer remove_liquidity — sin él no puedes retirar.
// resource: resource_rdx1nt3frmqu4v57dy55e90n0k3uy352zyy89vszzamvjld6vqvr98rls9
// ─────────────────────────────────────────────────────────────────────────────

import type {
  LiquidityProvider,
  LiquidityProtocol,
  Pool,
  AddLiquidityParams,
  RemoveLiquidityParams,
  LiquidityResult,
} from "../../types";

// ─── Constantes mainnet ───────────────────────────────────────────────────────

export const LSU_POOL_ADDRESS = "component_rdx1cppy08xgra5tv5melsjtj79c0ngvrlmzl8hhs7vwtzknp9xxs63mfp";
export const LSULP_RESOURCE   = "resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf";
export const CREDIT_RECEIPT_RESOURCE = "resource_rdx1nt3frmqu4v57dy55e90n0k3uy352zyy89vszzamvjld6vqvr98rls9";

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface LsuPoolAddParams extends AddLiquidityParams {
  // tokenAAddress = LSU resource address del validador
  // amountA = cantidad de LSU a depositar
  // creditReceiptId = opcional — ID del NFT credit_receipt existente para añadir a posición
  creditReceiptId?: string;
}

export interface LsuPoolRemoveParams extends RemoveLiquidityParams {
  // lpTokenAddress = LSULP resource address
  // lpAmount = cantidad de LSULP a quemar
  // tokenAAddress = LSU resource address que quieres recibir
  lsuResourceToReceive: string;   // qué LSU quieres recibir al retirar
  creditReceiptId: string;        // ID del NFT credit_receipt — OBLIGATORIO
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class CaviarLsuPoolAdapter implements LiquidityProvider {
  readonly protocol: LiquidityProtocol = "caviar_lsupool" as LiquidityProtocol;
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  async getPools(): Promise<Pool[]> {
    return [{
      poolAddress:    LSU_POOL_ADDRESS,
      name:           "Caviar LSU Pool",
      tokenAAddress:  LSULP_RESOURCE, // LP token
      tokenBAddress:  "",             // acepta cualquier LSU
      lpTokenAddress: LSULP_RESOURCE,
      protocol:       "caviar_lsupool" as LiquidityProtocol,
    }];
  }

  // ─── addLiquidity ───────────────────────────────────────────────────────────
  // Deposita LSU tokens → recibe LSULP + credit_receipt NFT.
  // El credit_receipt NFT es necesario para retirar — se guarda en el vault.
  //
  // tokenAAddress = LSU resource address del validador
  // amountA = cantidad de LSU
  // creditReceiptId = opcional — si ya tienes una posición y quieres añadir más

  async addLiquidity(params: AddLiquidityParams & {
    creditReceiptId?: string;
  }): Promise<LiquidityResult> {
    const {
      tokenAAddress,  // LSU resource address
      amountA,        // cantidad de LSU
      vaultAddress,
      notarizerAddress,
    } = params;

    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";
    const creditReceiptId = (params as any).creditReceiptId;

    // Si hay credit_receipt existente — añadir a posición existente con proof
    // Si no — primera vez, Enum<0u8>() = None
    const creditReceiptArg = creditReceiptId
      ? `Enum<1u8>(\n    Proof("credit_proof")\n)`
      : `Enum<0u8>()`;

    const creditReceiptProofLines = creditReceiptId ? `
CALL_METHOD
    Address("${vaultAddress}")
    "create_proof_of_non_fungibles"
    Address("${CREDIT_RECEIPT_RESOURCE}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${creditReceiptId}"))
;
POP_FROM_AUTH_ZONE
    Proof("credit_proof")
;` : "";

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
    Address("${BADGE_PLACEHOLDER_RESOURCE}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${BADGE_PLACEHOLDER_ID}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_liquidity"
    Address("${LSU_POOL_ADDRESS}")
    Decimal("${amountA}")
    Address("${tokenAAddress}")
    "caviar lsu pool add liquidity"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenAAddress}")
    Bucket("lsu_bucket")
;${creditReceiptProofLines}
CALL_METHOD
    Address("${LSU_POOL_ADDRESS}")
    "add_liquidity"
    Bucket("lsu_bucket")
    ${creditReceiptArg}
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

    return {
      manifest,
      description:
        `Caviar LSU Pool add_liquidity: ${amountA} LSU → LSULP tokens + credit_receipt NFT al vault. ` +
        `Ganarás staking rewards + fees de swap simultáneamente.`,
    };
  }

  // ─── removeLiquidity ────────────────────────────────────────────────────────
  // Quema LSULP tokens → recibe LSU tokens del validador elegido.
  // REQUIERE: credit_receipt NFT en el vault (recibido al hacer add_liquidity).
  //
  // lpTokenAddress = LSULP resource address
  // lpAmount = cantidad de LSULP a quemar
  // lsuResourceToReceive = qué LSU quieres recibir (puede ser de cualquier validador)
  // creditReceiptId = ID del NFT credit_receipt — OBLIGATORIO

  async removeLiquidity(params: RemoveLiquidityParams & {
    lsuResourceToReceive?: string;
    creditReceiptId?: string;
  }): Promise<LiquidityResult> {
    const {
      lpTokenAddress, // LSULP
      lpAmount,
      vaultAddress,
      notarizerAddress,
    } = params;

    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";

    const lsuResourceToReceive = (params as any).lsuResourceToReceive;
    const creditReceiptId = (params as any).creditReceiptId;

    if (!creditReceiptId) {
      throw new Error(
        "Para retirar liquidez del LSU Pool necesitas el ID del credit_receipt NFT. " +
        "Usa wallet_balance para encontrarlo — busca tokens del resource " +
        `${CREDIT_RECEIPT_RESOURCE}`
      );
    }

    if (!lsuResourceToReceive) {
      throw new Error(
        "Debes especificar qué LSU quieres recibir (lsuResourceToReceive). " +
        "Usa el resource address del LSU del validador que prefieras."
      );
    }

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
    Address("${BADGE_PLACEHOLDER_RESOURCE}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${BADGE_PLACEHOLDER_ID}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_liquidity"
    Address("${LSU_POOL_ADDRESS}")
    Decimal("${lpAmount}")
    Address("${lpTokenAddress}")
    "caviar lsu pool remove liquidity"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${lpTokenAddress}")
    Bucket("lsulp_bucket")
;
CALL_METHOD
    Address("${vaultAddress}")
    "create_proof_of_non_fungibles"
    Address("${CREDIT_RECEIPT_RESOURCE}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${creditReceiptId}"))
;
POP_FROM_AUTH_ZONE
    Proof("credit_proof")
;
CALL_METHOD
    Address("${LSU_POOL_ADDRESS}")
    "remove_liquidity"
    Bucket("lsulp_bucket")
    Address("${lsuResourceToReceive}")
    Enum<1u8>(
        Proof("credit_proof")
    )
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

    return {
      manifest,
      description:
        `Caviar LSU Pool remove_liquidity: ${lpAmount} LSULP → LSU tokens al vault.`,
    };
  }
}

// ─── Instancia singleton ──────────────────────────────────────────────────────

let _lsuPoolAdapter: CaviarLsuPoolAdapter | null = null;

export function getLsuPoolAdapter(gatewayUrl: string): CaviarLsuPoolAdapter {
  if (!_lsuPoolAdapter) {
    _lsuPoolAdapter = new CaviarLsuPoolAdapter(gatewayUrl);
  }
  return _lsuPoolAdapter;
}
