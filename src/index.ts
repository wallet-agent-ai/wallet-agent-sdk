// AgentWallet for Radix — Main Entry Point v2.0
// GPL v3 License — SDK only. Contract is proprietary.

// ─── Core ─────────────────────────────────────────────────────────────────────
export { AgentWallet } from "./core/AgentWallet";
export { AGGRClient } from "./core/AGGRClient";
export { RadixClient } from "./core/RadixClient";

// ─── Tools v1 — transferencias y swaps ───────────────────────────────────────
export {
  createAgentWalletTools,
  createGetConfigTool,
  createBalanceTool,
  createGetWhitelistTool,
  createGetQuoteTool,
  createTransferTool,
  createOwnerApprovalTool,
  createSwapTool,
  createConditionalOrderTool,
  createCancelOrderTool,
  createListOrdersTool,
} from "./tools/LangChainTools";

// ─── MCP Tools v2 — staking y liquidez ───────────────────────────────────────
// ─── MCP Tools v2 — staking y liquidez ───────────────────────────────────────
export {
  createStakingTools,
  createStakeXrdTool,
  createUnstakeXrdTool,
  createClaimXrdTool,
  createLiquidityTools,
  createGetLiquidityPoolsTool,
  createAddLiquidityTool,
  createRemoveLiquidityTool,
  // WEFT LENDING 
  createWeftLendingTools,
  createWeftSupplyTool,
  createWeftWithdrawTool,
  createWeftCreateCdpTool,
  createWeftManageCdpTool,
  createWeftCdpHealthTool,
} from "./mcp";


// ─── Tipos v1 ─────────────────────────────────────────────────────────────────
export type {
  AgentWalletConfig,
  AGGRConfig,
  TransferParams,
  TransferResult,
  SwapParams,
  SwapResult,
  BalanceResult,
  ConditionalOrder,
  NetworkConfig,
  AssetAddresses,
  CustomAssetAddresses,
  SupportedAsset,
  DefaultAsset,
} from "./types";

// ─── Tipos MCP v2 ─────────────────────────────────────────────────────────────
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
} from "./mcp";

import {
  weftLendingTools,
  handleWeftSupply,
  handleWeftWithdraw,
  handleWeftCreateCdp,
  handleWeftManageCdp,
  handleWeftCdpHealth,
} from "./tools/lending";


