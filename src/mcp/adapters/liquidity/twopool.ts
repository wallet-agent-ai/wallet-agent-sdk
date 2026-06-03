// ─── TwoPool Liquidity Adapter ─────────────────────────────────────────────────
// Adapter genérico para pools x*y=k de tipo TwoResourcePool en Radix.
// Compatible con:
//   - Caviar Finance  (WeightedPool blueprint)   — package_rdx1pkhxu8zy5t7h3rww6jsftca22e2jdgqpc28rje7lnmkjxxf50zagr7
//   - Ociswap V2      (BasicPool blueprint)       — package_rdx1p5l6dp3slnh9ycd7gk700czwlck9tujn0zpdnd0efw09n2zdnn0lzx
//
// Ambos protocolos comparten la misma firma de métodos:
//   add_liquidity(bucket_a, bucket_b)  → LP tokens + remainder
//   remove_liquidity(lp_bucket)        → token_a + token_b
//
// ─── Cómo obtener la info de un pool ─────────────────────────────────────────
// 1. GET /state/entity/details?addresses=[component_address]
//    Caviar:  state.fields → weights(Map tokenA→0.5, tokenB→0.5), fee, resource_pool
//    Ociswap: state.fields → x_address, y_address, input_fee_rate, liquidity_pool
// 2. GET /state/entity/details?addresses=[resource_pool]&opt_ins={"explicit_metadata":["pool_unit"]}
//    → metadata.items[pool_unit].value.typed.value = LP token address
// ─── IMPORTANTE para el PoolRegistry futuro ──────────────────────────────────
// El component address es donde se llama add_liquidity/remove_liquidity/swap.
// El pool interno (resource_pool / liquidity_pool) es donde van las TXs de swap
// y donde se puede rastrear la liquidez. Son dos entidades distintas.
// ─────────────────────────────────────────────────────────────────────────────
import { KNOWN_POOLS_REGISTRY, getPool, KnownPool } from "../../known-pools.js";


import type {
  LiquidityProvider,
  LiquidityProtocol,
  Pool,
  AddLiquidityParams,
  RemoveLiquidityParams,
  LiquidityResult,
} from "../../types";

// ─── Tipos internos ───────────────────────────────────────────────────────────

export type TwoPoolProtocol = "caviar" | "ociswap";

export interface TwoPoolInfo {
  componentAddress: string;
  tokenAAddress: string;
  tokenBAddress: string;
  symbolA: string;   
  symbolB: string;
  lpTokenAddress: string;
  fee: string;
  protocol: TwoPoolProtocol;
  // Pool interno — para el PoolRegistry y rastreo de TXs
  innerPoolAddress: string;
}


// ─── Helper: obtener info del pool dinámicamente desde el Gateway ─────────────
// Usa el mismo patrón para Caviar y Ociswap — la estructura es equivalente.
export async function fetchPoolInfo(
  componentAddress: string,
  gatewayUrl: string
): Promise<TwoPoolInfo> {

  // ── Helper fetch con timeout 15s ──────────────────────────────────────────
  const fetchWithTimeout = async (url: string, options: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (err: any) {
      if (err.name === "AbortError") throw new Error(`Gateway timeout — no respondió en 15s para ${url}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  // ── Helper resolver symbols ───────────────────────────────────────────────
  // 1. Obtener estado del componente
  const res = await fetchWithTimeout(`${gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: [componentAddress] }),
  });
  const data = await res.json() as any;
  const fields: any[]   = data?.items?.[0]?.details?.state?.fields ?? [];
  const metadata: any[] = data?.items?.[0]?.metadata?.items ?? [];
  const blueprintName: string = data?.items?.[0]?.details?.blueprint_name ?? "";

  const getField = (name: string) => fields.find((f: any) => f.field_name === name);
  const getMeta  = (key: string)  => metadata.find((m: any) => m.key === key)?.value?.typed?.value;

  let tokenAAddress: string;
  let tokenBAddress: string;
  let lpTokenAddress: string;
  let fee: string;
  let innerPoolAddress: string;
  let protocol: TwoPoolProtocol;

  // ── Caviar WeightedPool ───────────────────────────────────────────────────
  if (blueprintName === "WeightedPool") {
    protocol         = "caviar";
    tokenAAddress    = getMeta("resource_x") ?? "";
    tokenBAddress    = getMeta("resource_y") ?? "";
    lpTokenAddress   = getMeta("lp_resource") ?? "";
    innerPoolAddress = getMeta("pool_component") ?? "";
    fee              = getMeta("fee") ?? "0";

 //   const { symbolA, symbolB } = await resolveSymbols(tokenAAddress, tokenBAddress);
const symbolA = tokenAAddress.slice(-8);
const symbolB = tokenBAddress.slice(-8);
    return {
      componentAddress,
      tokenAAddress,
      tokenBAddress,
      symbolA,
      symbolB,
      lpTokenAddress,
      fee,
      protocol,
      innerPoolAddress,
    };
  }

  // ── Ociswap BasicPool ─────────────────────────────────────────────────────
  const isOciswap = !!getField("x_address");

  if (isOciswap) {
    protocol         = "ociswap";
    tokenAAddress    = getField("x_address")?.value ?? "";
    tokenBAddress    = getField("y_address")?.value ?? "";
    fee              = getField("input_fee_rate")?.value ?? "0";
    innerPoolAddress = getField("liquidity_pool")?.value ?? "";
  } else {
    throw new Error(`Unknown pool type for component ${componentAddress} (blueprint: ${blueprintName})`);
  }

  // 2. Obtener LP token del pool interno (solo Ociswap)
  const lpRes = await fetchWithTimeout(`${gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [innerPoolAddress],
      opt_ins: { explicit_metadata: ["pool_unit"] },
    }),
  });
  const lpData = await lpRes.json() as any;
  lpTokenAddress = lpData?.items?.[0]?.metadata?.items
    ?.find((m: any) => m.key === "pool_unit")
    ?.value?.typed?.value ?? "";

  //const { symbolA, symbolB } = await resolveSymbols(tokenAAddress, tokenBAddress);
const symbolA = tokenAAddress.slice(-8);
const symbolB = tokenBAddress.slice(-8);


  return {
    componentAddress,
    tokenAAddress,
    tokenBAddress,
    symbolA,
    symbolB,
    lpTokenAddress,
    fee,
    protocol,
    innerPoolAddress,
  };
}


// ─── Adapter ──────────────────────────────────────────────────────────────────

export class TwoPoolAdapter implements LiquidityProvider {
  readonly protocol: LiquidityProtocol = "ociswap"; // placeholder — se sobreescribe por pool
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  async getPools(): Promise<Pool[]> {
    return KNOWN_POOLS_REGISTRY
      .filter(p => p.protocol === "caviar" || p.protocol === "ociswap")
      .map(p => ({
        poolAddress:    p.address,
        name:           `${p.protocol} pool`,
        tokenAAddress:  p.token0,
        tokenBAddress:  p.token1,
        lpTokenAddress: p.resourcePool ?? "",
        protocol:       p.protocol as LiquidityProtocol,
      }));
  }

  // ─── getPoolInfo ─────────────────────────────────────────────────────────
  // Obtiene info del pool — primero de la caché local, si no del Gateway.

  async getPoolInfo(poolAddress: string): Promise<TwoPoolInfo> {
    const cached = getPool(poolAddress);
    if (cached) return {
      componentAddress: cached.address,
      tokenAAddress:    cached.token0,
      tokenBAddress:    cached.token1,
      symbolA:          cached.token0.slice(-8),
      symbolB:          cached.token1.slice(-8),
      lpTokenAddress:   cached.resourcePool ?? "",
      fee:              (cached.feeRateBps / 10000).toString(),
      protocol:         (cached.protocol === "caviar" || cached.protocol === "caviar_quantaswap" ? "caviar" : "ociswap") as TwoPoolProtocol,
      innerPoolAddress: cached.resourcePool ?? "",
    };
    return fetchPoolInfo(poolAddress, this.gatewayUrl);
  }

  // ─── addLiquidity ─────────────────────────────────────────────────────────
  // Deposita dos tokens en el pool y recibe LP tokens.
  // El pool devuelve el remainder del token en exceso automáticamente.
  //
  // Manifest:
  //   transfer vault → pool tokenA amountA (proof_a)
  //   transfer vault → pool tokenB amountB (proof_b)
  //   TAKE_ALL tokenA → bucket_a
  //   TAKE_ALL tokenB → bucket_b
  //   CALL pool "add_liquidity" bucket_a bucket_b
  //   deposit_any vault ENTIRE_WORKTOP

  async addLiquidity(params: AddLiquidityParams): Promise<LiquidityResult> {
    const {
      poolAddress,
      tokenAAddress,
      amountA,
      tokenBAddress,
      amountB,
      vaultAddress,
      notarizerAddress,
    } = params;

    // Obtener badge info del notarizador — viene en los parámetros del vault
    // Los placeholders AGENT_BADGE_RESOURCE_ADDRESS y AGENT_BADGE_LOCAL_ID
    // se reemplazan en el tool handler igual que en DefiPlaza.
    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";

    if (!amountB || parseFloat(amountB) <= 0) {
      throw new Error(
        `TwoPool add_liquidity requiere ambos tokens. Proporciona tokenA (${amountA}) y tokenB con su amount.`
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
CLONE_PROOF
    Proof("agent_proof")
    Proof("proof_a")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_liquidity"
    Address("${poolAddress}")
    Decimal("${amountA}")
    Address("${tokenAAddress}")
    "add liquidity token A"
    Proof("proof_a")
;
CALL_METHOD
    Address("${vaultAddress}")
    "transfer_liquidity"
    Address("${poolAddress}")
    Decimal("${amountB}")
    Address("${tokenBAddress}")
    "add liquidity token B"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenAAddress}")
    Bucket("bucket_a")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenBAddress}")
    Bucket("bucket_b")
;
CALL_METHOD
    Address("${poolAddress}")
    "add_liquidity"
    Bucket("bucket_a")
    Bucket("bucket_b")
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

    const pool = getPool(poolAddress);
    const protocolName = pool?.protocol ?? "twopool";

    return {
      manifest,
      description: `${protocolName} add_liquidity: ${amountA} tokenA + ${amountB} tokenB → LP tokens al vault`,
    };
  }

  // ─── removeLiquidity ──────────────────────────────────────────────────────
  // Quema LP tokens y recibe los dos tokens subyacentes.
  //
  // Manifest:
  //   transfer vault → pool lpAmount lpToken (agent_proof)
  //   TAKE_ALL lpToken → lp_bucket
  //   CALL pool "remove_liquidity" lp_bucket
  //   deposit_any vault ENTIRE_WORKTOP

  async removeLiquidity(params: RemoveLiquidityParams): Promise<LiquidityResult> {
    const {
      poolAddress,
      lpTokenAddress,
      lpAmount,
      vaultAddress,
      notarizerAddress,
    } = params;

    const BADGE_PLACEHOLDER_RESOURCE = "AGENT_BADGE_RESOURCE_ADDRESS";
    const BADGE_PLACEHOLDER_ID       = "AGENT_BADGE_LOCAL_ID";

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
    Address("${poolAddress}")
    Decimal("${lpAmount}")
    Address("${lpTokenAddress}")
    "remove liquidity"
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

    const pool = getPool(poolAddress);
    const protocolName = pool?.protocol ?? "twopool";

    return {
      manifest,
      description: `${protocolName} remove_liquidity: ${lpAmount} LP tokens → tokenA + tokenB al vault`,
    };
  }
}

// ─── Instancia singleton ──────────────────────────────────────────────────────

let _twopoolAdapter: TwoPoolAdapter | null = null;

export function getTwoPoolAdapter(gatewayUrl: string): TwoPoolAdapter {
  if (!_twopoolAdapter) {
    _twopoolAdapter = new TwoPoolAdapter(gatewayUrl);
  }
  return _twopoolAdapter;
}
