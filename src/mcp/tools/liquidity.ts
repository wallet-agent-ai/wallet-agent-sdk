import type { AgentTool } from "../../tools/LangChainTools";
import { getAdapter, getSupportedProtocols } from "../adapters/liquidity/registry";
import { DefiPlazaAdapter } from "../adapters/liquidity/defiplaza";
import { fetchPoolInfo } from "../adapters/liquidity/twopool";
import { getLsuPoolAdapter, LSU_POOL_ADDRESS, LSULP_RESOURCE, CREDIT_RECEIPT_RESOURCE } from "../adapters/liquidity/caviar_lsupool";
import type { LiquidityProtocol } from "../types";
import { safeDecimal,safeDecimalCeil } from "../../tools/utils.js";
import { KNOWN_POOLS_REGISTRY, resolveTokenAddress, resolveTokenSymbol } from "../known-pools.js";
import { WEFT_SUPPORTED_ADDRESSES } from "../adapters/lending/weft.js";
import { resolvePositions } from "../utils.js";


// ─── wallet_get_pair_state ────────────────────────────────────────────────────
// Consulta el estado de un par DefiPlaza — shortage, tokens, LP addresses.

export function createGetPairStateTool(wallet: any): AgentTool {
  return {
    name: "wallet_get_pair_state",
    description: `Get the current state of a DefiPlaza PlazaPair.
ALWAYS call this before adding liquidity to a DefiPlaza pair.
Returns: shortage status, base/quote token addresses, base/quote LP token addresses.

SHORTAGE RULES:
- QuoteShortage = quote token is missing. Deposit BASE alone OR deposit QUOTE with BASE as co-token.
- BaseShortage  = base token is missing.  Deposit QUOTE alone OR deposit BASE with QUOTE as co-token.
- Equilibrium   = balanced. Deposit either token alone.

SIMPLE RULE: deposit the token OPPOSITE to the shortage → no co-token needed.`,
    parameters: {
      type: "object",
      properties: {
        pairAddress: {
          type: "string",
          description: "Component address of the DefiPlaza PlazaPair",
        },
      },
      required: ["pairAddress"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { pairAddress: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const adapter = new DefiPlazaAdapter(gatewayUrl);
        const state = await adapter.getPairState(p.pairAddress);
        return JSON.stringify({
          success: true,
          ...state,
          message: `Pair state: ${state.shortage}. Base: ${state.baseAddress} | Quote: ${state.quoteAddress}`,
        });
      } catch (error) {
        return JSON.stringify({ success: false, error: `${error}` });
      }
    },
  };
}

// ─── wallet_get_pool_info ─────────────────────────────────────────────────────
// Consulta info de un TwoPool (Caviar WeightedPool o Ociswap BasicPool).
// El LLM DEBE llamar esto antes de add_liquidity para saber qué tokens necesita.

export function createGetPoolInfoTool(wallet: any): AgentTool {
  return {
    name: "wallet_get_pool_info",
    description: `Get info about a TwoPool (Caviar WeightedPool or Ociswap BasicPool).
ALWAYS call this before adding liquidity to a caviar or ociswap pool.
Returns: tokenAAddress, tokenBAddress, lpTokenAddress, fee, protocol.
Use the returned addresses for add_liquidity and remove_liquidity.
Both tokens are required for add_liquidity in equal value ratio.`,
    parameters: {
      type: "object",
      properties: {
        poolAddress: {
          type: "string",
          description: "Component address of the Caviar or Ociswap pool",
        },
      },
      required: ["poolAddress"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { poolAddress: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const info = await fetchPoolInfo(p.poolAddress, gatewayUrl);
        return JSON.stringify({
          success: true,
          ...info,
          message:
 `Pool ${info.protocol} found. ` +
  `Token A address: ${info.tokenAAddress} | ` +
  `Token B address: ${info.tokenBAddress} | ` +
  `LP token: ${info.lpTokenAddress} | fee: ${info.fee}. ` +
  `To add liquidity you need BOTH tokens. ` +
  `Compare these addresses with the ones in wallet_balance resources array to identify which tokens they are and how much you have. ` +
  `Then call wallet_add_liquidity with the correct amounts for each address.`,


        });
      } catch (error) {
        return JSON.stringify({ success: false, error: `${error}` });
      }
    },
  };
}

// ─── wallet_add_liquidity ─────────────────────────────────────────────────────

// ─── wallet_get_pool_ratio ────────────────────────────────────────────────────
// Calcula cuánto del segundo token necesitas dado el amount del primero.
// Cubre: caviar, ociswap, ociswap_precision, caviar_quantaswap, defiPlaza.
//
// TwoPool        → ratio = reservaB / reservaA (reservas reales del Gateway)
// PrecisionPool  → precio = price_sqrt²
// QuantaSwap     → precio = 1.0005^(activeBin - 27000)
// DefiPlaza      → precio de las reservas del basePool/quotePool nativo

export function createGetPoolRatioTool(wallet: any): AgentTool {
  return {
    name: "wallet_get_pool_ratio",
    description: `Calculate how much of token B you need given an amount of token A for any liquidity pool.
MANDATORY: Call this before wallet_add_liquidity for ANY pool when the user only specifies one token amount.
Works for: caviar, ociswap, ociswap_precision, caviar_quantaswap, defiPlaza.
Returns: both token addresses, calculated amount of the second token, and the exact wallet_add_liquidity call to make.
After this tool responds, call wallet_add_liquidity directly with the parameters in the message — no further calculation needed.`,
    parameters: {
      type: "object",
      properties: {
        poolAddress: {
          type: "string",
          description: "Component address of the pool",
        },
        protocol: {
          type: "string",
          description: "Protocol: caviar, ociswap, ociswap_precision, caviar_quantaswap, or defiPlaza",
        },
        knownTokenAddress: {
          type: "string",
          description: "Resource address of the token the user specified",
        },
        knownAmount: {
          type: "string",
          description: "Amount of the token the user specified as a plain number string",
        },
      },
      required: ["poolAddress", "protocol", "knownTokenAddress", "knownAmount"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as {
        poolAddress: string;
        protocol: string;
        knownTokenAddress: string;
        knownAmount: string;
      };

      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const knownAmount = parseFloat(p.knownAmount);

        // ── Helper: leer reservas de un pool nativo Radix ──────────────────
const readPoolReserves = async (poolAddr: string): Promise<{ addr: string; reserve: number }[]> => {
  const res = await fetch(`${gatewayUrl}/state/entity/details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: [poolAddr], aggregation_level: "Vault" }),
  });
  const data = await res.json() as any;
  const fungibles = data?.items?.[0]?.fungible_resources?.items ?? [];
  return fungibles.map((f: any) => ({
    addr: f.resource_address,
    reserve: parseFloat(f.vaults?.items?.[0]?.amount ?? "0"),
  }));
};

        // ── Helper: leer vaults internos de un component ───────────────────
        const readComponentVaults = async (componentAddr: string): Promise<{ addr: string; reserve: number }[]> => {
          const res = await fetch(`${gatewayUrl}/state/entity/details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addresses: [componentAddr], aggregation_level: "Vault" }),
          });
          const data = await res.json() as any;
          const fungibles = data?.items?.[0]?.fungible_resources?.items ?? [];
          return fungibles
            .filter((f: any) => parseFloat(f.vaults?.items?.[0]?.amount ?? "0") > 0)
            .map((f: any) => ({
              addr: f.resource_address,
              reserve: parseFloat(f.vaults?.items?.[0]?.amount ?? "0"),
            }));
        };

        // ── TwoPool (Caviar WeightedPool / Ociswap BasicPool) ──────────────
        if (p.protocol === "caviar" || p.protocol === "ociswap") {
          const reserves = await readPoolReserves(p.poolAddress);
          if (reserves.length < 2) {
            return JSON.stringify({ success: false, error: "Could not read pool reserves." });
          }

          const [rA, rB] = reserves;
          if (rA.reserve === 0 || rB.reserve === 0) {
            return JSON.stringify({ success: false, error: "Pool has no liquidity." });
          }

          const userIsA = p.knownTokenAddress === rA.addr;
          const ratio = userIsA ? rB.reserve / rA.reserve : rA.reserve / rB.reserve;
          const calculatedAmount = (knownAmount * ratio).toFixed(8);
          const symA = resolveTokenSymbol(rA.addr);
          const symB = resolveTokenSymbol(rB.addr);
          const [tA, tB, amtA, amtB] = userIsA
            ? [rA.addr, rB.addr, p.knownAmount, calculatedAmount]
            : [rA.addr, rB.addr, calculatedAmount, p.knownAmount];

          return JSON.stringify({
            success: true,
            tokenAAddress: rA.addr, tokenBAddress: rB.addr,
            tokenASymbol: symA, tokenBSymbol: symB,
            calculatedAmount,
            message: `${symA}/${symB} ratio: ${ratio.toFixed(6)} | For ${p.knownAmount} ${userIsA ? symA : symB} you need ${calculatedAmount} ${userIsA ? symB : symA}. ` +
              `CALL wallet_add_liquidity: protocol:${p.protocol} poolAddress:${p.poolAddress} tokenAAddress:${tA} amountA:${amtA} tokenBAddress:${tB} amountB:${amtB}`,
          });
        }

        // ── Ociswap PrecisionPool ──────────────────────────────────────────
        if (p.protocol === "ociswap_precision") {
          const res = await fetch(`${gatewayUrl}/state/entity/details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addresses: [p.poolAddress] }),
          });
          const data = await res.json() as any;
          const fields: any[] = data?.items?.[0]?.details?.state?.fields ?? [];
          const getField = (name: string) => fields.find((f: any) => f.field_name === name);

          const priceSqrt = parseFloat(getField("price_sqrt")?.value ?? "0");
          if (priceSqrt === 0) return JSON.stringify({ success: false, error: "Could not read pool price." });
          const price = priceSqrt * priceSqrt;

          const xVault = getField("x_liquidity")?.value ?? "";
          const yVault = getField("y_liquidity")?.value ?? "";
          const vaultRes = await fetch(`${gatewayUrl}/state/entity/details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addresses: [xVault, yVault] }),
          });
          const vaultData = await vaultRes.json() as any;
          const vaultItems = vaultData?.items ?? [];
          const getVaultToken = (addr: string) =>
            vaultItems.find((i: any) => i.address === addr)?.fungible_resources?.items?.[0]?.resource_address ?? "";

          const tokenX = getVaultToken(xVault);
          const tokenY = getVaultToken(yVault);
          const symX = resolveTokenSymbol(tokenX);
          const symY = resolveTokenSymbol(tokenY);
          const userIsX = p.knownTokenAddress === tokenX;
          // price = Y per X
          const calculatedAmount = (userIsX ? knownAmount * price : knownAmount / price).toFixed(8);
          const [tA, tB, amtA, amtB] = userIsX
            ? [tokenX, tokenY, p.knownAmount, calculatedAmount]
            : [tokenX, tokenY, calculatedAmount, p.knownAmount];

          return JSON.stringify({
            success: true,
            tokenAAddress: tokenX, tokenBAddress: tokenY,
            tokenASymbol: symX, tokenBSymbol: symY,
            calculatedAmount,
            message: `PrecisionPool ${symX}/${symY} price: ${price.toFixed(6)} ${symY} per ${symX} | ` +
              `For ${p.knownAmount} ${userIsX ? symX : symY} you need ~${calculatedAmount} ${userIsX ? symY : symX}. ` +
              `Note: PrecisionPool returns remainder automatically. ` +
              `CALL wallet_add_liquidity: protocol:ociswap_precision poolAddress:${p.poolAddress} tokenAAddress:${tA} amountA:${amtA} tokenBAddress:${tB} amountB:${amtB}`,
          });
        }

        // ── Caviar QuantaSwap ──────────────────────────────────────────────
        if (p.protocol === "caviar_quantaswap") {
          const res = await fetch(`${gatewayUrl}/state/entity/details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addresses: [p.poolAddress] }),
          });
          const data = await res.json() as any;
          const fields: any[] = data?.items?.[0]?.details?.state?.fields ?? [];
          const getField = (name: string) => fields.find((f: any) => f.field_name === name);

          // activeBin → precio = 1.0005^(activeBin - 27000)
          const tickIndex = getField("tick_index");
          const currentField = tickIndex?.fields?.find((f: any) => f.field_name === "current");
          const activeBin = currentField?.variant_name === "Some"
            ? parseInt(currentField?.fields?.[0]?.fields?.[0]?.value ?? "27000")
            : 27000;
          const price = Math.pow(1.0005, activeBin - 27000); // Y per X

          // Resolver tokens desde vaults
          const xVault = getField("tokens_x")?.value ?? "";
          const yVault = getField("tokens_y")?.value ?? "";
          const vaultRes = await fetch(`${gatewayUrl}/state/entity/details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addresses: [xVault, yVault] }),
          });
          const vaultData = await vaultRes.json() as any;
          const vaultItems = vaultData?.items ?? [];
          const getVaultToken = (addr: string) =>
            vaultItems.find((i: any) => i.address === addr)?.details?.resource_address ?? "";

          const tokenX = getVaultToken(xVault);
          const tokenY = getVaultToken(yVault);
          const symX = resolveTokenSymbol(tokenX);
          const symY = resolveTokenSymbol(tokenY);
          const userIsX = p.knownTokenAddress === tokenX;
          // price = Y per X → if user gives X, need X*price Y; if user gives Y, need Y/price X
          const calculatedAmount = (userIsX ? knownAmount * price : knownAmount / price).toFixed(8);
          const [tA, tB, amtA, amtB] = userIsX
            ? [tokenX, tokenY, p.knownAmount, calculatedAmount]
            : [tokenX, tokenY, calculatedAmount, p.knownAmount];

          return JSON.stringify({
            success: true,
            tokenAAddress: tokenX, tokenBAddress: tokenY,
            tokenASymbol: symX, tokenBSymbol: symY,
            activeBin, price: price.toFixed(6), calculatedAmount,
            message: `QuantaSwap ${symX}/${symY} active bin: ${activeBin} price: ${price.toFixed(6)} ${symY} per ${symX} | ` +
              `For ${p.knownAmount} ${userIsX ? symX : symY} you need ~${calculatedAmount} ${userIsX ? symY : symX}. ` +
              `CALL wallet_add_liquidity: protocol:caviar_quantaswap poolAddress:${p.poolAddress} tokenAAddress:${tA} amountA:${amtA} tokenBAddress:${tB} amountB:${amtB}`,
          });
        }

        // ── DefiPlaza ──────────────────────────────────────────────────────
        if (p.protocol === "defiPlaza") {
          // Obtener estado del par — shortage + basePool/quotePool addresses
          const res = await fetch(`${gatewayUrl}/state/entity/details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addresses: [p.poolAddress], aggregation_level: "Global" }),
          });
          const data = await res.json() as any;
          const stateFields = data?.items?.[0]?.details?.state?.fields ?? [];
          const getField = (name: string) => stateFields.find((f: any) => f.field_name === name);

          const baseAddress  = getField("base_address")?.value ?? "";
          const quoteAddress = getField("quote_address")?.value ?? "";
          const basePool     = getField("base_pool")?.value ?? "";
          const quotePool    = getField("quote_pool")?.value ?? "";
          const shortageField = getField("state")?.fields?.find((f: any) => f.field_name === "shortage");
          const shortage      = shortageField?.variant_name ?? "Equilibrium";

          const symBase  = resolveTokenSymbol(baseAddress);
          const symQuote = resolveTokenSymbol(quoteAddress);
          const userIsBase = p.knownTokenAddress === baseAddress;

          // Leer reservas de ambos pools nativos para calcular precio
          const [baseReserves, quoteReserves] = await Promise.all([
            readPoolReserves(basePool),
            readPoolReserves(quotePool),
          ]);

          // basePool tiene: base token + XRD → precio base en XRD
          // quotePool tiene: quote token + XRD → precio quote en XRD
          // precio base/quote = (XRD per base) / (XRD per quote)
          const baseXrd  = baseReserves.find(r => r.addr === "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")?.reserve ?? 0;
          const baseAmt  = baseReserves.find(r => r.addr === baseAddress)?.reserve ?? 0;
          const quoteXrd = quoteReserves.find(r => r.addr === "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd")?.reserve ?? 0;
          const quoteAmt = quoteReserves.find(r => r.addr === quoteAddress)?.reserve ?? 0;

          // precio de base en términos de quote
          const priceBaseInXrd  = baseAmt  > 0 ? baseXrd  / baseAmt  : 0;
          const priceQuoteInXrd = quoteAmt > 0 ? quoteXrd / quoteAmt : 0;
          const price = priceQuoteInXrd > 0 ? priceBaseInXrd / priceQuoteInXrd : 0;
          // price = quote per base

          // Caso sin co-token (depositas opuesto al shortage o equilibrium)
          const needsCoToken =
            (shortage === "BaseShortage"  && userIsBase) ||
            (shortage === "QuoteShortage" && !userIsBase);

          if (!needsCoToken) {
            return JSON.stringify({
              success: true,
              tokenAAddress: baseAddress, tokenBAddress: quoteAddress,
              tokenASymbol: symBase, tokenBSymbol: symQuote,
              shortage, needsCoToken: false,
              message: `DefiPlaza ${symBase}/${symQuote} — ${shortage}. ` +
                `You can deposit ${p.knownAmount} ${userIsBase ? symBase : symQuote} ALONE — no co-token needed. ` +
                `CALL wallet_add_liquidity: protocol:defiPlaza poolAddress:${p.poolAddress} ` +
                `tokenAAddress:${p.knownTokenAddress} amountA:${p.knownAmount} tokenBAddress:"" amountB:0`,
            });
          }

          // Caso con co-token — calcular cuánto co-token necesitas
          const calculatedAmount = price > 0
            ? (userIsBase ? knownAmount / price : knownAmount * price).toFixed(8)
            : "unknown";

          const shortageToken  = shortage === "BaseShortage"  ? baseAddress  : quoteAddress;
          const shortageAmount = userIsBase ? calculatedAmount : p.knownAmount;
          const coToken        = p.knownTokenAddress;
          const coAmount       = userIsBase ? p.knownAmount : calculatedAmount;
          const shortageSym    = resolveTokenSymbol(shortageToken);
          const coSym          = resolveTokenSymbol(coToken);

          return JSON.stringify({
            success: true,
            tokenAAddress: baseAddress, tokenBAddress: quoteAddress,
            tokenASymbol: symBase, tokenBSymbol: symQuote,
            shortage, needsCoToken: true,
            calculatedAmount,
            message: `DefiPlaza ${symBase}/${symQuote} — ${shortage}. ` +
              `Depositing ${userIsBase ? symBase : symQuote} requires co-token. ` +
              `For ${p.knownAmount} ${userIsBase ? symBase : symQuote} you need ~${calculatedAmount} ${userIsBase ? symQuote : symBase} as co-token. ` +
              `CALL wallet_add_liquidity: protocol:defiPlaza poolAddress:${p.poolAddress} ` +
              `tokenAAddress:${shortageToken} amountA:${shortageAmount} tokenBAddress:${coToken} amountB:${coAmount}`,
          });
        }

        return JSON.stringify({ success: false, error: `Protocol ${p.protocol} not supported.` });

      } catch (error) {
        return JSON.stringify({ success: false, error: `Failed to get pool ratio: ${error}` });
      }
    },
  };
}


// ─── wallet_add_liquidity ─────────────────────────────────────────────────────


export function createAddLiquidityTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_add_liquidity",
description: `Add liquidity to a DEX pool on Radix.

SUPPORTED PROTOCOLS: 'defiPlaza', 'caviar', 'ociswap', 'ociswap_precision', 'caviar_quantaswap'.

STEP BY STEP — follow this exactly:

STEP 1 — Find the pool:
- If user gave a poolAddress → use it directly, skip to STEP 2.
- If user did NOT give a poolAddress → call wallet_find_pools with the token(s) the user mentioned, show results, wait for user to choose a pool.

STEP 2 — Calculate amounts:
- If user gave BOTH token amounts → skip to STEP 3.
- If user gave ONE token amount → call wallet_get_pool_ratio with: poolAddress, protocol, knownTokenAddress (the token the user specified), knownAmount (EXACTLY what the user said — do NOT use wallet_balance amounts, do NOT use the full balance).
- For defiPlaza → call wallet_get_pair_state instead of wallet_get_pool_ratio.

STEP 3 — Execute:
- Call wallet_add_liquidity with the exact amounts from STEP 2.
- NEVER call wallet_balance before this tool.
- NEVER use the user's full balance as an amount — use ONLY what the user specified.
- NEVER guess or calculate amounts yourself — wallet_get_pool_ratio does that.

TOKEN RULES:
- 'defiPlaza': tokenA only unless co-token case (wallet_get_pair_state will tell you).
- 'caviar', 'ociswap', 'ociswap_precision', 'caviar_quantaswap': BOTH tokenA and tokenB required — never call with amountB:0.

IMPORTANT: Never retry a failed liquidity operation.`,
    parameters: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          enum: ["defiPlaza", "caviar", "ociswap", "ociswap_precision", "caviar_quantaswap"],
          description: "DEX protocol to use",
        },
        poolAddress: {
          type: "string",
          description: "Component address of the pool",
        },
        tokenAAddress: {
          type: "string",
          description: "Resource address of token A. Get from wallet_get_pool_info or wallet_get_pair_state.",
        },
        amountA: {
          type: "string",
          description: "Amount of tokenA to deposit",
        },
        tokenBAddress: {
          type: "string",
          description: "Resource address of token B. Required for caviar, ociswap, ociswap_precision, caviar_quantaswap. For defiPlaza single-token deposit, pass empty string \"\".",
        },
        amountB: {
          type: "string",
          description: "Amount of tokenB. Required for caviar, ociswap, ociswap_precision, caviar_quantaswap. For defiPlaza single-token deposit, pass \"0\".",
        },
      },
      required: ["protocol", "poolAddress", "tokenAAddress", "amountA", "tokenBAddress", "amountB"],
    },
    call: async (params: unknown): Promise<string> => {

        const p = params as {
        protocol: string;
        poolAddress: string;
        tokenAAddress: string;
        amountA: string;
        tokenBAddress?: string;
        amountB?: string;
      };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const safeAmountA = safeDecimal(p.amountA, p.tokenAAddress);
        const safeAmountB = safeDecimal(p.amountB ?? "0", p.tokenBAddress ?? "");

        const adapter = getAdapter(p.protocol as LiquidityProtocol, gatewayUrl);

        const result = await adapter.addLiquidity({
          poolAddress:   p.poolAddress,
          tokenAAddress: p.tokenAAddress,
          tokenBAddress: p.tokenBAddress ?? "",
          amountA:       safeAmountA,
          amountB:       safeAmountB ?? "0",
          vaultAddress,
          notarizerAddress,
        });

        const manifest = result.manifest
          .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
          .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);


        const txId = await wallet.submitManifest(manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ ${result.description} TX: ${txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Add liquidity failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_remove_liquidity ──────────────────────────────────────────────────
// El tool resuelve internamente todo lo necesario para el retiro.
// El LLM solo necesita identificar QUÉ posición retirar — el tool hace el resto.
//
// FLUJO INTERNO:
//   1. Llama a resolvePositions() para obtener todas las posiciones del vault
//   2. Filtra por protocol, poolAddress, tokenA, tokenB si el LLM los proporciona
//   3. Si hay una sola coincidencia → ejecuta directamente
//   4. Si hay varias → devuelve lista para que el usuario elija
//   5. Ejecuta removeLiquidity con todos los parámetros correctos

export function createRemoveLiquidityTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_remove_liquidity",
    description: `Remove liquidity from a DEX pool. The system automatically finds ALL required parameters internally — LP token address, amount, NFT IDs, everything.

SUPPORTED PROTOCOLS: 'defiPlaza', 'caviar', 'ociswap', 'ociswap_precision', 'caviar_quantaswap', 'caviar_lsupool'.

HOW TO USE — provide only what you know, system finds the rest:
- User says "remove my DefiPlaza liquidity" → protocol:'defiPlaza', poolAddress:'', tokenA:'', tokenB:''
- User says "remove XRD/HUSDC from Ociswap" → protocol:'ociswap_precision', tokenA:'XRD', tokenB:'HUSDC', poolAddress:''
- User gives pool address → pass it in poolAddress
- System scans vault, finds LP tokens/NFTs automatically, executes removal
- If only one matching position → executes immediately
- If multiple → returns list for user to choose, then call again with specific poolAddress

NEVER ask the user for lpTokenAddress, lpAmount, or lpNftId.
IMPORTANT: Never retry a failed operation.`,
    parameters: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          enum: ["defiPlaza", "caviar", "ociswap", "ociswap_precision", "caviar_quantaswap", "caviar_lsupool"],
          description: "DEX protocol. Pass empty string if unknown.",
        },
        poolAddress: {
          type: "string",
          description: "Pool component address. Pass empty string if unknown.",
        },
        tokenA: {
          type: "string",
          description: "Optional token symbol to identify position (e.g. 'XRD', 'HUSDC'). Pass empty string if unknown.",
        },
        tokenB: {
          type: "string",
          description: "Optional second token symbol. Pass empty string if unknown.",
        },
      },
      required: ["protocol", "poolAddress", "tokenA", "tokenB"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as {
        protocol: string;
        poolAddress: string;
        tokenA?: string;
        tokenB?: string;
      };

      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const balance = await wallet.getBalance();
        const allPositions = await resolvePositions(balance, gatewayUrl);

        // Solo posiciones de liquidez (no WEFT)
        const liquidityPositions = allPositions.filter(pos => pos.type !== "weft") as any[];

        if (liquidityPositions.length === 0) {
          return JSON.stringify({
            success: false,
            error: "No liquidity positions found in the vault.",
          });
        }

        // ── Filtrar por criterios del LLM ──
        let candidates = liquidityPositions;

        if (p.protocol && p.protocol.trim() !== "") {
          candidates = candidates.filter((pos: any) => pos.protocol === p.protocol);
        }

        if (p.poolAddress && p.poolAddress.trim() !== "") {
          candidates = candidates.filter((pos: any) => pos.poolAddress === p.poolAddress);
        }

        if (p.tokenA && p.tokenA.trim() !== "") {
          let symA: string;
          try { symA = resolveTokenSymbol(resolveTokenAddress(p.tokenA)).toLowerCase(); }
          catch { symA = p.tokenA.toLowerCase(); }
          candidates = candidates.filter((pos: any) =>
            pos.tokenA.toLowerCase().includes(symA) ||
            pos.tokenB.toLowerCase().includes(symA)
          );
        }

        if (p.tokenB && p.tokenB.trim() !== "") {
          let symB: string;
          try { symB = resolveTokenSymbol(resolveTokenAddress(p.tokenB)).toLowerCase(); }
          catch { symB = p.tokenB.toLowerCase(); }
          candidates = candidates.filter((pos: any) =>
            pos.tokenA.toLowerCase().includes(symB) ||
            pos.tokenB.toLowerCase().includes(symB)
          );
        }

        if (candidates.length === 0) {
          return JSON.stringify({
            success: false,
            error: `No matching liquidity position found. Call wallet_my_positions to see all available positions.`,
          });
        }

        // ── Múltiples coincidencias → pedir al usuario que elija ──
        if (candidates.length > 1) {
          const list = candidates.map((pos: any, i: number) =>
            `${i+1}. ${pos.dex} | ${pos.tokenA}/${pos.tokenB} | pool: ${pos.poolAddress}`
          ).join("\n");
          return JSON.stringify({
            success: false,
            needsChoice: true,
            message: `Multiple positions found. Ask the user which one to remove:\n\n${list}\n\nThen call wallet_remove_liquidity again with the specific poolAddress.`,
          });
        }

        // ── Una sola posición → ejecutar ──
        const pos = candidates[0];
        const adapter = getAdapter(pos.protocol as LiquidityProtocol, gatewayUrl);

        // ── Caviar LSU Pool — parámetros especiales ──
        if (pos.protocol === "caviar_lsupool") {
          const LSULP = "resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf";
          const XRD   = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
          const lsulpResource = balance.resources.find((r: any) => r.resourceAddress === LSULP);
          const lsulpAmount = lsulpResource
            ? safeDecimal(lsulpResource.amount.toString(), LSULP)
            : "0";
          const lsuResource = balance.resources.find(
            (r: any) => r.resourceAddress !== LSULP && r.resourceAddress !== XRD
          );
          const result = await adapter.removeLiquidity({
            poolAddress:          pos.poolAddress,
            lpTokenAddress:       LSULP,
            lpAmount:             lsulpAmount,
            vaultAddress,
            notarizerAddress,
            lsuResourceToReceive: lsuResource?.resourceAddress ?? "",
            creditReceiptId:      pos.lpNftId,
          } as any);
          const manifest = result.manifest
            .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
            .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);
          const txId = await wallet.submitManifest(manifest);
          return JSON.stringify({ success: true, txId, message: `✅ ${result.description} TX: ${txId}` });
        }

        // ── Todos los demás protocolos ──
        const lpAmount = pos.lpNftId
          ? pos.lpNftId
          : safeDecimal(pos.amount.toString(), pos.lpTokenAddress);

        const result = await adapter.removeLiquidity({
          poolAddress:    pos.poolAddress,
          lpTokenAddress: pos.lpTokenAddress,
          lpAmount,
          lpNftId:        pos.lpNftId ?? "",
          vaultAddress,
          notarizerAddress,
        });

        const manifest = result.manifest
          .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
          .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);

        const txId = await wallet.submitManifest(manifest);
        return JSON.stringify({ success: true, txId, message: `✅ ${result.description} TX: ${txId}` });

      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Remove liquidity failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_lsu_add ───────────────────────────────────────────────────────────
// Tool dedicado para Caviar LSU Pool — más simple y claro para el LLM.

export function createLsuAddTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_lsu_add",
    description: `Add LSU tokens (Liquid Staking Units) to the Caviar LSU Pool.
You receive LSULP tokens + a credit_receipt NFT in return.
The credit_receipt NFT is REQUIRED to remove liquidity later — it is saved in the vault automatically.

DOUBLE YIELD: you keep earning staking rewards AND earn swap fees simultaneously.

WORKFLOW:
1. Call wallet_balance to find your LSU token address and amount.
2. Call this tool with the LSU resource address and amount.

IMPORTANT:
- lsuAddress = resource address of your LSU token (from wallet_balance resources array).
- amount = how many LSU tokens to deposit.
- creditReceiptId = optional. Only needed if you already have a position and want to add more.
- Never retry a failed operation.`,
    parameters: {
      type: "object",
      properties: {
        lsuAddress: {
          type: "string",
          description: "Resource address of the LSU token to deposit. Get from wallet_balance resources array.",
        },
        amount: {
          type: "string",
          description: "Amount of LSU tokens to deposit",
        },
        creditReceiptId: {
          type: "string",
          description: "Optional. NFT local ID of existing credit_receipt if adding to existing position. Format: '{uuid-uuid-uuid-uuid}'",
        },
      },
      required: ["lsuAddress", "amount"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as {
        lsuAddress: string;
        amount: string;
        creditReceiptId?: string;
      };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const safeAmount = safeDecimal(p.amount, p.lsuAddress);
        const creditReceiptId = p.creditReceiptId && p.creditReceiptId.trim() !== ""
        ? p.creditReceiptId
        : undefined;

        const adapter = getLsuPoolAdapter(gatewayUrl);
        const result = await adapter.addLiquidity({
          poolAddress:   LSU_POOL_ADDRESS,
          tokenAAddress: p.lsuAddress,
          tokenBAddress: "",
          amountA:       safeAmount,
          amountB:       "0",
          vaultAddress,
          notarizerAddress,
          creditReceiptId: creditReceiptId,
        } as any);

        const manifest = result.manifest
          .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
          .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);

        const txId = await wallet.submitManifest(manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ ${result.description} TX: ${txId}. Check wallet_balance for your credit_receipt NFT (resource: ${CREDIT_RECEIPT_RESOURCE}) — you will need its ID to remove liquidity.`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `LSU add liquidity failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_lsu_remove ────────────────────────────────────────────────────────

export function createLsuRemoveTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_lsu_remove",
    description: `Remove liquidity from the Caviar LSU Pool.
Burns LSULP tokens and returns LSU tokens of the validator you choose.
REQUIRES the credit_receipt NFT ID — without it you cannot withdraw.

WORKFLOW:
1. Call wallet_balance to find:
   - Your LSULP amount (resource: ${LSULP_RESOURCE})
   - Your credit_receipt NFT ID (resource: ${CREDIT_RECEIPT_RESOURCE})
   - The LSU resource address you want to receive
2. Call this tool with those values.

IMPORTANT: Never retry a failed operation.`,
    parameters: {
      type: "object",
      properties: {
        lsulpAmount: {
          type: "string",
          description: `Amount of LSULP tokens to burn. Get from wallet_balance. LSULP resource: ${LSULP_RESOURCE}`,
        },
        lsuAddressToReceive: {
          type: "string",
         description: `Resource address of the LSU token you want to receive back — this is the LSU of your validator, NOT LSULP and NOT XRD. 
Look in wallet_balance resources array for a token whose resourceAddress does NOT match LSULP (${LSULP_RESOURCE}) and is not XRD. 
It will have no symbol or a long resource address as symbol. That is your LSU token.`,
        },
        creditReceiptId: {
          type: "string",
          description: `NFT local ID of your credit_receipt. Get from wallet_balance nfts array. Resource: ${CREDIT_RECEIPT_RESOURCE}. Format: '{uuid-uuid-uuid-uuid}'`,
        },
      },
      required: ["lsulpAmount", "lsuAddressToReceive", "creditReceiptId"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as {
        lsulpAmount: string;
        lsuAddressToReceive: string;
        creditReceiptId: string;
      };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const safeLsulpAmount = safeDecimal(p.lsulpAmount, LSULP_RESOURCE);

        const creditReceiptId = p.creditReceiptId && p.creditReceiptId.trim() !== ""
        ? p.creditReceiptId
        : undefined;

        if (!p.creditReceiptId || p.creditReceiptId.trim() === "") {
          return JSON.stringify({
            success: false,
            error: `STOP — creditReceiptId is required but empty. Call wallet_balance and look in the nfts array for resource ${CREDIT_RECEIPT_RESOURCE}. Copy the NFT ID exactly and retry.`,
          });
        }
        const adapter = getLsuPoolAdapter(gatewayUrl);
        const result = await adapter.removeLiquidity({
          poolAddress:    LSU_POOL_ADDRESS,
          lpTokenAddress: LSULP_RESOURCE,
          lpAmount:       safeLsulpAmount,
          vaultAddress,
          notarizerAddress,
          lsuResourceToReceive: p.lsuAddressToReceive,
          creditReceiptId:      creditReceiptId,
        } as any);

        const manifest = result.manifest
          .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
          .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);

        const txId = await wallet.submitManifest(manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ ${result.description} TX: ${txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `LSU remove liquidity failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_find_pools ────────────────────────────────────────────────────────
// Busca pools disponibles para uno o dos tokens.
// Lógica:
//   - 1 token = XRD → pedir segundo token (lista sería enorme)
//   - 1 token ≠ XRD → WEFT (si soportado) + DefiPlaza (si hay par) + info otros DEX
//   - 2 tokens       → buscar pools con ambos en el registry

const XRD_ADDRESS_FP = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";


const FP_DEX_NAME: Record<string, string> = {
  caviar_quantaswap: "Caviar QuantaSwap",
  caviar:            "Caviar WeightedPool",
  caviar_lsupool:    "Caviar LSU Pool",
  ociswap_precision: "Ociswap PrecisionPool",
  ociswap:           "Ociswap BasicPool",
  defiPlaza:         "DefiPlaza",
};

const FP_DEX_URL: Record<string, string> = {
  caviar_quantaswap: "https://caviar.fi/pool/",
  caviar:            "https://caviar.fi/pool/",
  ociswap_precision: "https://ociswap.com/pool/",
  ociswap:           "https://ociswap.com/pool/",
  defiPlaza:         "https://defiplaza.net/pair/",
};

const FP_DEPOSIT_RULES: Record<string, string> = {
  caviar_quantaswap: "Requires BOTH tokens. Liquidity distributed across price bins automatically.",
  caviar:            "Requires BOTH tokens in equal value ratio.",
  caviar_lsupool:    "Deposit LSU tokens only. Receive LSULP + credit_receipt NFT.",
  ociswap_precision: "Requires BOTH tokens. Liquidity concentrated in a price range.",
  ociswap:           "Requires BOTH tokens in equal value ratio.",
  defiPlaza:         "Can deposit ONE token alone. If that token is in shortage you must also provide the other as co-token. Call wallet_get_pair_state first to check shortage status.",
};

function formatPoolEntry(pool: any, index: number): any {
  const symbolA = resolveTokenSymbol(pool.token0);
  const symbolB = resolveTokenSymbol(pool.token1);
  const fee = (pool.feeRateBps / 100).toFixed(2) + "%";
  const url = (FP_DEX_URL[pool.protocol] ?? "") + pool.address;
  return {
    index,
    dex: FP_DEX_NAME[pool.protocol] ?? pool.protocol,
    protocol: pool.protocol,
    poolAddress: pool.address,
    tokenA: { symbol: symbolA, address: pool.token0 },
    tokenB: { symbol: symbolB, address: pool.token1 },
    fee,
    depositRules: FP_DEPOSIT_RULES[pool.protocol] ?? "",
    url,
  };
}

export function createFindPoolsTool(): AgentTool {
  return {
    name: "wallet_find_pools",
    description: `Find available liquidity pools for one or two tokens on Radix.
Call this BEFORE wallet_add_liquidity when the user wants to add liquidity but hasn't specified a pool.

RULES — follow strictly:
- User mentions ONE token AND it is XRD: do NOT call this tool. Ask the user for a second token first.
- User mentions ONE token (not XRD): call with tokenA only, tokenB as empty string "". Returns WEFT and DefiPlaza single-token options + informs about pair DEXes.
- User mentions TWO tokens: call with both tokenA and tokenB. Returns all pools with that exact pair.

After showing results always ask the user which pool they prefer before calling wallet_add_liquidity.`,
    parameters: {
      type: "object",
      properties: {
        tokenA: {
          type: "string",
          description: "First token symbol (e.g. 'HUSDC', 'HWBTC') or resource address.",
        },
        tokenB: {
          type: "string",
          description: "Second token symbol or resource address. Pass empty string if user only mentioned one token.",
        },
      },
      required: ["tokenA", "tokenB"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { tokenA: string; tokenB: string };
      try {
        let addrA: string;
        try { addrA = resolveTokenAddress(p.tokenA); } catch { addrA = p.tokenA; }
        const symbolA = resolveTokenSymbol(addrA);
        const hasTokenB = p.tokenB && p.tokenB.trim() !== "" && p.tokenB !== '""';

        // ── Caso: XRD solo → pedir segundo token ──
        if (!hasTokenB && addrA === XRD_ADDRESS_FP) {
          return JSON.stringify({
            success: false,
            needsSecondToken: true,
            message: "XRD is paired with many tokens. Please ask the user which second token they want to pair with XRD (e.g. HUSDC, HWBTC, WEFT, OCI...) and then call wallet_find_pools again with both tokens.",
          });
        }

        // ── Caso: dos tokens → buscar par exacto ──
        if (hasTokenB) {
          let addrB: string;
          try { addrB = resolveTokenAddress(p.tokenB); } catch { addrB = p.tokenB; }
          const symbolB = resolveTokenSymbol(addrB);

          const pools = KNOWN_POOLS_REGISTRY.filter(pool =>
            (pool.token0 === addrA && pool.token1 === addrB) ||
            (pool.token0 === addrB && pool.token1 === addrA)
          );

          if (pools.length === 0) {
            return JSON.stringify({
              success: false,
              message: `No pools found for the pair ${symbolA}/${symbolB}. This pair may not be listed in any supported DEX.`,
            });
          }

          const result = pools.map((pool, i) => formatPoolEntry(pool, i + 1));
          const summary = result.map(r =>
            `${r.index}. ${r.dex} | ${r.tokenA.symbol}/${r.tokenB.symbol} | Fee: ${r.fee}\n` +
            `   Pool: ${r.poolAddress}\n` +
            `   Token A (${r.tokenA.symbol}): ${r.tokenA.address}\n` +
            `   Token B (${r.tokenB.symbol}): ${r.tokenB.address}\n` +
            `   📋 ${r.depositRules}\n` +
            `   🔗 ${r.url}`
          ).join("\n\n");

          return JSON.stringify({
            success: true,
            totalPools: result.length,
            pools: result,
            message: `Found ${result.length} pool(s) for ${symbolA}/${symbolB}:\n\n${summary}\n\nAsk the user which pool they prefer, then call wallet_add_liquidity.`,
          });
        }

        // ── Caso: un token ≠ XRD → WEFT + DefiPlaza ──
        const options: string[] = [];

        if (WEFT_SUPPORTED_ADDRESSES.has(addrA)) {
          options.push(
            `💰 WEFT Finance (Lending/Borrowing)\n` +
            `   Deposit ${symbolA} as collateral to earn yield. Single token, no pair needed.\n` +
            `   Use wallet_weft_supply to deposit.\n` +
            `   🔗 https://weft.finance`
          );
        }

        const defiplazaPools = KNOWN_POOLS_REGISTRY.filter(
          pool => pool.protocol === "defiPlaza" &&
          (pool.token0 === addrA || pool.token1 === addrA)
        );

        if (defiplazaPools.length > 0) {
          const dpList = defiplazaPools.map((pool, i) => {
            const otherAddr = pool.token0 === addrA ? pool.token1 : pool.token0;
            const otherSymbol = resolveTokenSymbol(otherAddr);
            const fee = (pool.feeRateBps / 100).toFixed(2) + "%";
            return (
              `   ${i + 1}. DefiPlaza | ${symbolA}/${otherSymbol} | Fee: ${fee}\n` +
              `      Pool: ${pool.address}\n` +
              `      Token A (${symbolA}): ${addrA}\n` +
              `      Token B (${otherSymbol}): ${otherAddr}\n` +
              `      📋 ${FP_DEPOSIT_RULES.defiPlaza}\n` +
              `      🔗 ${FP_DEX_URL.defiPlaza}${pool.address}`
            );
          }).join("\n");
          options.push(`🏦 DefiPlaza (single-token possible):\n${dpList}`);
        }

        const otherDexCount = KNOWN_POOLS_REGISTRY.filter(
          pool => pool.protocol !== "defiPlaza" &&
          pool.protocol !== "caviar_lsupool" &&
          (pool.token0 === addrA || pool.token1 === addrA)
        ).length;

        let message = `Single-token liquidity options for ${symbolA}:\n\n`;
        if (options.length > 0) {
          message += options.join("\n\n") + "\n\n";
        } else {
          message += `No single-token options available for ${symbolA}.\n\n`;
        }
        if (otherDexCount > 0) {
          message += `📌 ${otherDexCount} pools on Caviar and Ociswap also include ${symbolA} but require a second token. Ask the user which token they want to pair with ${symbolA} and call wallet_find_pools again with both tokens.`;
        }

        return JSON.stringify({
          success: true,
          singleTokenOptions: options.length,
          otherDexPoolCount: otherDexCount,
          message,
        });

      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Find pools failed: ${error}`,
        });
      }
    },
  };
}


// ─── wallet_my_positions ──────────────────────────────────────────────────────
// Escanea el vault y devuelve todas las posiciones activas de liquidez y lending.
// Usa esto ANTES de wallet_remove_liquidity cuando el usuario no especifica el pool.

export function createMyPositionsTool(wallet: any): AgentTool {
  return {
    name: "wallet_my_positions",
    description: `Show all active liquidity and lending positions in the vault.
Call this when the user wants to remove liquidity or check their positions but hasn't specified which pool.
Returns a list of positions with protocol, pool address, token pair, LP token address, and amount/NFT IDs — everything needed to call wallet_remove_liquidity directly.
After showing results, ask the user which position they want to remove if there are multiple.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  call: async (_params: unknown): Promise<string> => {
  try {
    const gatewayUrl = wallet.networkConfig.gatewayUrl;
    const balance = await wallet.getBalance();
    const positions = await resolvePositions(balance, gatewayUrl);

    if (positions.length === 0) {
      return JSON.stringify({
        success: true,
        totalPositions: 0,
        message: "No active liquidity or lending positions found in the vault.",
      });
    }

    const summary = positions.map((pos, i) => {
      if (pos.type === "weft") {
        const w = pos as any;
        return `${i+1}. WEFT | ${w.tokenSymbol} | ${w.depositUnitAmount} units | ACTION: wallet_weft_withdraw depositUnitAddress:${w.depositUnitAddress} amount:${w.depositUnitAmount}`;
      }
      const p = pos as any;
      const action = p.lpNftId
        ? `protocol:${p.protocol} poolAddress:${p.poolAddress} lpTokenAddress:${p.lpTokenAddress} lpNftId:${p.lpNftId}`
        : `protocol:${p.protocol} poolAddress:${p.poolAddress} lpTokenAddress:${p.lpTokenAddress} lpAmount:${p.amount}`;
      return `${i+1}. ${p.protocol} | ${p.tokenA}/${p.tokenB} | ${p.amount ?? p.lpNftId} | ACTION: ${action}`;
    }).join("\n");

    return JSON.stringify({
      success: true,
      totalPositions: positions.length,
      message: `Found ${positions.length} position(s):\n\n${summary}\n\nTo remove a position call wallet_remove_liquidity with the ACTION parameters shown for that position. Do not call wallet_my_positions again.`,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: `Failed to resolve positions: ${error}`,
    });
  }
},

  };
}
// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLiquidityTools(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool[] {
  return [
    createMyPositionsTool(wallet),
    createFindPoolsTool(),
    createGetPairStateTool(wallet),
    createGetPoolInfoTool(wallet),
    createGetPoolRatioTool(wallet),
    createAddLiquidityTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createRemoveLiquidityTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createLsuAddTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createLsuRemoveTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
  ];
}
