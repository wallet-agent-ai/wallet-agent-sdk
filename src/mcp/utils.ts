// ─── MCP Utils ────────────────────────────────────────────────────────────────
// Utilidades compartidas para el MCP layer.
// Incluye resolución de posiciones de liquidez y lending del vault.
//
// Futuro: getBalance() se moverá aquí desde AgentWallet.ts
// ─────────────────────────────────────────────────────────────────────────────

import { KNOWN_POOLS_REGISTRY,KNOWN_TOKENS, resolveTokenSymbol } from "./known-pools.js";
import { MAINNET_RESOURCES } from "./adapters/lending/weft.js";
import { LSU_POOL_ADDRESS, LSULP_RESOURCE, CREDIT_RECEIPT_RESOURCE } from "./adapters/liquidity/caviar_lsupool.js";

// ─── Packages conocidos ───────────────────────────────────────────────────────

const CAVIAR_QUANTASWAP_PACKAGE = "package_rdx1p4r9rkp0cq67wmlve544zgy0l45mswn6h798qdqm47x4762h383wa3";

const OCISWAP_PRECISION_PACKAGE = "package_rdx1pkl8tdw43xqx64etxwdf8rjtvptqurq4c3fky0kaj6vwa0zrkfmcmc";
// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface LiquidityPosition {
  type: "fungible" | "nft";
  protocol: string;           // caviar | caviar_quantaswap | ociswap | ociswap_precision | defiPlaza | caviar_lsupool | weft
  dex: string;                // nombre legible
  poolAddress: string;        // component address del pool
  tokenA: string;             // symbol token A
  tokenB: string;             // symbol token B
  lpTokenAddress: string;     // resource address del LP token o NFT
  amount?: number;            // para fungibles
  nftIds?: string[];          // para NFTs
  lpNftId?: string;           // primer NFT ID (para remove_liquidity)
  url?: string;               // enlace al DEX
}

export interface WeftPosition {
  type: "weft";
  protocol: "weft";
  tokenSymbol: string;
  tokenAddress: string;
  depositUnitAddress: string;
  depositUnitAmount: number;
}

export type Position = LiquidityPosition | WeftPosition;

// ─── DEX names y URLs ─────────────────────────────────────────────────────────

const DEX_NAME: Record<string, string> = {
  caviar_quantaswap: "Caviar QuantaSwap",
  caviar:            "Caviar WeightedPool",
  caviar_lsupool:    "Caviar LSU Pool",
  ociswap_precision: "Ociswap PrecisionPool",
  ociswap:           "Ociswap BasicPool",
  defiPlaza:         "DefiPlaza",
};

const DEX_URL: Record<string, string> = {
  caviar_quantaswap: "https://caviar.fi/pool/",
  caviar:            "https://caviar.fi/pool/",
  ociswap_precision: "https://ociswap.com/pool/",
  ociswap:           "https://ociswap.com/pool/",
  defiPlaza:         "https://defiplaza.net/pair/",
};

// ─── Reverse lookup maps ───────────────────────────────────────────────────────

// depositUnit address → { tokenAddress, symbol }
const WEFT_DEPOSIT_UNIT_MAP: Map<string, { tokenAddress: string; symbol: string }> = new Map(
  Object.entries(MAINNET_RESOURCES)
    .filter(([, v]) => v.depositUnit)
    .map(([tokenAddr, v]) => [v.depositUnit!, { tokenAddress: tokenAddr, symbol: v.symbol }])
);

// resourcePool address → KnownPool (for Ociswap BasicPool)
const RESOURCE_POOL_MAP: Map<string, typeof KNOWN_POOLS_REGISTRY[0]> = new Map(
  KNOWN_POOLS_REGISTRY
    .filter(p => p.resourcePool)
    .map(p => [p.resourcePool!, p])
);

// basePool/quotePool address → KnownPool (for DefiPlaza)
const PLAZA_POOL_MAP: Map<string, typeof KNOWN_POOLS_REGISTRY[0]> = new Map();
for (const p of KNOWN_POOLS_REGISTRY) {
  if (p.basePool)  PLAZA_POOL_MAP.set(p.basePool, p);
  if (p.quotePool) PLAZA_POOL_MAP.set(p.quotePool, p);
}

// component address → KnownPool (for all protocols)
const COMPONENT_MAP: Map<string, typeof KNOWN_POOLS_REGISTRY[0]> = new Map(
  KNOWN_POOLS_REGISTRY.map(p => [p.address, p])
);

// ─── Gateway metadata fetch ───────────────────────────────────────────────────
async function fetchResourceMetadata(
  addresses: string[],
  gatewayUrl: string
): Promise<Map<string, any>> {
  if (addresses.length === 0) return new Map();

  const results: Map<string, any> = new Map();
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 20) {
    chunks.push(addresses.slice(i, i + 20));
  }

  const responses = await Promise.all(
    chunks.map(chunk =>
      fetch(`${gatewayUrl}/state/entity/details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: chunk,
          opt_ins: { explicit_metadata: ["name", "symbol", "pool", "swap_component", "component", "token_x", "token_y", "package"] },
        }),
      }).then(r => r.json())
    )
  );

  for (const data of responses) {
    for (const item of data?.items ?? []) {
      const meta: Record<string, string> = {};
      for (const m of item?.explicit_metadata?.items ?? []) {
        meta[m.key] = m.value?.typed?.value ?? "";
      }
      const tags: string[] = [];
      for (const m of item?.metadata?.items ?? []) {
        if (m.key === "tags") {
          tags.push(...(m.value?.typed?.values ?? []));
        }
        if (!meta[m.key]) {
          meta[m.key] = m.value?.typed?.value ?? "";
        }
      }
      meta["_tags"] = tags.join(",");
      results.set(item.address, meta);
    }
  }

  return results;
}



// ─── resolvePositions ─────────────────────────────────────────────────────────
// Analiza el balance del vault y clasifica cada recurso desconocido como
// posición de liquidez o lending.

export async function resolvePositions(
  balance: { resources: any[]; nfts: any[] },
  gatewayUrl: string
): Promise<Position[]> {
    console.log("=== resolvePositions START ===", balance.resources.length, "resources,", balance.nfts.length, "nfts");

    const positions: Position[] = [];


  // ── WEFT deposit units (fungibles conocidos) ──────────────────────────────
  for (const r of balance.resources) {
    const weftToken = WEFT_DEPOSIT_UNIT_MAP.get(r.resourceAddress);
    if (weftToken) {
      positions.push({
        type: "weft",
        protocol: "weft",
        tokenSymbol: weftToken.symbol,
        tokenAddress: weftToken.tokenAddress,
        depositUnitAddress: r.resourceAddress,
        depositUnitAmount: r.amount,
      });
    }
  }

  // ── Fungibles desconocidos → posibles LP tokens ───────────────────────────
  const unknownFungibles = balance.resources.filter(r =>
  !WEFT_DEPOSIT_UNIT_MAP.has(r.resourceAddress) &&
  r.resourceAddress !== LSULP_RESOURCE &&
  !KNOWN_TOKENS.find(t => t.address === r.resourceAddress)  
);

console.log("=== unknownFungibles ===", unknownFungibles.map(r => r.resourceAddress));




  // LSULP fungible — posición en Caviar LSU Pool
  const lsulp = balance.resources.find(r => r.resourceAddress === LSULP_RESOURCE);
  if (lsulp) {
    positions.push({
      type: "fungible",
      protocol: "caviar_lsupool",
      dex: "Caviar LSU Pool",
      poolAddress: LSU_POOL_ADDRESS,
      tokenA: "LSU",
      tokenB: "LSULP",
      lpTokenAddress: LSULP_RESOURCE,
      amount: lsulp.amount,
      url: "https://caviar.fi/earn/lsu-pool",
    });
  }

  if (unknownFungibles.length > 0) {
    const metaMap = await fetchResourceMetadata(
      unknownFungibles.map(r => r.resourceAddress),
      gatewayUrl
    );

    for (const r of unknownFungibles) {
      const meta = metaMap.get(r.resourceAddress);
      if (!meta) continue;

      const name    = meta["name"] ?? "";
      const symbol  = meta["symbol"] ?? "";
      const pool    = meta["pool"] ?? "";
      const swapComp = meta["swap_component"] ?? "";
      const tags    = meta["_tags"] ?? "";

      // ── DefiPlaza ──
      if (symbol === "DFP2LP" || name.toLowerCase().includes("defiplaza")) {
        const knownPool = PLAZA_POOL_MAP.get(pool);
        if (knownPool) {
          positions.push({
            type: "fungible",
            protocol: "defiPlaza",
            dex: "DefiPlaza",
            poolAddress: knownPool.address,
            tokenA: resolveTokenSymbol(knownPool.token0),
            tokenB: resolveTokenSymbol(knownPool.token1),
            lpTokenAddress: r.resourceAddress,
            amount: r.amount,
            url: `${DEX_URL.defiPlaza}${knownPool.address}`,
          });
        }
        continue;
      }

      // ── Caviar WeightedPool ──
      if (swapComp && COMPONENT_MAP.has(swapComp)) {
        const knownPool = COMPONENT_MAP.get(swapComp)!;
        if (knownPool.protocol === "caviar") {
          positions.push({
            type: "fungible",
            protocol: "caviar",
            dex: "Caviar WeightedPool",
            poolAddress: knownPool.address,
            tokenA: resolveTokenSymbol(knownPool.token0),
            tokenB: resolveTokenSymbol(knownPool.token1),
            lpTokenAddress: r.resourceAddress,
            amount: r.amount,
            url: `${DEX_URL.caviar}${knownPool.address}`,
          });
          continue;
        }
      }

      // ── Ociswap BasicPool ──
      if (name.includes("Ociswap LP") && !tags.includes("precision-pool")) {
        const knownPool = RESOURCE_POOL_MAP.get(pool);
        if (knownPool) {
          positions.push({
            type: "fungible",
            protocol: "ociswap",
            dex: "Ociswap BasicPool",
            poolAddress: knownPool.address,
            tokenA: resolveTokenSymbol(knownPool.token0),
            tokenB: resolveTokenSymbol(knownPool.token1),
            lpTokenAddress: r.resourceAddress,
            amount: r.amount,
            url: `${DEX_URL.ociswap}${knownPool.address}`,
          });
        }
        continue;
      }
    }
  }

  // ── NFTs desconocidos → posibles LP receipts ──────────────────────────────
  const unknownNfts = balance.nfts.filter(n =>
    n.resourceAddress !== CREDIT_RECEIPT_RESOURCE
  );

  console.log("=== unknownNfts ===", unknownNfts.map(n => n.resourceAddress));

  // LSU Pool Credit Receipt
  const lsuReceipt = balance.nfts.find(n => n.resourceAddress === CREDIT_RECEIPT_RESOURCE);
  if (lsuReceipt && lsuReceipt.ids.length > 0) {
    positions.push({
      type: "nft",
      protocol: "caviar_lsupool",
      dex: "Caviar LSU Pool",
      poolAddress: LSU_POOL_ADDRESS,
      tokenA: "LSU",
      tokenB: "LSULP",
      lpTokenAddress: CREDIT_RECEIPT_RESOURCE,
      nftIds: lsuReceipt.ids,
      lpNftId: lsuReceipt.ids[0],
      url: "https://caviar.fi/earn/lsu-pool",
    });
  }

  if (unknownNfts.length > 0) {
    const metaMap = await fetchResourceMetadata(
      unknownNfts.map(n => n.resourceAddress),
      gatewayUrl
    );

    for (const n of unknownNfts) {
      const meta = metaMap.get(n.resourceAddress);
      if (!meta) continue;

      const name     = meta["name"] ?? "";
      const symbol   = meta["symbol"] ?? "";
      const pool     = meta["pool"] ?? "";
      const component = meta["component"] ?? "";
      const pkg      = meta["package"] ?? "";
      const tags     = meta["_tags"] ?? "";

      // ── Caviar QuantaSwap receipt ──
      if (pkg === CAVIAR_QUANTASWAP_PACKAGE || name.includes("Liquidity Receipt")) {
        const knownPool = COMPONENT_MAP.get(component);
        positions.push({
          type: "nft",
          protocol: "caviar_quantaswap",
          dex: "Caviar QuantaSwap",
          poolAddress: component,
          tokenA: knownPool ? resolveTokenSymbol(knownPool.token0) : meta["token_x"]?.slice(-6) ?? "tokenX",
          tokenB: knownPool ? resolveTokenSymbol(knownPool.token1) : meta["token_y"]?.slice(-6) ?? "tokenY",
          lpTokenAddress: n.resourceAddress,
          nftIds: n.ids,
          lpNftId: n.ids[0],
          url: component ? `${DEX_URL.caviar_quantaswap}${component}` : undefined,
        });
        continue;
      }

      // ── Ociswap PrecisionPool ──
   // ── Ociswap PrecisionPool ──
      if (pkg === OCISWAP_PRECISION_PACKAGE || tags.includes("precision-pool") || name.includes("Ociswap LP")) {
        const knownPool = COMPONENT_MAP.get(pool);
        positions.push({
          type: "nft",
          protocol: "ociswap_precision",
          dex: "Ociswap PrecisionPool",
          poolAddress: pool,
          tokenA: knownPool ? resolveTokenSymbol(knownPool.token0) : "tokenX",
          tokenB: knownPool ? resolveTokenSymbol(knownPool.token1) : "tokenY",
          lpTokenAddress: n.resourceAddress,
          nftIds: n.ids,
          lpNftId: n.ids[0],
          url: pool ? `${DEX_URL.ociswap_precision}${pool}` : undefined,
        });
        continue;
      }
    }
  }

  return positions;
}
