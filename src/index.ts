// AgentWallet for Radix — Main Entry Point
// GPL v3 License — SDK only. Contract is proprietary.

// Core
export { AgentWallet } from "./core/AgentWallet";
export { AGGRClient } from "./core/AGGRClient";
export { RadixClient } from "./core/RadixClient";



// Tools para frameworks de agentes
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



// Tipos e interfaces
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

// Assets por defecto
export { DEFAULT_ASSETS } from "./types";
