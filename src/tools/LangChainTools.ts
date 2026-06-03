import { AgentWallet } from "../core/AgentWallet";
import { SupportedAsset, TransferParams, SwapParams, ConditionalOrder } from "../types";
import { createStakingTools } from "../mcp/tools/staking";
import { createLiquidityTools } from "../mcp/tools/liquidity";
import { createWeftLendingTools } from "../mcp/tools/lending";

// Base tool interface — compatible with any agent framework
// that uses the pattern { name, description, call() }
// No direct LangChain dependency required.

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  call: (params: unknown) => Promise<string>;
}

// ─── Safety checks — called before any TX ────────────────────────────────────
// These prevent the agent from entering retry loops that drain funds via fees.

async function preflightChecks(
  wallet: AgentWallet,
  amount: number,
  asset: string,
  to?: string,
  recipientName?: string
): Promise<{ error: string | null; recipientName?: string }> {

  // 1. Get config and balance
  const config = await wallet.getConfig();
  const balance = await wallet.getBalance();

  // 2. Frozen — hard stop
  if (config.frozen) {
    return {
      error: JSON.stringify({
        success: false,
        error: "The PolicyVault is frozen by the owner. No operations allowed. STOP — do not retry. Notify the user.",
      })
    };
  }

  // 3. XRD balance check — need enough for fees
  const MIN_XRD_FOR_FEES = 10;
const xrdBalance = (balance.balances as any)["XRD"] ?? 0;
const xrdNeeded = asset === "XRD" ? amount + MIN_XRD_FOR_FEES : MIN_XRD_FOR_FEES;

  if (xrdBalance < xrdNeeded) {
    return {
      error: JSON.stringify({
        success: false,
        error: `Insufficient XRD for fees. Available: ${xrdBalance} XRD. Minimum required: ${xrdNeeded} XRD (${MIN_XRD_FOR_FEES} for fees${asset === "XRD" ? ` + ${amount} to transfer` : ""}). STOP — do not retry with smaller amounts. Notify the owner to deposit more XRD.`,
      })
    };
  }

  // 4. Asset balance check
const assetBalance = (balance.balances as any)[asset] ?? 0;


  if (assetBalance < amount) {
    return {
      error: JSON.stringify({
        success: false,
        error: `Insufficient ${asset} balance. Available: ${assetBalance} ${asset}. Requested: ${amount} ${asset}. STOP — do not retry with smaller amounts. Notify the owner to deposit more funds.`,
      })
    };
  }

  // 5. Daily cap check
  if (amount > config.dailyCap) {
    return {
      error: JSON.stringify({
        success: false,
        error: `Amount ${amount} ${asset} exceeds the daily cap of ${config.dailyCap}. STOP — this operation cannot be completed today. Do not split the transfer. Notify the user.`,
      })
    };
  }

  // 6. Whitelist check — both name AND address must match
  if (to && recipientName) {
    const whitelist = await wallet.getWhitelist();
    const whitelisted = whitelist.find((w: any) => w.address === to && w.name === recipientName);

    if (!whitelisted) {
      const addressExists = whitelist.find((w: any) => w.address === to);
      const nameExists = whitelist.find((w: any) => w.name === recipientName);

      let reason = "Address and name do not match any whitelisted entry.";
      if (addressExists && !nameExists) reason = `Address exists but name "${recipientName}" does not match. Expected name: "${addressExists.name}".`;
      if (!addressExists && nameExists) reason = `Name "${recipientName}" exists but address does not match.`;
      if (!addressExists && !nameExists) reason = `Neither address "${to}" nor name "${recipientName}" found in whitelist.`;

      return {
        error: JSON.stringify({
          success: false,
          error: `Whitelist validation failed. ${reason} STOP — do not retry. Verify both the address and name with the owner via the web dashboard.`,
        })
      };
    }

    return { error: null, recipientName: whitelisted.name };
  }

  return { error: null };
}

export function createTransferTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_transfer",
    description: `Transfer tokens to an address on the Radix network.
      Use this tool when you need to make a payment or send funds.
      Available assets: any token in KNOWN_TOKENS — use wallet_balance to see what is available.
      IMPORTANT: You must provide BOTH the recipient name AND address exactly as they appear in the whitelist.
      Both must match — if either is wrong the transfer will be rejected.
      Never split a transfer into multiple transactions.
      If the amount exceeds the multisig threshold, owner approval will be requested automatically — do not retry.`,
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Destination Radix address — must match the whitelisted address exactly",
        },
        recipientName: {
          type: "string",
          description: "Name of the recipient exactly as it appears in the whitelist — must match the address",
        },
        amount: {
          type: "number",
          description: "Amount to transfer — must be the full requested amount, never split",
        },
        asset: {
          type: "string",
          description: "Asset to transfer. Use symbol (XRD, HUSDC) or resource address. Check wallet_balance for available assets.",
        },
        reason: {
          type: "string",
          description: "Reason for the transfer — recorded in the audit log",
        },
      },
      required: ["to", "recipientName", "amount", "asset", "reason"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as TransferParams & { recipientName: string };
      try {
        // ── Safety checks ──
        const preflight = await preflightChecks(wallet, p.amount, p.asset, p.to, p.recipientName);
        if (preflight.error) return preflight.error;

        const config = await wallet.getConfig();

        // ── Multisig threshold — request owner approval, never split ──
        if (p.amount > config.multisigThreshold) {
          const result = await wallet.requestLargeTransfer({
            to: p.to,
            amount: p.amount,
            asset: p.asset,
            reason: p.reason,
          });
          wallet.waitForOwnerApproval(
            { to: result.to, amount: String(result.amount), asset: result.asset, reason: result.reason },
            30000
          );
          return JSON.stringify({
            success: true,
            pending: true,
            message: `Transfer of ${p.amount} ${p.asset} to ${preflight.recipientName} (${p.to}) requires owner approval. The request has been submitted successfully. The owner must go to the web dashboard and approve it. You will be notified when approved or rejected. STOP — do not retry or split.`,
          });
        }

        // ── Normal transfer ──
        const result = await wallet.transfer(p);

        if (result.txId === "pending_owner_approval") {
          wallet.waitForOwnerApproval(
            { to: result.to, amount: String(result.amount), asset: result.asset, reason: result.reason },
            30000
          );
          return JSON.stringify({
            success: false,
            pending: true,
            message: `Large transfer detected. Owner approval required — check the web dashboard. STOP — do not split or retry this transfer.`,
          });
        }

        return JSON.stringify({
          success: true,
          txId: result.txId,
          message: `Transfer of ${result.amount} ${result.asset} to ${preflight.recipientName} (${result.to}) completed successfully. TxID: ${result.txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Transfer failed: ${error}. STOP — do not retry, do not attempt alternatives, do not split. Report this error to the user and wait for instructions.`,
        });
      }
    },
  };
}


// Transfer tool — agent uses this to send payments

// Swap tool — agent uses this to exchange tokens
export function createSwapTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_swap",
    description: `Swap one token for another through the Radix aggregator.
Use this when the user wants to exchange one asset for another.
IMPORTANT: Never retry a failed swap. If the swap fails report the error to the user and STOP.
IMPORTANT: Do NOT call wallet_balance before swapping — use the amount the user specified directly.
If the user says "sell all" or "todo" call wallet_balance ONCE to get the amount, then swap ONCE. Do not retry.`,
    parameters: {
      type: "object",
      properties: {
        fromAsset: {
          type: "string",
          description: "Source asset symbol or resource address. Examples: XRD, HUSDC, or resource_rdx1...",
        },
        toAsset: {
          type: "string",
          description: "Destination asset symbol or resource address. Examples: XRD, HUSDC, or resource_rdx1...",
        },
        amount: {
         anyOf: [{ type: "number" }, { type: "string" }],
         description: "Amount to swap. Example: 10",
        },
        maxSlippage: {
          anyOf: [{ type: "number" }, { type: "string" }],
          description: "Slippage percentage. Default 0.5",
          default: 0.5,
        },
        reason: {
          type: "string",
          description: "Reason for the swap — recorded in the audit log",
        },
      },
      required: ["fromAsset", "toAsset", "amount", "reason"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as SwapParams;
      // Coerce strings a numbers
      p.amount = parseFloat(p.amount as any);
      p.maxSlippage = p.maxSlippage ? parseFloat(p.maxSlippage as any) : 0.5;

      try {
        // ── Execute swap — vault contract handles all validations ──
        const result = await wallet.swap(p);
    

        return JSON.stringify({
          success: true,
          txId: result.txId,
          message: `Swap of ${result.amountIn} ${result.fromAsset} for ${result.amountOut} ${result.toAsset} completed. Price: ${result.executedPrice}. TxID: ${result.txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Swap failed: ${error}. STOP — do not retry, do not attempt alternatives. Report this error to the user and wait for instructions.`,
        });
      }
    },
  };
}

// Conditional order tool — agent uses this for automated trading
export function createConditionalOrderTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_conditional_order",
    description: `Create a buy or sell order that executes automatically
      when the price reaches a specified value.
      Use this tool when the user wants to buy or sell at a specific price.
      IMPORTANT: Never retry a failed order automatically.`,
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["buy", "sell"],
          description: "Order type",
        },
        asset: {
          type: "string",
          enum: ["XRD", "HUSDC", "HUSDT", "HWBTC", "HETH"],
          description: "Asset to buy or sell",
        },
        againstAsset: {
          type: "string",
          enum: ["XRD", "HUSDC", "HUSDT", "HWBTC", "HETH"],
          description: "Asset to trade against",
        },
        amount: {
          type: "number",
          description: "Amount",
        },
        triggerPrice: {
          type: "number",
          description: "Price that triggers the order",
        },
        condition: {
          type: "string",
          enum: ["above", "below"],
          description: "above = executes when price rises above trigger, below = when it drops below",
        },
        maxSlippage: {
          type: "number",
          description: "Maximum accepted slippage in percentage",
        },
      },
      required: ["type", "asset", "againstAsset", "amount", "triggerPrice", "condition", "maxSlippage"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as ConditionalOrder;
      try {
        // ── Safety checks ──
        const preflight = await preflightChecks(wallet, p.amount, p.asset);
        if (preflight.error) return preflight.error;

        const orderId = await wallet.createConditionalOrder(p);
        return JSON.stringify({
          success: true,
          orderId,
          message: `${p.type.toUpperCase()} order created. Will execute when ${p.asset} is ${p.condition} ${p.triggerPrice}. OrderID: ${orderId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Order creation failed: ${error}. STOP — do not retry. Report this error to the user and wait for instructions.`,
        });
      }
    },
  };
}

// Balance tool — agent checks available funds
export function createBalanceTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_balance",
    description: `Check the current PolicyVault balance.
      Use this tool when you need to know how many funds are available
      before making a transfer, swap, or DeFi operation.
      Returns two fields:
      - balances: { symbol: amount } quick lookup by symbol.
      - resources: [{ symbol, resourceAddress, amount }] full details including resource address.
      IMPORTANT: For any operation needing a resource address (WEFT withdraw, liquidity, etc),
      always use the resourceAddress from the resources array. Never guess or invent addresses.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    call: async (): Promise<string> => {
      try {
      const result = await wallet.getBalance();
         return JSON.stringify({
           success: true,
           balances: result.balances,
           resources: result.resources,
           nfts: result.nfts,
           message: `Current balances: ${JSON.stringify(result.balances)}. ` +
                    `Full resource details with addresses: ${JSON.stringify(result.resources)}. ` +
                    `NFTs in vault: ${JSON.stringify(result.nfts)}`,
         });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Error checking balance: ${error}`,
        });
      }
    },
  };
}

// Owner approval tool — agent requests approval for large transfers
export function createOwnerApprovalTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_request_owner_approval",
    description: `Request owner approval for a transfer that exceeds the multisig threshold.
      Use this tool when wallet_transfer fails because the amount is too large.
      The owner will be notified and must approve the transaction from the web dashboard.
      Do NOT use this without first trying wallet_transfer.
      IMPORTANT: Never retry after requesting approval — wait for owner response.`,
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Destination Radix address",
        },
        amount: {
          type: "number",
          description: "Amount to transfer",
        },
        asset: {
          type: "string",
          description: "Asset to transfer. Use symbol (XRD, HUSDC) or resource address. Check wallet_balance for available assets.",
        },
        reason: {
          type: "string",
          description: "Reason for the transfer",
        },
      },
      required: ["to", "amount", "asset", "reason"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as {
        to: string;
        amount: number;
        asset: SupportedAsset;
        reason: string;
      };
      try {
        const result = await wallet.requestLargeTransfer({
          to: p.to,
          amount: p.amount,
          asset: p.asset,
          reason: p.reason,
        });

        console.log(
          `[AgentWallet] Owner approval required for transfer of ${result.amount} ${result.asset} to ${result.to}. Reason: ${result.reason}`
        );

        return JSON.stringify({
          success: false,
          pending: true,
          message: `Large transfer requested. Amount: ${result.amount} ${result.asset} to ${result.to}. Owner approval required — please go to the web dashboard and approve the pending transaction. STOP — do not retry or attempt alternatives.`,
          details: result,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Error requesting large transfer: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// Config tool — agent checks vault configuration
export function createGetConfigTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_get_config",
    description: `Get the current PolicyVault configuration.
      Use this tool to check spending limits before attempting a transfer.
      Returns max per transaction, multisig threshold, daily cap and frozen status.
Call this only when the user explicitly asks about limits, config, or vault status.
Do NOT call this automatically before transfers or swaps — those tools handle their own checks internally.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    call: async (): Promise<string> => {
      try {
        const config = await wallet.getConfig();
        return JSON.stringify({
          success: true,
          config,
          message: `Max per transaction: ${config.maxPerTransaction}, Multisig threshold: ${config.multisigThreshold}, Daily cap: ${config.dailyCap}, Frozen: ${config.frozen}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Error getting config: ${error}`,
        });
      }
    },
  };
}





// Export all tools together — agent adds them all at once
export function createAgentWalletTools(wallet: AgentWallet): AgentTool[] {
  const config = (wallet as any).agentConfig ?? {};

  const vaultAddress: string         = config.vaultAddress        ?? process.env.COMPONENT_ADDRESS         ?? "";
  const notarizerAddress: string     = config.notarizerAddress    ?? process.env.NOTARIZER_ADDRESS          ?? "";
  const badgeResourceAddress: string = config.badgeResourceAddress ?? process.env.BADGE_RESOURCE_ADDRESS   ?? "";
  const badgeLocalId: string         = config.badgeLocalId        ?? process.env.BADGE_LOCAL_ID             ?? "#1#";

  return [
    createGetConfigTool(wallet),
    createBalanceTool(wallet),
    createTransferTool(wallet),
    createOwnerApprovalTool(wallet),
    createSwapTool(wallet),
    createConditionalOrderTool(wallet),
    createCancelOrderTool(wallet),
    createListOrdersTool(wallet),
    createGetWhitelistTool(wallet),
    createGetQuoteTool(wallet),
    ...createStakingTools(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    ...createLiquidityTools(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    ...createWeftLendingTools(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),  


  ];
}
export function createGetWhitelistTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_get_whitelist",
    description: `Get the list of whitelisted addresses in the PolicyVault.
      Use this tool when the user asks who they can send funds to,
      or when you need to find the name and address of a recipient before transferring.
      Always use this before a transfer if you don't know the exact name and address.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    call: async (): Promise<string> => {
      try {
        const whitelist = await wallet.getWhitelist();
        if (whitelist.length === 0) {
          return JSON.stringify({
            success: true,
            whitelist: [],
            message: "No addresses whitelisted yet. The owner must add addresses via the web dashboard.",
          });
        }
        const list = whitelist.map((w: any) => `• ${w.name}: ${w.address}`).join("\n");
        return JSON.stringify({
          success: true,
          whitelist,
          message: `Whitelisted addresses:\n${list}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Error getting whitelist: ${error}`,
        });
      }
    },
  };
}
export function createCancelOrderTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_cancel_order",
    description: `Cancel an active conditional order.
      Use this tool when the user wants to cancel a pending order.
      You need the orderId — use wallet_list_orders first if you don't have it.`,
    parameters: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "The order ID to cancel",
        },
      },
      required: ["orderId"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { orderId: string };
      try {
        const cancelled = wallet.cancelOrder(p.orderId);
        if (!cancelled) {
          return JSON.stringify({
            success: false,
            error: `Order ${p.orderId} not found. Use wallet_list_orders to see active orders.`,
          });
        }
        return JSON.stringify({
          success: true,
          message: `Order ${p.orderId} cancelled successfully.`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Error cancelling order: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

export function createListOrdersTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_list_orders",
    description: `List all active conditional orders.
      Use this tool when the user asks what orders are pending,
      or when you need an orderId to cancel a specific order.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    call: async (): Promise<string> => {
      try {
        const orders = wallet.listActiveOrders();
        if (orders.length === 0) {
          return JSON.stringify({
            success: true,
            orders: [],
            message: "No active orders.",
          });
        }
        return JSON.stringify({
          success: true,
          orders,
          message: `Active orders:\n${orders.map(o => `• ${o}`).join("\n")}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Error listing orders: ${error}`,
        });
      }
    },
  };
}
export function createGetQuoteTool(wallet: AgentWallet): AgentTool {
  return {
    name: "wallet_get_quote",
    description: `Get the current swap quote/price for a token pair from the Radix aggregator.
      Use this tool before creating a conditional order or swap to know the current market price.
      Returns the current price and expected output amount.`,
    parameters: {
      type: "object",
      properties: {
        fromAsset: {
          type: "string",
          description: "Source asset symbol or resource address. Examples: XRD, HUSDC, or resource_rdx1...",
        },
        toAsset: {
          type: "string",
          description: "Destination asset symbol or resource address. Examples: XRD, HUSDC, or resource_rdx1...",
        },
        amount: {
          type: "number",
          description: "Amount to get quote for",
        },
      },
      required: ["fromAsset", "toAsset", "amount"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { fromAsset: string; toAsset: string; amount: number };
      try {
        const quote = await wallet.getSwapQuote(p.fromAsset, p.toAsset, p.amount);
        return JSON.stringify({
          success: true,
          quote,
          message: `Quote: ${p.amount} ${p.fromAsset} → ${quote.outputTokens} ${p.toAsset}. Current price: ${quote.price} ${p.toAsset}/${p.fromAsset}.`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Error getting quote: ${error}`,
        });
      }
    },
  };
}


