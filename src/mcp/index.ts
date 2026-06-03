// ─── MCP Index — AgentWallet Radix v2.0 ──────────────────────────────────────
// Punto de entrada para tipos e interfaces MCP.
// Las tools se registran automáticamente via createAgentWalletTools() en LangChainTools.ts.

export { createStakingTools, createStakeXrdTool, createUnstakeXrdTool, createClaimXrdTool } from "./tools/staking";
export { createLiquidityTools,  createAddLiquidityTool, createRemoveLiquidityTool } from "./tools/liquidity";
export { genericStakingAdapter } from "./adapters/staking/generic";
export { ociswapAdapter } from "./adapters/liquidity/ociswap";
export { getAdapter, getAllPools, getSupportedProtocols } from "./adapters/liquidity/registry";

export { DefiPlazaAdapter } from "./adapters/liquidity/defiplaza";

export type {
  StakeParams,
  UnstakeParams,
  ClaimParams,
  StakeResult,
  Pool,
  LiquidityProtocol,
  AddLiquidityParams,
  RemoveLiquidityParams,
  LiquidityResult,
  LiquidityProvider,
  MCPToolResult,
} from "./types";

export { mcpOk, mcpError } from "./types";

// ─── WEFT Lending v2 ──────────────────────────────────────────────────────────
export {
  createWeftLendingTools,
  createWeftSupplyTool,
  createWeftWithdrawTool,
  createWeftCreateCdpTool,
  createWeftManageCdpTool,
  createWeftCdpHealthTool,
} from "./tools/lending";
export {
  weftSupply,
  weftWithdraw,
  weftCreateCdp,
  weftManageCdp,
  weftGetCdpHealth,
  getSupportedTokens,
  getWeftAddresses,
} from "./adapters/lending/weft";

export { createWeftLendingTools, createWeftSupplyTool, createWeftWithdrawTool, createWeftCreateCdpTool, createWeftManageCdpTool, createWeftCdpHealthTool,createWeftGetSupportedTokensTool } from "./tools/lending";
export { weftSupply, weftWithdraw, weftCreateCdp, weftManageCdp, weftGetCdpHealth } from "./adapters/lending/weft";

export { getTwoPoolAdapter, TwoPoolAdapter, fetchPoolInfo, KNOWN_POOLS } from "./adapters/liquidity/twopool";
export type { TwoPoolInfo, TwoPoolProtocol } from "./adapters/liquidity/twopool";

export { getPrecisionAdapter, OciswapPrecisionAdapter, fetchPrecisionPoolInfo, KNOWN_PRECISION_POOLS, getDefaultTickRange } from "./adapters/liquidity/ociswap_precision";
export type { PrecisionPoolInfo } from "./adapters/liquidity/ociswap_precision";

export { getQuantaSwapAdapter, CaviarQuantaSwapAdapter, fetchQuantaSwapInfo, KNOWN_QUANTASWAP_POOLS, calculateBinAllocations } from "./adapters/liquidity/caviar_quantaswap";
export type { QuantaSwapInfo, BinAllocation } from "./adapters/liquidity/caviar_quantaswap";

export { getLsuPoolAdapter, CaviarLsuPoolAdapter, LSU_POOL_ADDRESS, LSULP_RESOURCE, CREDIT_RECEIPT_RESOURCE } from "./adapters/liquidity/caviar_lsupool";
export type { LsuPoolAddParams, LsuPoolRemoveParams } from "./adapters/liquidity/caviar_lsupool";

