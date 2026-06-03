// ─── DefiPlaza (RadixPlaza) Liquidity Adapter ─────────────────────────────────
// Implementa LiquidityProvider para DefiPlaza PlazaPair en Radix.
//
// DefiPlaza usa un modelo de un token a la vez por lado (base/quote).
// Cada par tiene su propio PlazaPair component con estado de shortage.
//
// Casos de add_liquidity:
//   1. Equilibrium + depositas cualquier lado    → add_liquidity(bucket, None)
//   2. BaseShortage + depositas base             → add_liquidity(bucket, None)
//   3. QuoteShortage + depositas quote           → add_liquidity(bucket, None)
//   4. BaseShortage + depositas quote            → add_liquidity(bucket_quote, Some(bucket_base))
//   5. QuoteShortage + depositas base            → add_liquidity(bucket_base_en_shortage=quote... espera
//      En realidad: shortage indica qué lado falta. Si depositas el lado contrario
//      al que está en shortage necesitas co-token. El input va en orden:
//      primero el token en shortage, luego el co-token como Some().
//
// Remove_liquidity:
//   remove_liquidity(lp_bucket, is_quote: bool)
//   is_quote = false → base LP, is_quote = true → quote LP

import type {
  LiquidityProvider,
  LiquidityProtocol,
  Pool,
  AddLiquidityParams,
  RemoveLiquidityParams,
  LiquidityResult,
} from "../../types";

// ─── Tipos internos ───────────────────────────────────────────────────────────

type Shortage = "Equilibrium" | "BaseShortage" | "QuoteShortage";

interface PairState {
  pairAddress: string;
  baseAddress: string;
  quoteAddress: string;
  baseLpAddress: string;
  quoteLpAddress: string;
  shortage: Shortage;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class DefiPlazaAdapter implements LiquidityProvider {
  readonly protocol: LiquidityProtocol = "defiPlaza";
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  // ─── getPools ──────────────────────────────────────────────────────────────
  // DefiPlaza no tiene un endpoint de pools — los pools se pasan explícitamente.
  // Devolvemos array vacío; el agente trabaja con pair addresses directas.

  async getPools(): Promise<Pool[]> {
    return [];
  }

  // ─── getPairState ──────────────────────────────────────────────────────────
  // Consulta el estado del PlazaPair para obtener shortage, tokens y LP addresses.

async getPairState(pairAddress: string): Promise<PairState> {
    
const response = await fetch(`${this.gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [pairAddress],
      aggregation_level: "Global",
    }),
  });

  const data = await response.json() as any;
  const stateFields = data?.items?.[0]?.details?.state?.fields || [];  

  const getField = (name: string) =>
    stateFields.find((f: any) => f.field_name === name);

    const baseAddress   = getField("base_address")?.value ?? "";
    const quoteAddress  = getField("quote_address")?.value ?? "";
    const basePool      = getField("base_pool")?.value ?? "";
    const quotePool     = getField("quote_pool")?.value ?? "";
    const shortageField = getField("state")?.fields?.find((f: any) => f.field_name === "shortage");
    const shortage      = (shortageField?.variant_name ?? "Equilibrium") as Shortage;

    // Obtener LP addresses desde los pools nativos
    const [baseLpAddress, quoteLpAddress] = await this.getLpAddresses(basePool, quotePool);

    return { pairAddress, baseAddress, quoteAddress, baseLpAddress, quoteLpAddress, shortage };
  }

  // ─── getLpAddresses ────────────────────────────────────────────────────────
  // Los LP tokens son pool units del TwoResourcePool nativo de Radix.
  // Se obtienen consultando el estado de cada pool.

private async getLpAddresses(basePool: string, quotePool: string): Promise<[string, string]> {
  const response = await fetch(`${this.gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [basePool, quotePool],
      aggregation_level: "Global",
      opt_ins: { explicit_metadata: ["pool_unit"] },
    }),
  });

  const data = await response.json() as any;
  const items = data?.items || [];

  const getLp = (poolAddress: string): string => {
    const item = items.find((i: any) => i.address === poolAddress);
    return item?.metadata?.items
      ?.find((m: any) => m.key === "pool_unit")
      ?.value?.typed?.value ?? "";
  };

  return [getLp(basePool), getLp(quotePool)];
}


  // ─── addLiquidity ──────────────────────────────────────────────────────────

  async addLiquidity(params: AddLiquidityParams): Promise<LiquidityResult> {
    const {
      poolAddress: pairAddress,
      tokenAAddress,
      amountA,
      tokenBAddress,
      amountB,
      vaultAddress,
      notarizerAddress,
    } = params;

    // Obtener estado del par
    const state = await this.getPairState(pairAddress);
    const { baseAddress, quoteAddress, shortage } = state;

    // Determinar si el token A es base o quote
    const tokenAIsBase  = tokenAAddress === baseAddress;
    const tokenAIsQuote = tokenAAddress === quoteAddress;
    const tokenBIsBase  = tokenBAddress === baseAddress;
    const tokenBIsQuote = tokenBAddress === quoteAddress;

    if (!tokenAIsBase && !tokenAIsQuote) {
      throw new Error(`Token ${tokenAAddress} no pertenece a este par DefiPlaza`);
    }

    // Determinar el caso de add_liquidity
    const depositingBase  = tokenAIsBase;
    const depositingQuote = tokenAIsQuote;
console.log("needsCoToken will be:", (shortage === "BaseShortage" && depositingBase) || (shortage === "QuoteShortage" && depositingQuote));


    // ¿Necesita co-token?
    // Si depositas el lado en shortage → necesitas co-token del lado opuesto
    // Si depositas el lado opuesto al shortage → depositas solo
    const needsCoToken =
      (shortage === "BaseShortage"  && depositingBase) ||
      (shortage === "QuoteShortage" && depositingQuote);

    // Si necesita co-token pero no se proporcionó amount B
    if (needsCoToken && (!tokenBAddress || !amountB || parseFloat(amountB) <= 0)) {
      const shortSide   = shortage === "BaseShortage" ? "base" : "quote";
      const neededToken = shortage === "BaseShortage" ? baseAddress : quoteAddress;
      throw new Error(
        `Estás depositando en el lado opuesto al ${shortage} — necesitas proporcionar también el token en shortage (${shortSide}) como co-token. ` +
        `Añade tokenB: ${neededToken} con su amount.`
      );
    }

    let manifest: string;
    let description: string;

    if (!needsCoToken) {
      // ─── Caso simple: un solo token ─────────────────────────────────────
      manifest = this.buildAddSingleManifest({
        pairAddress,
        tokenAddress: tokenAAddress,
        amount: amountA,
        vaultAddress,
        notarizerAddress,
      });

      description = `Add liquidity DefiPlaza: ${amountA} ${depositingBase ? "base" : "quote"} → LP tokens`;

    } else {

      // ─── Caso shortage: dos tokens ──────────────────────────────────────
      // El token en shortage va en bucket principal, el co-token como Some()
      // BaseShortage + depositas quote: base (shortage) primero, quote como co-token
      // QuoteShortage + depositas base: quote (shortage) primero, base como co-token

      const [shortageToken, shortageAmount, coToken, coAmount] =
        shortage === "BaseShortage"
          ? [baseAddress,  amountB!, quoteAddress, amountA]  // base en shortage, quote como co
          : [quoteAddress, amountB!, baseAddress,  amountA]; // quote en shortage, base como co

      // Verificar que el co-token es el correcto
      const coTokenProvided = shortage === "QuoteShortage" ? tokenBIsBase : tokenBIsQuote;
      if (!coTokenProvided) {
        throw new Error(`Co-token incorrecto para ${shortage}`);
      }

      manifest = this.buildAddWithCoManifest({
        pairAddress,
        shortageTokenAddress: shortageToken,
        shortageAmount,
        coTokenAddress: coToken,
        coAmount,
        vaultAddress,
        notarizerAddress,
      });
      description = `Add liquidity DefiPlaza (${shortage}): ${shortageAmount} shortage + ${coAmount} co-token → LP tokens`;
    }

    return { manifest, description };
  }

  // ─── removeLiquidity ───────────────────────────────────────────────────────

  async removeLiquidity(params: RemoveLiquidityParams): Promise<LiquidityResult> {
    const { poolAddress: pairAddress, lpTokenAddress, lpAmount, vaultAddress, notarizerAddress } = params;

    const state = await this.getPairState(pairAddress);
    const isQuote = lpTokenAddress === state.quoteLpAddress;

    if (lpTokenAddress !== state.baseLpAddress && lpTokenAddress !== state.quoteLpAddress) {
      throw new Error(
        `LP token ${lpTokenAddress} no pertenece a este par DefiPlaza. ` +
        `Base LP: ${state.baseLpAddress}, Quote LP: ${state.quoteLpAddress}`
      );
    }

    const manifest = this.buildRemoveManifest({
      pairAddress,
      lpTokenAddress,
      lpAmount,
      isQuote,
      vaultAddress,
      notarizerAddress,
    });

    const description = `Remove liquidity DefiPlaza: ${lpAmount} ${isQuote ? "quote" : "base"} LP → tokens al vault`;

    return { manifest, description };
  }

  // ─── Manifest builders ────────────────────────────────────────────────────

  private buildAddSingleManifest(p: {
    pairAddress: string;
    tokenAddress: string;
    amount: string;
    vaultAddress: string;
    notarizerAddress: string;
  }): string {
    return `CALL_METHOD
    Address("${p.notarizerAddress}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${p.notarizerAddress}")
    "create_proof_of_non_fungibles"
    Address("AGENT_BADGE_RESOURCE_ADDRESS")
    Array<NonFungibleLocalId>(NonFungibleLocalId("AGENT_BADGE_LOCAL_ID"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "transfer_liquidity"
    Address("${p.pairAddress}")
    Decimal("${p.amount}")
    Address("${p.tokenAddress}")
    "add liquidity defiplaza"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${p.tokenAddress}")
    Bucket("token_bucket")
;
CALL_METHOD
    Address("${p.pairAddress}")
    "add_liquidity"
    Bucket("token_bucket")
    None
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;
  }
private buildAddWithCoManifest(p: {
  pairAddress: string;
  shortageTokenAddress: string;
  shortageAmount: string;
  coTokenAddress: string;
  coAmount: string;
  vaultAddress: string;
  notarizerAddress: string;
}): string {
  return `CALL_METHOD
    Address("${p.notarizerAddress}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${p.notarizerAddress}")
    "create_proof_of_non_fungibles"
    Address("AGENT_BADGE_RESOURCE_ADDRESS")
    Array<NonFungibleLocalId>(NonFungibleLocalId("AGENT_BADGE_LOCAL_ID"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CLONE_PROOF
    Proof("agent_proof")
    Proof("proof_shortage")
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "transfer_liquidity"
    Address("${p.pairAddress}")
    Decimal("${p.shortageAmount}")
    Address("${p.shortageTokenAddress}")
    "add liquidity defiplaza shortage"
    Proof("proof_shortage")
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "transfer_liquidity"
    Address("${p.pairAddress}")
    Decimal("${p.coAmount}")
    Address("${p.coTokenAddress}")
    "add liquidity defiplaza co-token"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${p.shortageTokenAddress}")
    Bucket("shortage_bucket")
;
TAKE_ALL_FROM_WORKTOP
    Address("${p.coTokenAddress}")
    Bucket("co_bucket")
;
CALL_METHOD
    Address("${p.pairAddress}")
    "add_liquidity"
    Bucket("shortage_bucket")
    Some(Bucket("co_bucket"))
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;
}

  private buildRemoveManifest(p: {
    pairAddress: string;
    lpTokenAddress: string;
    lpAmount: string;
    isQuote: boolean;
    vaultAddress: string;
    notarizerAddress: string;
  }): string {
    return `CALL_METHOD
    Address("${p.notarizerAddress}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${p.notarizerAddress}")
    "create_proof_of_non_fungibles"
    Address("AGENT_BADGE_RESOURCE_ADDRESS")
    Array<NonFungibleLocalId>(NonFungibleLocalId("AGENT_BADGE_LOCAL_ID"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "transfer_liquidity"
    Address("${p.pairAddress}")
    Decimal("${p.lpAmount}")
    Address("${p.lpTokenAddress}")
    "remove liquidity defiplaza"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${p.lpTokenAddress}")
    Bucket("lp_bucket")
;
CALL_METHOD
    Address("${p.pairAddress}")
    "remove_liquidity"
    Bucket("lp_bucket")
    ${p.isQuote}
;
CALL_METHOD
    Address("${p.vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;
  }
}
