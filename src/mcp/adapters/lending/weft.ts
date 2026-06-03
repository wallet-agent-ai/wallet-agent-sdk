// ─── WEFT Finance Lending Adapter ─────────────────────────────────────────────
// Implementa supply (lending), withdraw, create_cdp, manage_cdp y get_cdp_health
// para el protocolo WEFT Finance V2 en Radix.
//
// Componentes stokenet:
//   Lending Market:  component_tdx_2_1czjla2sp8uamjaex0mtt65xtztyhtyk02wv0lxntz90qtst6w0kf57
//   Lending Pool:    component_tdx_2_1crrha0f0s7gayclln3f2s4xmpz3ja5lph2prmavkdsfwc05sun0t8t
//   CDP NFT:         resource_tdx_2_1nt9m3l9t9gues9rx02e3d8qezk0r9w2jy5fwpr6rwflsjmlyjkey55
//
// Componentes mainnet:
//   Lending Market:  component_rdx1cpy6putj5p7937clqgcgutza7k53zpha039n9u5hkk0ahh4stdmq4w
//   Lending Pool:    component_rdx1czmr02yl4da709ceftnm9dnmag7rthu0tu78wmtsn5us9j02d9d0xn
//   CDP NFT:         resource_rdx1nt22yfvhuuhxww7jnnml5ec3yt5pkxh0qlghm6f0hz46z2wfk80s9r
//
// Flujos soportados:
//   1. supply()       — depositar tokens en el lending pool → recibir w2-tokens (Deposit Units)
//   2. withdraw()     — redimir w2-tokens → recuperar tokens + intereses
//   3. createCdp()    — crear CDP con colateral inicial (opcionalmente pedir prestado)
//   4. manageCdp()    — añadir colateral / pedir prestado / repagar / retirar colateral
//   5. getCdpHealth() — consultar estado del CDP via transaction/preview
// ─────────────────────────────────────────────────────────────────────────────

import type { LiquidityResult, MCPToolResult } from "../../types";
import { mcpOk, mcpError } from "../../types";
import { safeDecimal,safeDecimalCeil } from "../../../tools/utils.js";

// ─── Constantes por red ───────────────────────────────────────────────────────

const WEFT_ADDRESSES = {
  stokenet: {
    lendingMarket:
      "component_tdx_2_1czjla2sp8uamjaex0mtt65xtztyhtyk02wv0lxntz90qtst6w0kf57",
    lendingPool:
      "component_tdx_2_1crrha0f0s7gayclln3f2s4xmpz3ja5lph2prmavkdsfwc05sun0t8t",
    cdpResource:
      "resource_tdx_2_1nt9m3l9t9gues9rx02e3d8qezk0r9w2jy5fwpr6rwflsjmlyjkey55",
    transientResource:
      "resource_tdx_2_1n2507ke7qsjggtwqwe6cghep669wlcrvv3t7gxvmxy75lms8ezza7d",
  },
  mainnet: {
    lendingMarket:
      "component_rdx1cpy6putj5p7937clqgcgutza7k53zpha039n9u5hkk0ahh4stdmq4w",
    lendingPool:
      "component_rdx1czmr02yl4da709ceftnm9dnmag7rthu0tu78wmtsn5us9j02d9d0xn",
    cdpResource:
      "resource_rdx1nt22yfvhuuhxww7jnnml5ec3yt5pkxh0qlghm6f0hz46z2wfk80s9r",
    transientResource:
      "resource_rdx1ng4qjg5yec433ckp2xpdgvc6j4gpjexx42svly67dmyt5mx80f68as",
  },
} as const;

// Recursos soportados en stokenet
const STOKENET_RESOURCES: Record<string, { symbol: string; depositUnit?: string }> = {
  "resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc": {
    symbol: "XRD",
    depositUnit: "resource_tdx_2_1th8sk9ll6tk8p3ms77ez2vtwdzytc5jjdjul38vcsd67qs7h6g0z2u",
  },
  "resource_tdx_2_1tk903dr7agsg65v8h8he6kdhwlsctedxq0fuec0aufagr2xeyhs5ur": {
    symbol: "xUSDC",
  },
  "resource_tdx_2_1tkenhqw8aq05fm7m50ckg6f7whsfw8l2kqs0hprx8dncxmefv9lf2w": {
    symbol: "xUSDT",
  },
  "resource_tdx_2_1t4w276lkyvvs8rfym22q37dh7jsn7tlhue0c3shjuchlqtm0jugx4s": {
    symbol: "xWBTC",
  },
  "resource_tdx_2_1thf8h2npjhfp8jeqc4tq20yxm4j3cnwd0urpg0dsg2cy56yjn0n388": {
    symbol: "xETH",
  },
};

// Recursos soportados en mainnet
export const MAINNET_RESOURCES: Record<string, { symbol: string; depositUnit?: string }> = {
  "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd": {
    symbol: "XRD",
    depositUnit: "resource_rdx1th0gjs665xgm343j4jee7k8apu8l8pg9cf8x587qprszeeknu8wsxz",
  },

  "resource_rdx1t58kkcqdz0mavfz98m98qh9m4jexyl9tacsvlhns6yxs4r6hrm5re5": {
    symbol: "HWBTC",
    depositUnit: "resource_rdx1t4y98gg8r4mvlaf6tyut0natx874er06qy84ct3d5dvg0c3j2d6d4s",
  },
  "resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv": {
    symbol: "HUSDC",
    depositUnit: "resource_rdx1t4kxe9n00hgzng02myj6a320qxcma2umxj8ygr795cc5m0hsj3p4l2",
  },
  "resource_rdx1th4v03gezwgzkuma6p38lnum8ww8t4ds9nvcrkr2p9ft6kxx3kxvhe": {
    symbol: "HUSDT",
    depositUnit: "resource_rdx1t48fy4e7d0zfzkky5yxvgaxvewp65ecv49vtccyawlulhegk3sw7kz" ,
  },
  "resource_rdx1th09yvv7tgsrv708ffsgqjjf2mhy84mscmj5jwu4g670fh3e5zgef0": {
    symbol: "HETH",
    depositUnit: "resource_rdx1t5tcgsd0m6ptqsd0g70xu08tzdhy23ml5ql9xlmmv9wpchg3lw7dtk",
  },
  "resource_rdx1t5ljlq97xfcewcdjxsqld89443fchqg96xv8a8k8gdftdycy9haxpx": {
    symbol: "HSOL",
    depositUnit: "resource_rdx1th9rpfyjcuu8w0hypaf4l3ywy26n6nt8hsavuksmjthcyc8unmlccc",
  },
  
  "resource_rdx1t4upr78guuapv5ept7d7ptekk9mqhy605zgms33mcszen8l9fac8vf": {
    symbol: "xUSDC",
    depositUnit: "resource_rdx1thw2u4uss739j8cqumehgf5wyw26chcfu98newsu42zhln7wd050ee",
  },
  "resource_rdx1thrvr3xfs2tarm2dl9emvs26vjqxu6mqvfgvqjne940jv0lnrrg7rw": {
    symbol: "xUSDT",
    depositUnit: "resource_rdx1t5ljp8amkf76mrn5txmmemkrmjwt5r0ajjnljvyunh27gm0n295dfn",
  },
  "resource_rdx1t580qxc7upat7lww4l2c4jckacafjeudxj5wpjrrct0p3e82sq4y75": {
    symbol: "xWBTC",
    depositUnit: "resource_rdx1thyes252jplxhu8qvfx6k3wkmlhy2f09nfqqefuj2a73l79e0af99t",
  },
  "resource_rdx1th88qcj5syl9ghka2g9l7tw497vy5x6zaatyvgfkwcfe8n9jt2npww": {
    symbol: "xETH",
    depositUnit: "resource_rdx1t456hgpk6kwn4lqut5p2mqqmuuwngzhwxlgyyk9dwv4t5hmp37d7xf",
  },
  
  "resource_rdx1tk3fxrz75ghllrqhyq8e574rkf4lsq2x5a0vegxwlh3defv225cth3": {
    symbol: "WEFT",
  },
  "resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf": {
    symbol: "LSULP",
    depositUnit: "resource_rdx1t4p82pms6r20k87rscms728tekujacd0sgxyysk7yvl0jgf56gvjuc",
  },
};

/** Set of token addresses supported by WEFT Finance as collateral (mainnet) */
export const WEFT_SUPPORTED_ADDRESSES: Set<string> = new Set(
  Object.keys(MAINNET_RESOURCES)
);

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface WeftSupplyParams {
  tokenAddress: string;
  amount: string;
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
  gatewayUrl: string;
}

export interface WeftWithdrawParams {
  depositUnitAddress: string; // w2-token address
  amount: string;
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
  gatewayUrl: string;
}

export interface WeftCreateCdpParams {
  // Colaterales a depositar (al menos 1)
  collaterals: Array<{ tokenAddress: string; amount: string }>;
  // Préstamos a pedir (opcional)
  borrows?: Array<{ tokenAddress: string; amount: string }>;
  // Nombre del CDP (opcional)
  cdpName?: string;
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
  gatewayUrl: string;
}

export interface WeftManageCdpParams {
  cdpId: string; // e.g. "#1449#" o "{uuid...}"
  // Colaterales a añadir
  addCollaterals?: Array<{ tokenAddress: string; amount: string }>;
  // Colaterales a retirar: Map<resourceAddress, amount>
  removeCollaterals?: Array<{ tokenAddress: string; amount: string }>;
  // Préstamos a pedir: Map<resourceAddress, amount>
  borrows?: Array<{ tokenAddress: string; amount: string }>;
  // Repagar préstamos (buckets a devolver)
  repayments?: Array<{ tokenAddress: string; amount: string }>;
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
  gatewayUrl: string;
}

export interface WeftBurnCdpParams {
  cdpId: string;
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
  gatewayUrl: string;
}

export interface WeftCdpHealthParams {
  cdpId: string;
  gatewayUrl: string;
}

export interface CdpHealth {
  id: string;
  totalLoanValue: string;
  totalCollateralValue: string;
  healthLtv: string;
  liquidationLtv: string;
  isHealthy: boolean;
  loanPositions: Record<string, string>; // resourceAddress → amount
  collateralPositions: Record<string, string>; // resourceAddress → amount
}

// ─── Helper: detectar red por gatewayUrl ─────────────────────────────────────

function getAddresses(gatewayUrl: string) {
  return gatewayUrl.includes("stokenet")
    ? WEFT_ADDRESSES.stokenet
    : WEFT_ADDRESSES.mainnet;
}

export function getResources(gatewayUrl: string) {
  return gatewayUrl.includes("stokenet") ? STOKENET_RESOURCES : MAINNET_RESOURCES;
}

// ─── Helper: resolver símbolo o address ──────────────────────────────────────
// Acepta tanto "XRD" como el resource address completo.
// Permite que el LLM pase símbolos sin entrar en bucle buscando addresses.

function resolveToken(input: string, gatewayUrl: string): string {
  if (input.startsWith("resource_")) return input;
  const resources = getResources(gatewayUrl);
  const entry = Object.entries(resources).find(
    ([_, info]) => info.symbol.toLowerCase() === input.toLowerCase()
  );
  if (entry) return entry[0];
  throw new Error(
    `Token '${input}' not recognized. Supported: ${Object.values(resources).map(r => r.symbol).join(", ")}`
  );
}

function resolveTokenList(
  items: Array<{ tokenAddress: string; amount: string }>,
  gatewayUrl: string
): Array<{ tokenAddress: string; amount: string }> {
  return items.map(item => ({
    tokenAddress: resolveToken(item.tokenAddress, gatewayUrl),
    amount: item.amount,
  }));
}

// ─── Helper: fee lock base ────────────────────────────────────────────────────

function feeLock(notarizerAddress: string, vaultAddress: string): string {
  return `CALL_METHOD
    Address("${notarizerAddress}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${vaultAddress}")
    "lock_fee"
    Decimal("8")
;`;
}

function agentProof(notarizerAddress: string, badgeResourceAddress: string, badgeLocalId: string): string {
  return `CALL_METHOD
    Address("${notarizerAddress}")
    "create_proof_of_non_fungibles"
    Address("${badgeResourceAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${badgeLocalId}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;`;
}

// ─── 1. SUPPLY — depositar en lending pool ────────────────────────────────────
// Llama a "deposit" en el lending pool.
// Devuelve w2-tokens (Deposit Units) al vault.

export async function weftSupply(params: WeftSupplyParams): Promise<LiquidityResult> {
  const { amount, vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, gatewayUrl } = params;
  const addrs = getAddresses(gatewayUrl);
  const resources = getResources(gatewayUrl);
  const tokenAddress = resolveToken(params.tokenAddress, gatewayUrl);
  const tokenInfo = resources[tokenAddress];

  if (!tokenInfo) {
    throw new Error(`Token ${params.tokenAddress} no está soportado en WEFT. Tokens soportados: ${Object.values(resources).map(r => r.symbol).join(", ")}`);
  }

  const safeAmount = safeDecimal(amount, tokenAddress);

  const manifest = `${feeLock(notarizerAddress, vaultAddress)}
${agentProof(notarizerAddress, badgeResourceAddress, badgeLocalId)}
CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${addrs.lendingPool}")
    Decimal("${safeAmount}")
    Address("${tokenAddress}")
    "supply weft lending"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${tokenAddress}")
    Bucket("token_bucket")
;
CALL_METHOD
    Address("${addrs.lendingPool}")
    "deposit"
    Array<Bucket>(Bucket("token_bucket"))
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

  return {
    manifest,
    description: `WEFT Supply: ${safeAmount} ${tokenInfo.symbol} → lending pool. Recibirás w2-${tokenInfo.symbol} (Deposit Units) con interés acumulado.`,
  };
}

// ─── 2. WITHDRAW — retirar del lending pool ───────────────────────────────────
// Llama a "withdraw" en el lending pool con los w2-tokens.
// Devuelve tokens originales + intereses al vault.

export async function weftWithdraw(params: WeftWithdrawParams): Promise<LiquidityResult> {
  const { depositUnitAddress, amount, vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, gatewayUrl } = params;
  const addrs = getAddresses(gatewayUrl);

  // Truncar a los decimales seguros según el token
  const safeAmount = safeDecimal(amount, depositUnitAddress);

  const manifest = `${feeLock(notarizerAddress, vaultAddress)}
${agentProof(notarizerAddress, badgeResourceAddress, badgeLocalId)}
CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${addrs.lendingPool}")
    Decimal("${safeAmount}")
    Address("${depositUnitAddress}")
    "withdraw weft lending"
    Proof("agent_proof")
;
TAKE_ALL_FROM_WORKTOP
    Address("${depositUnitAddress}")
    Bucket("du_bucket")
;
CALL_METHOD
    Address("${addrs.lendingPool}")
    "withdraw"
    Array<Bucket>(Bucket("du_bucket"))
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

  return {
    manifest,
    description: `WEFT Withdraw: redimir ${safeAmount} Deposit Units → tokens + intereses al vault.`,
  };
}

// ─── 3. CREATE CDP — crear nuevo CDP con colateral ────────────────────────────
// Llama a "create_cdp" en el lending market.
// Crea el CDP NFT (Wefty) y lo deposita en el vault.
// Opcionalmente pide prestado en la misma TX.

export async function weftCreateCdp(params: WeftCreateCdpParams): Promise<LiquidityResult> {
  const {
    collaterals,
    borrows = [],
    cdpName,
    vaultAddress,
    notarizerAddress,
    badgeResourceAddress,
    badgeLocalId,
    gatewayUrl,
  } = params;
  const addrs = getAddresses(gatewayUrl);
  const resources = getResources(gatewayUrl);

  if (collaterals.length === 0) {
    throw new Error("Necesitas al menos un colateral para crear un CDP en WEFT");
  }

  // Resolver símbolos a addresses
  const resolvedCollaterals = resolveTokenList(collaterals, gatewayUrl);
  const resolvedBorrows = borrows.length > 0 ? resolveTokenList(borrows, gatewayUrl) : [];

  // XRD address según red — primer arg de create_cdp es siempre XRD vacío
  const xrdAddress = gatewayUrl.includes("stokenet")
    ? "resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc"
    : "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";

  // Clones del proof — uno para XRD vacío + uno por cada colateral
  const proofClones = [
    `CLONE_PROOF Proof("agent_proof") Proof("proof_xrd_empty");`,
    ...resolvedCollaterals.map((_, i) =>
      `CLONE_PROOF Proof("agent_proof") Proof("proof_col_${i}");`
    ),
  ].join("\n");

  // Transfers del vault al worktop — uno por colateral, cada uno con su proof clonado
  const transferLines = resolvedCollaterals.map((c, i) => {
    const sym = resources[c.tokenAddress]?.symbol ?? c.tokenAddress;
    const safeAmount = safeDecimal(c.amount, c.tokenAddress);
    return `CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${addrs.lendingMarket}")
    Decimal("${safeAmount}")
    Address("${c.tokenAddress}")
    "collateral cdp ${sym}"
    Proof("proof_col_${i}")
;
TAKE_ALL_FROM_WORKTOP
    Address("${c.tokenAddress}")
    Bucket("col_bucket_${i}")
;`;
  }).join("\n");

  // Todos los colaterales van en el Array<Bucket>
  const colBuckets = resolvedCollaterals
    .map((_, i) => `Bucket("col_bucket_${i}")`)
    .join(",\n        ");

  // Map de préstamos (si hay) — también con safeDecimal
  const borrowMap = resolvedBorrows.length > 0
    ? `Map<Address, Decimal>(\n        ${resolvedBorrows.map(b =>
        `Address("${b.tokenAddress}") => Decimal("${safeDecimal(b.amount, b.tokenAddress)}")`
      ).join(",\n        ")}\n    )`
    : `Map<Address, Decimal>()`;

  // Nombre del CDP
  const nameEnum = cdpName
    ? `Enum<1u8>(\n        "${cdpName}"\n    )`
    : `Enum<1u8>(\n        "agentWallet_${Date.now()}"\n    )`;

  const manifest = `${feeLock(notarizerAddress, vaultAddress)}
${agentProof(notarizerAddress, badgeResourceAddress, badgeLocalId)}
${proofClones}
CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${addrs.lendingMarket}")
    Decimal("0")
    Address("${xrdAddress}")
    "xrd empty"
    Proof("proof_xrd_empty")
;
TAKE_FROM_WORKTOP
    Address("${xrdAddress}")
    Decimal("0")
    Bucket("xrd_empty")
;
${transferLines}
CALL_METHOD
    Address("${addrs.lendingMarket}")
    "create_cdp"
    Bucket("xrd_empty")
    ${nameEnum}
    Enum<0u8>()
    Enum<0u8>()
    Array<Bucket>(
        ${colBuckets}
    )
    Array<Bucket>()
    ${borrowMap}
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

  const colDesc = resolvedCollaterals.map(c => `${safeDecimal(c.amount, c.tokenAddress)} ${resources[c.tokenAddress]?.symbol ?? c.tokenAddress}`).join(" + ");
  const borDesc = borrows.length > 0
    ? ` | Préstamo: ${resolvedBorrows.map(b => `${safeDecimal(b.amount, b.tokenAddress)} ${resources[b.tokenAddress]?.symbol ?? b.tokenAddress}`).join(" + ")}`
    : "";

  return {
    manifest,
    description: `WEFT Create CDP: colateral ${colDesc}${borDesc}. El CDP NFT se guardará en tu vault.`,
  };
}

// ─── 4. MANAGE CDP — operar sobre CDP existente ───────────────────────────────
// Llama a "cdp_batch_operation" en el lending market.
// Permite en una sola TX: añadir colateral, retirar colateral, pedir prestado, repagar.

export async function weftManageCdp(params: WeftManageCdpParams): Promise<LiquidityResult> {
  const {
    cdpId,
    addCollaterals = [],
    removeCollaterals = [],
    borrows = [],
    repayments = [],
    vaultAddress,
    notarizerAddress,
    badgeResourceAddress,
    badgeLocalId,
    gatewayUrl,
  } = params;
  const addrs = getAddresses(gatewayUrl);
  const resources = getResources(gatewayUrl);

  if (addCollaterals.length === 0 && removeCollaterals.length === 0 && borrows.length === 0 && repayments.length === 0) {
    throw new Error("Debes especificar al menos una operación: añadir colateral, retirar colateral, pedir prestado o repagar");
  }

  // Resolver símbolos a addresses
  const resolvedAddCollaterals = addCollaterals.length > 0 ? resolveTokenList(addCollaterals, gatewayUrl) : [];
  const resolvedRemoveCollaterals = removeCollaterals.length > 0 ? resolveTokenList(removeCollaterals, gatewayUrl) : [];
  const resolvedBorrows = borrows.length > 0 ? resolveTokenList(borrows, gatewayUrl) : [];
  const resolvedRepayments = repayments.length > 0 ? resolveTokenList(repayments, gatewayUrl) : [];

  // Clones del proof — uno por cada transfer (colaterales + repagos)
  const totalTransfers = resolvedAddCollaterals.length + resolvedRepayments.length;
  const proofClones = totalTransfers > 1
    ? Array.from({ length: totalTransfers }, (_, i) =>
        `CLONE_PROOF Proof("agent_proof") Proof("proof_transfer_${i}");`
      ).join("\n")
    : "";

  // Proof del CDP NFT del vault
  const cdpProofLines = `CALL_METHOD
    Address("${vaultAddress}")
    "create_proof_of_non_fungibles"
    Address("${addrs.cdpResource}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${cdpId}"))
;
POP_FROM_AUTH_ZONE
    Proof("cdp_proof")
;`;

  // Transfers de colaterales a añadir
  let proofIdx = 0;
  const addColTransfers = resolvedAddCollaterals.map((c, i) => {
    const sym = resources[c.tokenAddress]?.symbol ?? c.tokenAddress;
    const proof = totalTransfers > 1 ? `Proof("proof_transfer_${proofIdx++}")` : `Proof("agent_proof")`;
    const safeAmount = safeDecimal(c.amount, c.tokenAddress);
    return `CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${addrs.lendingMarket}")
    Decimal("${safeAmount}")
    Address("${c.tokenAddress}")
    "add collateral ${sym}"
    ${proof}
;
TAKE_ALL_FROM_WORKTOP
    Address("${c.tokenAddress}")
    Bucket("add_col_${i}")
;`;
  }).join("\n");

  // Transfers de repagos
  const repayTransfers = resolvedRepayments.map((r, i) => {
    const sym = resources[r.tokenAddress]?.symbol ?? r.tokenAddress;
    const proof = totalTransfers > 1 ? `Proof("proof_transfer_${proofIdx++}")` : `Proof("agent_proof")`;
    //const safeAmount = safeDecimalCeil(r.amount, r.tokenAddress);
    // Para repayments — transferir amount + pequeño buffer del 0.1% para cubrir intereses acumulados
const safeAmount = safeDecimalCeil(
  (parseFloat(r.amount) * 1.001).toString(),  // +0.1% buffer
  r.tokenAddress
);

    return `CALL_METHOD
    Address("${vaultAddress}")
    "transfer"
    Address("${addrs.lendingMarket}")
    Decimal("${safeAmount}")
    Address("${r.tokenAddress}")
    "repay loan ${sym}"
    ${proof}
;
TAKE_ALL_FROM_WORKTOP
    Address("${r.tokenAddress}")
    Bucket("repay_${i}")
;`;
  }).join("\n");

  // Arrays para cdp_batch_operation
  const addColBuckets = resolvedAddCollaterals.length > 0
    ? `Array<Bucket>(\n        ${resolvedAddCollaterals.map((_, i) => `Bucket("add_col_${i}")`).join(",\n        ")}\n    )`
    : `Array<Bucket>()`;

  const repayBuckets = resolvedRepayments.length > 0
    ? `Array<Bucket>(\n        ${resolvedRepayments.map((_, i) => `Bucket("repay_${i}")`).join(",\n        ")}\n    )`
    : `Array<Bucket>()`;

  // borrows con safeDecimal
  const borrowMap = resolvedBorrows.length > 0
    ? `Map<Address, Decimal>(\n        ${resolvedBorrows.map(b =>
        `Address("${b.tokenAddress}") => Decimal("${safeDecimal(b.amount, b.tokenAddress)}")`
      ).join(",\n        ")}\n    )`
    : `Map<Address, Decimal>()`;

  // removeCollaterals con safeDecimal
  const removeMap = resolvedRemoveCollaterals.length > 0
    ? `Map<Address, Decimal>(\n        ${resolvedRemoveCollaterals.map(r =>
        `Address("${r.tokenAddress}") => Decimal("${safeDecimal(r.amount, r.tokenAddress)}")`
      ).join(",\n        ")}\n    )`
    : `Map<Address, Decimal>()`;

  const manifest = `${feeLock(notarizerAddress, vaultAddress)}
${agentProof(notarizerAddress, badgeResourceAddress, badgeLocalId)}
${proofClones}
${cdpProofLines}
${addColTransfers}
${repayTransfers}
CALL_METHOD
    Address("${addrs.lendingMarket}")
    "cdp_batch_operation"
    Proof("cdp_proof")
    ${addColBuckets}
    Array<Bucket>()
    ${borrowMap}
    ${repayBuckets}
    ${removeMap}
    Map<Address, Array>()
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

  // Descripción
  const ops: string[] = [];
  if (resolvedAddCollaterals.length > 0) ops.push(`+colateral: ${resolvedAddCollaterals.map(c => `${safeDecimal(c.amount, c.tokenAddress)} ${resources[c.tokenAddress]?.symbol ?? "?"}`).join(", ")}`);
  if (resolvedBorrows.length > 0) ops.push(`prestado: ${resolvedBorrows.map(b => `${safeDecimal(b.amount, b.tokenAddress)} ${resources[b.tokenAddress]?.symbol ?? "?"}`).join(", ")}`);
  if (resolvedRepayments.length > 0) ops.push(`repago: ${resolvedRepayments.map(r => `${safeDecimalCeil(r.amount, r.tokenAddress)} ${resources[r.tokenAddress]?.symbol ?? "?"}`).join(", ")}`);
  if (resolvedRemoveCollaterals.length > 0) ops.push(`-colateral: ${resolvedRemoveCollaterals.map(r => `${safeDecimal(r.amount, r.tokenAddress)} ${resources[r.tokenAddress]?.symbol ?? "?"}`).join(", ")}`);

  return {
    manifest,
    description: `WEFT Manage CDP ${cdpId}: ${ops.join(" | ")}`,
  };
}

// ─── 5. GET CDP HEALTH — consultar estado via preview ─────────────────────────
// Llama a "get_cdp" via transaction/preview.
// Decodifica la respuesta para extraer health LTV, posiciones, etc.


export async function weftBurnCdp(params: WeftBurnCdpParams): Promise<LiquidityResult> {
  const {
    cdpId,
    vaultAddress,
    notarizerAddress,
    badgeResourceAddress,
    badgeLocalId,
    gatewayUrl,
  } = params;

  const addrs = getAddresses(gatewayUrl);

  // burn_cdp es PUBLIC en WEFT — no requiere roles especiales.
  // Solo necesita el NFT del CDP como Bucket.
  // El CDP debe estar vacío (sin colateral ni deuda) para poder quemar.

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
    "transfer_nft_liquidity"
    Address("${addrs.lendingMarket}")
    Address("${addrs.cdpResource}")
    NonFungibleLocalId("${cdpId}")
    "burn cdp ${cdpId}"
    Proof("agent_proof")
;
TAKE_NON_FUNGIBLES_FROM_WORKTOP
    Address("${addrs.cdpResource}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${cdpId}"))
    Bucket("cdp_bucket")
;
CALL_METHOD
    Address("${addrs.lendingMarket}")
    "burn_cdp"
    Bucket("cdp_bucket")
;
CALL_METHOD
    Address("${vaultAddress}")
    "deposit_any"
    Expression("ENTIRE_WORKTOP")
;`;

  return {
    manifest,
    description: `WEFT burn_cdp: CDP ${cdpId} quemado y eliminado del vault.`,
  };
}

export async function weftGetCdpHealth(params: WeftCdpHealthParams): Promise<CdpHealth> {
  const { cdpId, gatewayUrl } = params;
  const addrs = getAddresses(gatewayUrl);
  const isStokenet = gatewayUrl.includes("stokenet");
  const networkId = isStokenet ? "stokenet" : "mainnet";

  const manifest = `CALL_METHOD
    Address("${addrs.lendingMarket}")
    "get_cdp"
    Array<NonFungibleLocalId>(NonFungibleLocalId("${cdpId}"))
;`;

// ── Timeout 15s ──
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let data: any;
  try {
    const response = await fetch(`${gatewayUrl}/transaction/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        manifest,
        start_epoch_inclusive: 1,
        end_epoch_exclusive: 255,
        network_id: networkId,
        signer_public_keys: [{
          key_type: "EcdsaSecp256k1",
          key_hex: "02a1b3f9482e376b3e5fd2f48a2c4a679c6cf2c8f7b2dd12c14f75d15df3ac59d1",
        }],
        nonce: Math.floor(Math.random() * 1000000),
        tip_percentage: 0,
        flags: {
          use_free_credit: true,
          assume_all_signature_proofs: true,
          skip_epoch_check: true,
        },
      }),
    });
    data = await response.json() as any;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`CDP health check timeout — Gateway no respondió en 15s. Intenta de nuevo.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const outputs = data?.receipt?.output ?? [];

  // Extraer entries del output — get_cdp devuelve un Map, tomamos el primer entry
  let cdpFields: any[] = [];
  for (const output of outputs) {
    const entries = output?.programmatic_json?.entries;
    if (entries && Array.isArray(entries) && entries.length > 0) {
      cdpFields = entries[0]?.value?.fields ?? [];
      if (cdpFields.length > 0) break;
    }
  }

  // Si no hay entries, loggear el output raw para debug
  if (cdpFields.length === 0) {
    const raw = JSON.stringify(data?.receipt?.output ?? [], null, 2);
    throw new Error(`CDP ${cdpId} no encontrado. Output raw:\n${raw.slice(0, 500)}`);
  }

  // Extraer valores básicos (siguiendo el mismo orden que decode.rs)
  const getVal = (i: number): string =>
    cdpFields[i]?.value?.toString() ?? "0";

  const totalLoanValue = getVal(0);
  const totalCollateralValue = getVal(2);
  const healthLtv = getVal(7);
  const liquidationLtv = getVal(8);

  // Loan positions (índice 11)
  const loanPositions: Record<string, string> = {};
  const loanEntries = cdpFields[11]?.entries ?? [];
  for (const entry of loanEntries) {
    const addr = entry?.key?.value ?? "";
    const amount = entry?.value?.fields?.[2]?.value ?? "0"; // amount field
    if (addr) loanPositions[addr] = amount;
  }

  // Collateral positions (índice 12)
  const collateralPositions: Record<string, string> = {};
  const colEntries = cdpFields[12]?.entries ?? [];
  for (const entry of colEntries) {
    const addr = entry?.key?.value ?? "";
    const amount = entry?.value?.fields?.[1]?.value ?? "0"; // amount field
    if (addr) collateralPositions[addr] = amount;
  }

  const ltvNum = parseFloat(liquidationLtv);
  const isHealthy = isNaN(ltvNum) || ltvNum <= 1;

  return {
    id: cdpId,
    totalLoanValue,
    totalCollateralValue,
    healthLtv,
    liquidationLtv,
    isHealthy,
    loanPositions,
    collateralPositions,
  };
}

// ─── Utilidades públicas ──────────────────────────────────────────────────────

export function getSupportedTokens(gatewayUrl: string): string {
  const resources = getResources(gatewayUrl);
  return Object.entries(resources)
    .map(([addr, info]) => `${info.symbol}: ${addr}`)
    .join("\n");
}

export function getWeftAddresses(gatewayUrl: string) {
  return getAddresses(gatewayUrl);
}
