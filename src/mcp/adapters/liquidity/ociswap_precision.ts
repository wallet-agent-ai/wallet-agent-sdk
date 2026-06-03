// ─── Ociswap PrecisionPool Adapter ────────────────────────────────────────────
// Implementa add_liquidity y remove_liquidity para Ociswap V2 PrecisionPool.
// Concentrated liquidity — las posiciones se definen por rangos de ticks (I32).
// Las posiciones LP son NFTs del lp_manager del pool.
//
// Package mainnet: package_rdx1p5l6dp3slnh9ycd7gk700czwlck9tujn0zpdnd0efw09n2zdnn0lzx
// Blueprint: PrecisionPool
//
// Firma de add_liquidity:
//   add_liquidity(tick_lower: I32, tick_upper: I32, bucket_x: Bucket, bucket_y: Bucket)
//   → devuelve NFT posición LP + remainder de tokens
//
// Firma de remove_liquidity:
//   remove_liquidity(lp_nft_bucket: Bucket)
//   → devuelve token_x + token_y + fees acumulados
//
// ─── Cómo obtener info del pool ───────────────────────────────────────────────
// GET /state/entity/details?addresses=[component_address]
//   → state.fields:
//     - x_liquidity vault → token X address via fungible_resources
//     - y_liquidity vault → token Y address
//     - tick_spacing (U32) → múltiplo requerido para ticks
//     - active_tick (Option<I32>) → tick actual del precio
//     - price_sqrt (PreciseDecimal) → precio actual
//     - lp_manager (ResourceAddress) → NFT resource de posiciones LP
//     - input_fee_rate (Decimal)
//
// ─── Nota sobre royalty fee ───────────────────────────────────────────────────
// transfer_liquidity cobra 1 XRD de royalty por llamada.
// Si el token es XRD, se resta 1 XRD del amount efectivo para que el pool
// reciba exactamente lo que llega al worktop tras el royalty.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  LiquidityProvider,
  LiquidityProtocol,
  Pool,
  AddLiquidityParams,
  RemoveLiquidityParams,
  LiquidityResult,
} from "../../types";
import { KNOWN_POOLS_REGISTRY, getPool } from "../../known-pools.js";

// ─── Constantes ───────────────────────────────────────────────────────────────

const XRD_ADDRESS = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
const TRANSFER_LIQUIDITY_ROYALTY_XRD = 1; // fee fijo en XRD por llamada a transfer_liquidity

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface PrecisionPoolInfo {
  componentAddress: string;
  tokenXAddress: string;
  tokenYAddress: string;
  lpManagerAddress: string; // NFT resource de posiciones LP
  tickSpacing: number;
  activeTick: number;
  priceSqrt: string;
  fee: string;
}

export interface PrecisionAddLiquidityParams extends AddLiquidityParams {
  tickLower?: number; // Si no se provee, el adapter calcula ±20% del active_tick
  tickUpper?: number;
  lpNftId?: string;   // Para remove: ID del NFT de posición e.g. "#2#"
}

// ─── Helper: obtener info del pool dinámicamente ──────────────────────────────

export async function fetchPrecisionPoolInfo(
  componentAddress: string,
  gatewayUrl: string
): Promise<PrecisionPoolInfo> {
  const res = await fetch(`${gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: [componentAddress] }),
  });
  const data = await res.json() as any;
  const fields: any[] = data?.items?.[0]?.details?.state?.fields ?? [];

  const getField = (name: string) => fields.find((f: any) => f.field_name === name);

  const tickSpacing  = parseInt(getField("tick_spacing")?.value ?? "60");
  const activeTick   = parseInt(getField("active_tick")?.fields?.[0]?.value ?? "0");
  const priceSqrt    = getField("price_sqrt")?.value ?? "0";
  const fee          = getField("input_fee_rate")?.value ?? "0";
  const lpManager    = getField("lp_manager")?.value ?? "";

  // Obtener token addresses de los vaults internos
  const xVault = getField("x_liquidity")?.value ?? "";
  const yVault = getField("y_liquidity")?.value ?? "";

  // Consultar los vaults para obtener los resource addresses
  const vaultRes = await fetch(`${gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [xVault, yVault],
      opt_ins: { explicit_metadata: ["resource_address"] },
    }),
  });
  const vaultData = await vaultRes.json() as any;
  const vaultItems = vaultData?.items ?? [];

  const getVaultResource = (vaultAddress: string): string => {
    const item = vaultItems.find((i: any) => i.address === vaultAddress);
    return item?.fungible_resources?.items?.[0]?.resource_address ?? "";
  };

  return {
    componentAddress,
    tokenXAddress:    getVaultResource(xVault),
    tokenYAddress:    getVaultResource(yVault),
    lpManagerAddress: lpManager,
    tickSpacing,
    activeTick,
    priceSqrt,
    fee,
  };
}

// ─── Helper: calcular rango de ticks por defecto (±20%) ──────────────────────
// Los ticks deben ser múltiplos de tickSpacing.
// Para crypto, ±20% alrededor del active_tick es un rango razonable.

export function getDefaultTickRange(
  activeTick: number,
  tickSpacing: number
): { tickLower: number; tickUpper: number } {
  const range = Math.abs(Math.round(activeTick * 0.20));

  // Redondear a múltiplo de tickSpacing
  const rawLower = activeTick - range;
  const rawUpper = activeTick + range;

  const tickLower = Math.floor(rawLower / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil(rawUpper / tickSpacing) * tickSpacing;

  return { tickLower, tickUpper };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class OciswapPrecisionAdapter implements LiquidityProvider {
  readonly protocol: LiquidityProtocol = "ociswap";
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  async getPools(): Promise<Pool[]> {
    return KNOWN_POOLS_REGISTRY
      .filter(p => p.protocol === "ociswap_precision")
      .map(p => ({
        poolAddress:    p.address,
        name:           "Ociswap PrecisionPool",
        tokenAAddress:  p.token0,
        tokenBAddress:  p.token1,
        lpTokenAddress: p.ticksKvs ?? "",
        protocol:       "ociswap_precision" as LiquidityProtocol,
      }));
  }

  async getPoolInfo(poolAddress: string): Promise<PrecisionPoolInfo> {
    const cached = getPool(poolAddress);
    if (cached && cached.protocol === "ociswap_precision") {
      return {
        componentAddress: cached.address,
        tokenXAddress:    cached.token0,
        tokenYAddress:    cached.token1,
        lpManagerAddress: cached.ticksKvs ?? "",
        tickSpacing:      60,
        activeTick:       0,
        priceSqrt:        "0",
        fee:              (cached.feeRateBps / 10000).toString(),
      };
    }
    return fetchPrecisionPoolInfo(poolAddress, this.gatewayUrl);
  }

  // ─── addLiquidity ───────────────────────────────────────────────────────────
  // Si el usuario no provee ticks, el adapter calcula ±20% del active_tick.
  // El pool devuelve el remainder del token sobrante al worktop → vault.
  // La posición LP es un NFT que se deposita en el vault via deposit_any.
  //
  // IMPORTANTE: transfer_liquidity cobra 1 XRD de royalty por llamada.
  // Si el token es XRD, se resta el royalty del amount efectivo para que
  // el pool reciba exactamente lo que llega al worktop.

  async addLiquidity(params: AddLiquidityParams & {
    tickLower?: number;
    tickUpper?: number;
  }): Promise<LiquidityResult> {
    const {
      poolAddress,
      tokenAAddress,  // token X
      amountA,
      tokenBAddress,  // token Y
      amountB,
      vaultAddress,
      notarizerAddress,
    } = params;

    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";

    // Obtener info del pool para calcular ticks si no se proveen
    const poolInfo = await this.getPoolInfo(poolAddress);

    let tickLower = (params as any).tickLower;
    let tickUpper = (params as any).tickUpper;
    let usingDefaultRange = false;

    if (tickLower === undefined || tickUpper === undefined) {
      const range = getDefaultTickRange(poolInfo.activeTick, poolInfo.tickSpacing);
      tickLower = range.tickLower;
      tickUpper = range.tickUpper;
      usingDefaultRange = true;
    }

    // Validar que los ticks son múltiplos de tickSpacing
    if (tickLower % poolInfo.tickSpacing !== 0 || tickUpper % poolInfo.tickSpacing !== 0) {
      throw new Error(
        `Los ticks deben ser múltiplos de ${poolInfo.tickSpacing}. ` +
        `tick_lower=${tickLower}, tick_upper=${tickUpper}`
      );
    }

    if (tickLower >= tickUpper) {
      throw new Error(`tick_lower (${tickLower}) debe ser menor que tick_upper (${tickUpper})`);
    }

    // ── Calcular amounts efectivos descontando royalty si el token es XRD ──
    const rawAmountA = parseFloat(amountA);
    const rawAmountB = parseFloat(amountB ?? "0");

    const effectiveAmountA = tokenAAddress === XRD_ADDRESS
      ? rawAmountA - TRANSFER_LIQUIDITY_ROYALTY_XRD
      : rawAmountA;

    const effectiveAmountB = tokenBAddress === XRD_ADDRESS
      ? rawAmountB - TRANSFER_LIQUIDITY_ROYALTY_XRD
      : rawAmountB;

    if (effectiveAmountA <= 0) {
      throw new Error(
        `El amount de tokenA (${amountA} XRD) no cubre el royalty fee de ${TRANSFER_LIQUIDITY_ROYALTY_XRD} XRD. ` +
        `Necesitas al menos ${TRANSFER_LIQUIDITY_ROYALTY_XRD + 0.000001} XRD.`
      );
    }
    if (effectiveAmountB <= 0) {
      throw new Error(
        `El amount de tokenB (${amountB} XRD) no cubre el royalty fee de ${TRANSFER_LIQUIDITY_ROYALTY_XRD} XRD. ` +
        `Necesitas al menos ${TRANSFER_LIQUIDITY_ROYALTY_XRD + 0.000001} XRD.`
      );
    }

    // El manifest usa amountA/amountB originales en transfer_liquidity
    // (el vault cobra el royalty y al worktop llegan los effectiveAmounts)
    // Ociswap acepta cualquier cantidad y devuelve el remainder → no necesitamos
    // pasar effectiveAmounts al manifest, TAKE_ALL_FROM_WORKTOP recoge lo que llega.
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
CLONE_PROOF
    Proof("agent_proof")
    Proof("proof_x")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_liquidity"
    Address("${poolAddress}")
    Decimal("${amountA}")
    Address("${tokenAAddress}")
    "ociswap add liquidity X"
    Proof("proof_x")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_liquidity"
    Address("${poolAddress}")
    Decimal("${amountB ?? "0"}")
    Address("${tokenBAddress}")
    "ociswap add liquidity Y"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenAAddress}")
    Bucket("bucket_x")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenBAddress}")
    Bucket("bucket_y")
;
CALL_METHOD
    Address("${poolAddress}")
    "add_liquidity"
    ${tickLower}i32
    ${tickUpper}i32
    Bucket("bucket_x")
    Bucket("bucket_y")
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

    const rangeDesc = usingDefaultRange
      ? `rango automático ±20% [${tickLower}, ${tickUpper}]`
      : `rango [${tickLower}, ${tickUpper}]`;

    const royaltyNote = (tokenAAddress === XRD_ADDRESS || tokenBAddress === XRD_ADDRESS)
      ? ` | Royalty fee ${TRANSFER_LIQUIDITY_ROYALTY_XRD} XRD descontado del amount efectivo`
      : "";

    return {
      manifest,
      description:
        `Ociswap PrecisionPool add_liquidity: ${amountA} tokenX + ${amountB ?? "auto"} tokenY | ` +
        `${rangeDesc}${royaltyNote} | La posición LP NFT se guardará en el vault.`,
    };
  }

  // ─── removeLiquidity ────────────────────────────────────────────────────────
  // El LP es un NFT — se usa transfer_nft del vault para sacarlo.
  // El pool devuelve tokenX + tokenY + fees acumulados al worktop → vault.

  async removeLiquidity(params: RemoveLiquidityParams & {
    lpNftId?: string;
  }): Promise<LiquidityResult> {
    const {
      poolAddress,
      lpTokenAddress, // lp_manager NFT resource address
      lpAmount,       // en este caso el NFT ID e.g. "#2#"
      vaultAddress,
      notarizerAddress,
    } = params;

    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";

    // lpAmount se usa como NFT ID para PrecisionPool
    const nftId = (params as any).lpNftId ?? lpAmount;

    if (!nftId) {
      throw new Error(
        "Para Ociswap PrecisionPool remove_liquidity necesitas el ID del NFT de posición LP. " +
        "Usa wallet_balance para encontrarlo — busca tokens del resource del lp_manager."
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
    "transfer_nft_liquidity"
    Address("${poolAddress}")
    Address("${lpTokenAddress}")
    NonFungibleLocalId("${nftId}")
    "ociswap remove liquidity"
    Proof("agent_proof")
;
TAKE_NON_FUNGIBLES_FROM_WORKTOP
    Address("${lpTokenAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${nftId}"))
    Bucket("lp_bucket")
;
CALL_METHOD
    Address("${poolAddress}")
    "remove_liquidity"
    Bucket("lp_bucket")
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

    return {
      manifest,
      description:
        `Ociswap PrecisionPool remove_liquidity: posición NFT ${nftId} → tokenX + tokenY + fees al vault`,
    };
  }
}

// ─── Instancia singleton ──────────────────────────────────────────────────────

let _precisionAdapter: OciswapPrecisionAdapter | null = null;

export function getPrecisionAdapter(gatewayUrl: string): OciswapPrecisionAdapter {
  if (!_precisionAdapter) {
    _precisionAdapter = new OciswapPrecisionAdapter(gatewayUrl);
  }
  return _precisionAdapter;
}
