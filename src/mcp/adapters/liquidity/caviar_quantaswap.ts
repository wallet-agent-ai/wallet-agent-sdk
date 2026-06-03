// ─── Caviar QuantaSwap Adapter ────────────────────────────────────────────────
// Implementa add_liquidity y remove_liquidity para Caviar QuantaSwap.
// Concentrated liquidity con bins — similar a Ociswap PrecisionPool pero
// la liquidez se distribuye en múltiples bins en una sola TX.
//
// Package mainnet: package_rdx1p4r9rkp0cq67wmlve544zgy0l45mswn6h798qdqm47x4762h383wa3
// Blueprint: QuantaSwap
//
// Firma de add_liquidity:
//   add_liquidity(
//     bucket_x: Bucket,
//     bucket_y: Bucket,
//     bins: Array<Tuple(bin_id: U32, amount_x: Decimal, amount_y: Decimal)>
//   )
//   → devuelve NFT de posición LP (liquidity_receipt)
//
// Firma de remove_liquidity:
//   remove_liquidity(receipt_bucket: Bucket)
//   → devuelve token_x + token_y
//
// ─── Orden de tokens ──────────────────────────────────────────────────────────
// Caviar QuantaSwap define X e Y internamente — NO siempre coincide con el
// orden en que el usuario pasa los tokens. El adapter detecta el orden real
// comparando tokenAAddress con poolInfo.tokenXAddress (obtenido del Gateway
// leyendo los vaults tokens_x / tokens_y del contrato).
// Si están invertidos, se intercambian amounts y addresses antes de construir
// el manifest y calcular los bins.
//
// ─── Royalty fee ─────────────────────────────────────────────────────────────
// transfer_liquidity cobra 1 XRD de royalty por llamada.
// Si el token es XRD, se resta 1 XRD del amount efectivo para que los bins
// reciban exactamente lo que llega al worktop tras el royalty.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  LiquidityProvider,
  LiquidityProtocol,
  Pool,
  AddLiquidityParams,
  RemoveLiquidityParams,
  LiquidityResult,
} from "../../types";
import { KNOWN_POOLS_REGISTRY, getPool,getTokenDivisibility } from "../../known-pools.js";

// ─── Constantes ───────────────────────────────────────────────────────────────

const XRD_ADDRESS = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
const TRANSFER_LIQUIDITY_ROYALTY_XRD = 1; // fee fijo en XRD por llamada a transfer_liquidity

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface QuantaSwapInfo {
  componentAddress: string;
  tokenXAddress: string;  // X según el contrato (tokens_x vault)
  tokenYAddress: string;  // Y según el contrato (tokens_y vault)
  lpReceiptAddress: string;
  binSpan: number;
  activeBin: number;
}

export interface BinAllocation {
  binId: number;
  amountX: string;
  amountY: string;
}

// ─── Helper: obtener info del pool dinámicamente ──────────────────────────────

export async function fetchQuantaSwapInfo(
  componentAddress: string,
  gatewayUrl: string
): Promise<QuantaSwapInfo> {
  const res = await fetch(`${gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: [componentAddress] }),
  });
  const data = await res.json() as any;
  const fields: any[] = data?.items?.[0]?.details?.state?.fields ?? [];

  console.log("=== QuantaSwap fields ===");
  fields.forEach(f => console.log(f.field_name, ":", f.value ?? f.kind));

  const getField = (name: string) => fields.find((f: any) => f.field_name === name);

  const binSpan = parseInt(getField("bin_span")?.value ?? "50");

  const tickIndex = getField("tick_index");
  const currentField = tickIndex?.fields?.find((f: any) => f.field_name === "current");
  const activeBin = currentField?.variant_name === "Some"
    ? parseInt(currentField?.fields?.[0]?.fields?.[0]?.value ?? "0")
    : 0;

  const lpReceipt = getField("liquidity_receipt_manager")?.value ?? "";

  const xVault = getField("tokens_x")?.value ?? "";
  const yVault = getField("tokens_y")?.value ?? "";

  const vaultRes = await fetch(`${gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: [xVault, yVault] }),
  });
  const vaultData = await vaultRes.json() as any;
  const vaultItems = vaultData?.items ?? [];

  const getVaultResource = (vaultAddress: string): string => {
    const item = vaultItems.find((i: any) => i.address === vaultAddress);
    return item?.details?.resource_address ?? "";
  };

  const result = {
    componentAddress,
    tokenXAddress:    getVaultResource(xVault),  // X real del contrato
    tokenYAddress:    getVaultResource(yVault),  // Y real del contrato
    lpReceiptAddress: lpReceipt,
    binSpan,
    activeBin,
  };

  console.log("=== QuantaSwap poolInfo ===", JSON.stringify(result));

  return result;
}

// ─── Helper: distribución triangular ponderada ────────────────────────────────
// amountX → bins superiores al activo (solo token X)
// amountY → bins inferiores al activo (solo token Y)
// bin activo → ambos tokens con peso máximo
export function calculateBinAllocations(
  activeBin: number,
  binSpan: number,
  amountX: number,
  amountY: number,
  binsAbove: number = 30,
  binsBelow: number = 30,
  divisibilityX: number = 8,
  divisibilityY: number = 8,
): BinAllocation[] {
  const allocations: BinAllocation[] = [];

  // Mínimo aceptable por bin según divisibility del token
   const minPerBinX = divisibilityX <= 6 ? 0.01 : Math.pow(10, -divisibilityX);
   const minPerBinY = divisibilityY <= 6 ? 0.01 : Math.pow(10, -divisibilityY);

  // Ajustar número de bins para que cada bin reciba al menos el mínimo
  const effectiveBinsAbove = amountX > 0
    ? Math.min(binsAbove, Math.max(1, Math.floor(amountX / minPerBinX / 2)))
    : binsAbove;
  const effectiveBinsBelow = amountY > 0
    ? Math.min(binsBelow, Math.max(1, Math.floor(amountY / minPerBinY / 2)))
    : binsBelow;

  const sumWeightsAbove = (effectiveBinsAbove * (effectiveBinsAbove + 1)) / 2;
  const sumWeightsBelow = (effectiveBinsBelow * (effectiveBinsBelow + 1)) / 2;
  const totalWeightX = sumWeightsAbove + effectiveBinsAbove;
  const totalWeightY = sumWeightsBelow + effectiveBinsBelow;

  // Helper para formatear respetando divisibility
  const fmtX = (n: number) => n.toFixed(divisibilityX);
  const fmtY = (n: number) => n.toFixed(divisibilityY);

  // Bin activo — ambos tokens, peso máximo
  allocations.push({
    binId:   activeBin,
    amountX: fmtX(amountX * (effectiveBinsAbove / totalWeightX)),
    amountY: fmtY(amountY * (effectiveBinsBelow / totalWeightY)),
  });

  // Bins superiores — solo token X
  for (let i = 1; i <= effectiveBinsAbove; i++) {
    const weight = (effectiveBinsAbove + 1 - i) / totalWeightX;
    allocations.push({
      binId:   activeBin + i * binSpan,
      amountX: fmtX(amountX * weight),
      amountY: "0",
    });
  }

  // Bins inferiores — solo token Y
  for (let i = 1; i <= effectiveBinsBelow; i++) {
    const weight = (effectiveBinsBelow + 1 - i) / totalWeightY;
    allocations.push({
      binId:   activeBin - i * binSpan,
      amountX: "0",
      amountY: fmtY(amountY * weight),
    });
  }

  return allocations;
}



// ─── Adapter ──────────────────────────────────────────────────────────────────

export class CaviarQuantaSwapAdapter implements LiquidityProvider {
  readonly protocol: LiquidityProtocol = "caviar_quantaswap" as LiquidityProtocol;
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  async getPools(): Promise<Pool[]> {
    return KNOWN_POOLS_REGISTRY
      .filter(p => p.protocol === "caviar_quantaswap")
      .map(p => ({
        poolAddress:    p.address,
        name:           "Caviar QuantaSwap",
        tokenAAddress:  p.token0,
        tokenBAddress:  p.token1,
        lpTokenAddress: p.ticksKvs ?? "",
        protocol:       "caviar_quantaswap" as LiquidityProtocol,
      }));
  }

  async getPoolInfo(poolAddress: string): Promise<QuantaSwapInfo> {
    return fetchQuantaSwapInfo(poolAddress, this.gatewayUrl);
  }

  // ─── addLiquidity ───────────────────────────────────────────────────────────
  //
  // PASO 1 — Detectar orden real de tokens del contrato
  //   poolInfo.tokenXAddress = X según el contrato (tokens_x vault del Gateway)
  //   Si tokenAAddress != poolInfo.tokenXAddress → los tokens están invertidos
  //
  // PASO 2 — Reordenar amounts en orden X/Y del contrato
  //
  // PASO 3 — Descontar royalty XRD si aplica
  //   transfer_liquidity cobra 1 XRD de royalty por llamada.
  //   Si el token es XRD, restamos 1 XRD del effective amount.
  //
  // PASO 4 — calculateBinAllocations con amounts en orden correcto X/Y
  //
  // PASO 5 — Manifest: transfer_liquidity con amounts originales (el royalty
  //   lo cobra el vault), TAKE_ALL_FROM_WORKTOP recoge lo que llega,
  //   add_liquidity recibe bucket_x y bucket_y en orden X/Y del contrato.

  async addLiquidity(params: AddLiquidityParams & {
    bins?: BinAllocation[];
    binsAbove?: number;
    binsBelow?: number;
  }): Promise<LiquidityResult> {
    const {
      poolAddress,
      tokenAAddress,
      amountA,
      tokenBAddress,
      amountB,
      vaultAddress,
      notarizerAddress,
    } = params;

    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";

    // ── PASO 1: Obtener orden real del contrato ──
    const poolInfo = await this.getPoolInfo(poolAddress);

    const tokenAisX = tokenAAddress === poolInfo.tokenXAddress;

    console.log(`=== Token order: tokenA is ${tokenAisX ? "X" : "Y"} (contractX=${poolInfo.tokenXAddress}) ===`);

    // ── PASO 2: Reasignar en orden X/Y del contrato ──
    const rawAmountX = tokenAisX ? parseFloat(amountA)         : parseFloat(amountB ?? "0");
    const rawAmountY = tokenAisX ? parseFloat(amountB ?? "0")  : parseFloat(amountA);
    const tokenX     = tokenAisX ? tokenAAddress               : tokenBAddress;
    const tokenY     = tokenAisX ? tokenBAddress               : tokenAAddress;
    const transferRawX = tokenAisX ? amountA                   : (amountB ?? "0");
    const transferRawY = tokenAisX ? (amountB ?? "0")          : amountA;

    // ── PASO 3: Descontar royalty XRD ──
    const effectiveAmountX = tokenX === XRD_ADDRESS
      ? rawAmountX - TRANSFER_LIQUIDITY_ROYALTY_XRD
      : rawAmountX;

    const effectiveAmountY = tokenY === XRD_ADDRESS
      ? rawAmountY - TRANSFER_LIQUIDITY_ROYALTY_XRD
      : rawAmountY;

    if (effectiveAmountX <= 0) {
      throw new Error(
        `El amount de tokenX (${rawAmountX} XRD) no cubre el royalty fee de ${TRANSFER_LIQUIDITY_ROYALTY_XRD} XRD.`
      );
    }
    if (effectiveAmountY <= 0) {
      throw new Error(
        `El amount de tokenY (${rawAmountY} XRD) no cubre el royalty fee de ${TRANSFER_LIQUIDITY_ROYALTY_XRD} XRD.`
      );
    }

    // ── PASO 4: Calcular bins con amounts efectivos en orden X/Y ──
    let bins: BinAllocation[];
    let usingDefaultDistribution = false;

    if ((params as any).bins && (params as any).bins.length > 0) {
      bins = (params as any).bins;
    } else {
      usingDefaultDistribution = true;
      const divX = getTokenDivisibility(tokenX);
      const divY = getTokenDivisibility(tokenY);
      bins = calculateBinAllocations(
        poolInfo.activeBin,
        poolInfo.binSpan,
        effectiveAmountX,
        effectiveAmountY,
        (params as any).binsAbove ?? 30,
        (params as any).binsBelow ?? 30,
        divX,
        divY,
      );
    }

    // Filtrar bins con binId negativo o sin liquidez
    const binsManifest = bins
      .filter(b => (parseFloat(b.amountX) > 0 || parseFloat(b.amountY) > 0) && b.binId > 0)
      .map(b =>
        `        Tuple(\n            ${b.binId}u32,\n            Decimal("${b.amountX}"),\n            Decimal("${b.amountY}")\n        )`
      )
      .join(",\n");

    // ── PASO 5: Manifest — transfer en orden X primero, Y segundo ──
    // bucket_x = tokenX del contrato, bucket_y = tokenY del contrato
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
    Decimal("${transferRawX}")
    Address("${tokenX}")
    "caviar quantaswap add liquidity X"
    Proof("proof_x")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_liquidity"
    Address("${poolAddress}")
    Decimal("${transferRawY}")
    Address("${tokenY}")
    "caviar quantaswap add liquidity Y"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenX}")
    Bucket("bucket_x")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenY}")
    Bucket("bucket_y")
;
CALL_METHOD
    Address("${poolAddress}")
    "add_liquidity"
    Bucket("bucket_x")
    Bucket("bucket_y")
    Array<Tuple>(
${binsManifest}
    )
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

    const distDesc = usingDefaultDistribution
      ? `distribución triangular automática ±30 bins (bin activo: ${poolInfo.activeBin})`
      : `${bins.length} bins custom`;

    const orderNote = tokenAisX ? "" : " | tokens invertidos detectados y corregidos";
    const royaltyNote = (tokenX === XRD_ADDRESS || tokenY === XRD_ADDRESS)
      ? ` | royalty ${TRANSFER_LIQUIDITY_ROYALTY_XRD} XRD descontado`
      : "";

    console.log("=== BINS Y ===", bins.filter((b: any) => parseFloat(b.amountY) > 0).map((b: any) => `${b.binId}:${b.amountY}`).join(", "));

    return {
      manifest,
      description:
        `Caviar QuantaSwap add_liquidity: ${effectiveAmountX.toFixed(8)} tokenX + ${effectiveAmountY.toFixed(8)} tokenY | ` +
        `${distDesc}${orderNote}${royaltyNote} | El recibo LP NFT se guardará en el vault.`,
    };
  }

  // ─── removeLiquidity ────────────────────────────────────────────────────────

  async removeLiquidity(params: RemoveLiquidityParams & {
    lpNftId?: string;
  }): Promise<LiquidityResult> {
    const {
      poolAddress,
      lpTokenAddress,
      lpAmount,
      vaultAddress,
      notarizerAddress,
    } = params;

    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";

    const nftId = (params as any).lpNftId ?? lpAmount;

    if (!nftId) {
      throw new Error(
        "Para Caviar QuantaSwap remove_liquidity necesitas el ID del NFT de recibo LP. " +
        "Usa wallet_balance para encontrarlo."
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
    "caviar quantaswap remove liquidity"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${lpTokenAddress}")
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
        `Caviar QuantaSwap remove_liquidity: recibo NFT ${nftId} → tokenX + tokenY al vault`,
    };
  }
}

// ─── Instancia singleton ──────────────────────────────────────────────────────

let _quantaSwapAdapter: CaviarQuantaSwapAdapter | null = null;

export function getQuantaSwapAdapter(gatewayUrl: string): CaviarQuantaSwapAdapter {
  if (!_quantaSwapAdapter) {
    _quantaSwapAdapter = new CaviarQuantaSwapAdapter(gatewayUrl);
  }
  return _quantaSwapAdapter;
}
