export interface StakeParams {
  validatorAddress: string;
  amount: string;
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
}

export interface UnstakeParams {
  validatorAddress: string;
  lsuAmount: string;
  lsuResourceAddress: string;
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
}

export interface ClaimParams {
  validatorAddress: string;
  claimNftResourceAddress: string;
  claimNftIds: string[];
  vaultAddress: string;
  notarizerAddress: string;
  badgeResourceAddress: string;
  badgeLocalId: string;
}

export interface StakeResult {
  manifest: string;
  description: string;
}

export interface Pool {
  poolAddress: string;
  name: string;
  tokenAAddress: string;
  tokenBAddress: string;
  lpTokenAddress: string;
  protocol: LiquidityProtocol;
}

export type LiquidityProtocol = "ociswap" | "defiPlaza" | "caviar"| "ociswap_precision" | "caviar_quantaswap" | "caviar_lsupool";

export interface AddLiquidityParams {
  poolAddress: string;
  tokenAAddress: string;
  tokenBAddress: string;
  amountA: string;
  amountB: string;
  vaultAddress: string;
  notarizerAddress: string;
}

export interface RemoveLiquidityParams {
  poolAddress: string;
  lpTokenAddress: string;
  lpAmount: string;
  vaultAddress: string;
  notarizerAddress: string;
}

export interface LiquidityResult {
  manifest: string;
  description: string;
}

export interface LiquidityProvider {
  protocol: LiquidityProtocol;
  getPools(): Promise<Pool[]>;
  addLiquidity(params: AddLiquidityParams): Promise<LiquidityResult>;
  removeLiquidity(params: RemoveLiquidityParams): Promise<LiquidityResult>;
}

export interface MCPToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function mcpOk(text: string): MCPToolResult {
  return { content: [{ type: "text", text }] };
}

export function mcpError(message: string): MCPToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
