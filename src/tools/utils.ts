import { getTokenDivisibility } from "../mcp/known-pools.ts";


export function safeDecimal(amount: string | number, tokenAddress: string): string {
  const divisibility = getTokenDivisibility(tokenAddress);
  const n = parseFloat(amount.toString());
  const factor = Math.pow(10, divisibility);
  return (Math.floor(n * factor) / factor).toString();
}

export function safeDecimalCeil(amount: string | number, tokenAddress: string): string {
  const divisibility = getTokenDivisibility(tokenAddress);
  const n = parseFloat(amount.toString());
  const factor = Math.pow(10, divisibility);
  return (Math.ceil(n * factor) / factor).toString();
}
