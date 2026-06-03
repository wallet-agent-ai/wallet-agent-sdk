// ─── MCP Tools — WEFT Lending v2.0 ───────────────────────────────────────────
import type { AgentTool } from "../../tools/LangChainTools";
import {
  weftSupply,
  weftWithdraw,
  weftCreateCdp,
  weftManageCdp,
  weftGetCdpHealth,
  weftBurnCdp,
  getResources,
} from "../adapters/lending/weft";

// ─── Helper: genera la lista de tokens soportados dinámicamente ───────────────

function tokenList(gatewayUrl: string): string {
  const resources = getResources(gatewayUrl);
  return Object.entries(resources)
    .map(([addr, info]) => `${info.symbol}: ${addr}`)
    .join("\n");
}

// ─── wallet_weft_get_supported_tokens ────────────────────────────────────────

export function createWeftGetSupportedTokensTool(wallet: any): AgentTool {
  return {
    name: "wallet_weft_get_supported_tokens",
    description: `Get the list of tokens supported by WEFT Finance V2 on the current network with their exact resource addresses.
ALWAYS call this tool FIRST before calling wallet_weft_supply, wallet_weft_create_cdp, or wallet_weft_manage_cdp.
Never use symbol names like 'XRD' as tokenAddress — always use the full resource address returned by this tool.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    call: async (): Promise<string> => {
      const gatewayUrl = wallet.networkConfig.gatewayUrl;
      const resources = getResources(gatewayUrl);
      return JSON.stringify({
        success: true,
        network: gatewayUrl.includes("stokenet") ? "stokenet" : "mainnet",
        tokens: Object.entries(resources).map(([addr, info]) => ({
          symbol: info.symbol,
          address: addr,
        })),
      });
    },
  };
}

// ─── wallet_weft_supply ───────────────────────────────────────────────────────

export function createWeftSupplyTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  const gatewayUrl = wallet.networkConfig.gatewayUrl;
  const tokens = tokenList(gatewayUrl);

  return {
    name: "wallet_weft_supply",
    description: `Supply tokens to the WEFT Finance V2 lending pool to earn interest.
You will receive Deposit Units (w2-tokens) representing your deposit plus accrued interest.
The w2-tokens are deposited back into the vault automatically.
IMPORTANT: Never retry a failed operation.`,
    parameters: {
      type: "object",
      properties: {
        tokenAddress: {
          type: "string",
          description: "Resource address of the token to supply. ALWAYS call wallet_weft_get_supported_tokens first to get the exact address. Never use symbol names like XRD — use the full resource address.",
        },
        amount: {
          type: "string",
          description: "Amount to supply to the lending pool",
        },
      },
      required: ["tokenAddress", "amount"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { tokenAddress: string; amount: string };
      try {
        const result = await weftSupply({
          tokenAddress: p.tokenAddress,
          amount: p.amount,
          vaultAddress,
          notarizerAddress,
          badgeResourceAddress,
          badgeLocalId,
          gatewayUrl,
        });
        const txId = await wallet.submitManifest(result.manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ ${result.description} TX: ${txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `WEFT supply failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_weft_withdraw ─────────────────────────────────────────────────────

export function createWeftWithdrawTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_weft_withdraw",
description: `Withdraw tokens from WEFT Finance V2 lending pool by redeeming Deposit Units (w2-tokens).

WORKFLOW — follow this exactly:
1. Call wallet_balance to get current balances
2. Find the w2-token (starts with 'w2-' in the label, or match by depositUnitAddress)
3. Use the EXACT amount from wallet_balance — do NOT modify, round, or truncate it
4. Call this tool with that exact amount and depositUnitAddress

PARAMETERS:
- depositUnitAddress: the resource address of the w2-token from wallet_balance
- amount: the EXACT amount shown in wallet_balance for that w2-token. Copy it verbatim.

IMPORTANT: Never retry a failed operation. Never guess the amount.`,
    parameters: {
      type: "object",
      properties: {
        depositUnitAddress: {
          type: "string",
          description: "Resource address of the w2-token (Deposit Unit) to redeem. MUST be named 'depositUnitAddress' exactly. Get it from wallet_balance output.",

        },
        amount: {
          type: "string",
          description: "Amount of Deposit Units to redeem",
        },
      },
      required: ["depositUnitAddress", "amount"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { depositUnitAddress: string; amount: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const result = await weftWithdraw({
          depositUnitAddress: p.depositUnitAddress,
          amount: p.amount,
          vaultAddress,
          notarizerAddress,
          badgeResourceAddress,
          badgeLocalId,
          gatewayUrl,
        });
        const txId = await wallet.submitManifest(result.manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ ${result.description} TX: ${txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `WEFT withdraw failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_weft_create_cdp ───────────────────────────────────────────────────

export function createWeftCreateCdpTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  const gatewayUrl = wallet.networkConfig.gatewayUrl;
  const tokens = tokenList(gatewayUrl);

  return {
    name: "wallet_weft_create_cdp",
    description: `Create a new CDP (Collateralized Debt Position) in WEFT Finance V2.
Deposit collateral to get borrowing power. Optionally borrow in the same transaction.
The CDP NFT (Wefty) will be stored in your vault — you need it to manage the position later.
Use wallet_weft_cdp_health after creation to monitor your position.
Example call: collaterals=[{tokenAddress:"XRD", amount:"100"}]
IMPORTANT: Never retry a failed operation.`,
    parameters: {
      type: "object",
      properties: {
         collaterals: {
           type: "array",
           description: "List of collateral positions. Each item MUST have tokenAddress (symbol like XRD or full resource address) AND amount (number as string).",
           items: {
             type: "object",
             properties: {
               tokenAddress: {
                 type: "string",
                 description: "Token symbol (XRD, xUSDC...) or full resource address",
               },
               amount: {
                 type: "string",
                 description: "Amount to deposit, e.g. '100'",
               },
             },
             required: ["tokenAddress", "amount"],
           },
         },
        borrows: {
          type: "array",
          description: "Optional: tokens to borrow in the same transaction",
          items: {
            type: "object",
            properties: {
              tokenAddress: { type: "string" },
              amount: { type: "string" },
            },
            required: ["tokenAddress", "amount"],
          },
        },
        cdpName: {
          type: "string",
          description: "Optional name for the CDP",
        },
      },
      required: ["collaterals"],
    },
    call: async (params: unknown): Promise<string> => {
  //console.log("[wallet_weft_create_cdp] called with:", JSON.stringify(params, null, 2));
  const raw = params as any;

  const collaterals = (raw.collaterals ?? []).map((c: any) =>
    typeof c === "string"
      ? { tokenAddress: c, amount: raw.amount ?? "0" }
      : c
  );

  //console.log("[create_cdp] collaterals:", JSON.stringify(collaterals, null, 2));

  if (collaterals.length === 0 || collaterals.every((c: any) => !c.amount || c.amount === "0")) {
    return JSON.stringify({
      success: false,
      error: "collaterals must be [{tokenAddress:'XRD', amount:'100'}]. Amount is required.",
    });
  }
  try {
    const gatewayUrl = wallet.networkConfig.gatewayUrl;
    const result = await weftCreateCdp({
      collaterals,
      borrows: raw.borrows ?? [],
      cdpName: raw.cdpName,
      vaultAddress,
      notarizerAddress,
      badgeResourceAddress,
      badgeLocalId,
      gatewayUrl,
    });


         const txId = await wallet.submitManifest(result.manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ ${result.description} TX: ${txId}. Use wallet_balance to find your CDP NFT ID.`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `WEFT create CDP failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_weft_manage_cdp ───────────────────────────────────────────────────

export function createWeftManageCdpTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  const gatewayUrl = wallet.networkConfig.gatewayUrl;
  const tokens = tokenList(gatewayUrl);

  return {
    name: "wallet_weft_manage_cdp",
    description: `Manage an existing WEFT Finance V2 CDP in a single transaction.
You can combine: add collateral, remove collateral, borrow more, repay loans.
MANDATORY WORKFLOW:
1. Call wallet_weft_cdp_health FIRST to get exact resource addresses
2. Use addresses from collateralPositions for removeCollaterals
3. Use addresses from loanPositions for repayments
4. NEVER pass empty tokenAddress or amount — if missing, call wallet_weft_cdp_health first
5. NEVER guess or invent resource addresses
WARNING: Borrowing reduces health LTV. Liquidation occurs when liquidation_ltv > 1.
IMPORTANT: Never retry a failed operation.`,
    parameters: {
      type: "object",
      properties: {
        cdpId: {
          type: "string",
            description: "CDP NFT local ID. For integer IDs use format '#1458#' (with hash symbols). For RUID IDs use '{uuid-uuid-uuid-uuid}'. Always include the surrounding symbols.",
        },
        addCollaterals: {
          type: ["array","null"],
          description: "Collateral to add. Use exact resourceAddress from wallet_weft_cdp_health collateralPositions or wallet_balance resources array. NEVER invent addresses.",
          items: {
            type: "object",
            properties: {
              tokenAddress: { type: "string" },
              amount: { type: "string" },
            },
            required: ["tokenAddress", "amount"],
          },
        },
        removeCollaterals: {
          type: ["array","null"],
          description: "Collateral to remove. Use exact resourceAddress from wallet_weft_cdp_health collateralPositions. NEVER invent addresses.",
          items: {
            type: "object",
            properties: {
              tokenAddress: { type: "string" },
              amount: { type: "string" },
            },
            required: ["tokenAddress", "amount"],
          },
        },
        borrows: {
          type: ["array","null"],
          description: "Tokens to borrow. Use exact resourceAddress from wallet_weft_get_supported_tokens. NEVER invent addresses.",
          items: {
            type: "object",
            properties: {
              tokenAddress: { type: "string" },
              amount: { type: "string" },
            },
            required: ["tokenAddress", "amount"],
          },
        },
        repayments: {
          type: ["array","null"],
          description: "Loan repayments. Use exact resourceAddress from wallet_weft_cdp_health loanPositions. NEVER invent addresses.",
          items: {
            type: "object",
            properties: {
              tokenAddress: { type: "string" },
              amount: { type: "string" },
            },
            required: ["tokenAddress", "amount"],
          },
        },
      },
      required: ["cdpId"],
    },

    call: async (params: unknown): Promise<string> => {
      const p = params as {
        cdpId: string;
        addCollaterals?: Array<{ tokenAddress: string; amount: string }>;
        removeCollaterals?: Array<{ tokenAddress: string; amount: string }>;
        borrows?: Array<{ tokenAddress: string; amount: string }>;
        repayments?: Array<{ tokenAddress: string; amount: string }>;
      };
   // Convertir null a array vacío
   p.addCollaterals = p.addCollaterals ?? [];
   p.removeCollaterals = p.removeCollaterals ?? [];
   p.borrows = p.borrows ?? [];
   p.repayments = p.repayments ?? [];


   // ── Validar que no haya addresses o amounts vacíos ──
         const allItems = [
           ...(p.addCollaterals ?? []),
           ...(p.removeCollaterals ?? []),
           ...(p.borrows ?? []),
           ...(p.repayments ?? []),
         ];
         const invalid = allItems.find(item => !item.tokenAddress || !item.amount);
         if (invalid) {
           return JSON.stringify({
             success: false,
             error: "STOP — tokenAddress or amount is empty. Call wallet_weft_cdp_health first to get exact resource addresses from collateralPositions/loanPositions, then retry.",
           });
         }
   


      try {
        // ── Si hay repayments → usar loanPositions del CDP health para amount exacto ──
        // Esto evita saldos residuales por intereses acumulados entre el query y el repago.
        let finalRepayments = p.repayments ?? [];
        if (finalRepayments.length > 0) {
          try {
            const health = await weftGetCdpHealth({ cdpId: p.cdpId, gatewayUrl });
            finalRepayments = finalRepayments.map(r => {
              const loanAmount = health.loanPositions[r.tokenAddress];
              if (loanAmount && parseFloat(loanAmount) > 0) {
                // Usar el loan amount actual + 1% buffer para cubrir intereses acumulados
                const buffered = (parseFloat(loanAmount) * 1.01).toString();
                return { ...r, amount: buffered };
              }
              return r;
            });
          } catch (e) {
            // Si falla el health check usar los amounts originales con 0.1% buffer (ya aplicado en weft.ts)
            console.warn("[weft_manage_cdp] Could not fetch CDP health for repayment buffer:", e);
          }
        }

        const result = await weftManageCdp({
          cdpId: p.cdpId,
          addCollaterals: p.addCollaterals,
          removeCollaterals: p.removeCollaterals,
          borrows: p.borrows,
          repayments: finalRepayments,
          vaultAddress,
          notarizerAddress,
          badgeResourceAddress,
          badgeLocalId,
          gatewayUrl,
        });
        const txId = await wallet.submitManifest(result.manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ ${result.description} TX: ${txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `WEFT manage CDP failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── wallet_weft_cdp_health ───────────────────────────────────────────────────

export function createWeftCdpHealthTool(wallet: any): AgentTool {
  return {
    name: "wallet_weft_cdp_health",
    description: `Check the health of a WEFT Finance V2 CDP position.
Returns: total loan value, total collateral value, health LTV, liquidation LTV.
WARNING: If liquidation_ltv > 1 the position will be liquidated — act immediately.
Safe range: liquidation_ltv < 0.8. Danger zone: > 0.9.
Use wallet_balance to find your CDP NFT ID.`,
    parameters: {
      type: "object",
      properties: {
        cdpId: {
          type: "string",
          description: "CDP NFT local ID. For integer IDs use format '#1458#' (with hash symbols). For RUID IDs use '{uuid-uuid-uuid-uuid}'. Always include the surrounding symbols.",

        },
      },
      required: ["cdpId"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { cdpId: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const health = await weftGetCdpHealth({
          cdpId: p.cdpId,
          gatewayUrl,
        });
        const status = health.isHealthy ? "✅ Healthy" : "⚠️ AT RISK OF LIQUIDATION";
        return JSON.stringify({
          success: true,
          ...health,
          status,
          message:
        `CDP ${health.id}: ${status} | ` +
        `Collateral: ${health.totalCollateralValue} | ` + 
        `Loan: ${health.totalLoanValue} | ` +
        `Liquidation LTV: ${health.liquidationLtv} | ` +
        `Collateral positions (use these exact addresses for removeCollaterals): ${JSON.stringify(health.collateralPositions)} | ` +
        `Loan positions (use these exact addresses for repayments/borrows): ${JSON.stringify(health.loanPositions)}`,
   
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `WEFT CDP health check failed: ${error}`,
        });
      }
    },
  };
}


// ─── wallet_weft_burn_cdp ─────────────────────────────────────────────────────
// Quema un CDP vacío de WEFT Finance y lo elimina del vault.
// El CDP debe estar completamente vacío: sin colateral ni deuda.
// Si tiene saldo residual, hacer repay primero y luego remove_collateral.

export function createWeftBurnCdpTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_weft_burn_cdp",
    description: `Burn (permanently delete) an empty WEFT Finance CDP NFT from the vault.
The CDP must be completely empty — no collateral and no debt remaining.
If there is residual debt, call wallet_weft_manage_cdp to repay first.
If there is residual collateral, call wallet_weft_manage_cdp to remove it first.
Call wallet_weft_cdp_health first to verify the CDP is empty before burning.
IMPORTANT: This action is irreversible. Never retry a failed burn.`,
    parameters: {
      type: "object",
      properties: {
        cdpId: {
          type: "string",
          description: "CDP NFT local ID. Format: '#1130#' for integer IDs.",
        },
      },
      required: ["cdpId"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { cdpId: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;

        // Verificar que el CDP está vacío antes de quemar
        const health = await weftGetCdpHealth({ cdpId: p.cdpId, gatewayUrl });
        const loanValue = parseFloat(health.totalLoanValue);
        const collateralValue = parseFloat(health.totalCollateralValue);

        if (loanValue > 0.000001) {
          return JSON.stringify({
            success: false,
            error: `CDP ${p.cdpId} still has debt of ${health.totalLoanValue}. Repay all loans first using wallet_weft_manage_cdp before burning.`,
          });
        }

        if (collateralValue > 0.000001) {
          return JSON.stringify({
            success: false,
            error: `CDP ${p.cdpId} still has collateral of ${health.totalCollateralValue}. Remove all collateral first using wallet_weft_manage_cdp before burning.`,
          });
        }

        const result = await weftBurnCdp({
          cdpId: p.cdpId,
          vaultAddress,
          notarizerAddress,
          badgeResourceAddress,
          badgeLocalId,
          gatewayUrl,
        });

        const manifest = result.manifest
          .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
          .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);

        const txId = await wallet.submitManifest(manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `✅ CDP ${p.cdpId} burned and removed from vault. TX: ${txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Burn CDP failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}


// ─── wallet_weft_close_cdp ────────────────────────────────────────────────────
// Cierra completamente un CDP de WEFT: repaga toda la deuda, retira todo el
// colateral y quema el NFT — todo automáticamente sin intervención del LLM.

export function createWeftCloseCdpTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_weft_close_cdp",
    description: `Close a WEFT Finance CDP completely in one command.
This tool automatically:
1. Checks the CDP health to get exact debt and collateral amounts
2. Repays all debt (if any)
3. Removes all collateral (if any)  
4. Burns the empty CDP NFT

Use this when the user says "close CDP", "delete CDP", "exit CDP", "close my WEFT position" etc.
Do NOT use wallet_weft_manage_cdp + wallet_weft_burn_cdp separately — use this tool instead.
IMPORTANT: Never retry a failed operation.`,
    parameters: {
      type: "object",
      properties: {
        cdpId: {
          type: "string",
          description: "CDP NFT local ID. Format: '#1130#' for integer IDs.",
        },
      },
      required: ["cdpId"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { cdpId: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;

        // ── PASO 1: Obtener health del CDP ──
        let health;
        try {
          health = await weftGetCdpHealth({ cdpId: p.cdpId, gatewayUrl });
        } catch (e) {
          // CDP ya cerrado — intentar burn directamente
          console.log(`[close_cdp] Health check failed, attempting burn`);
          const burnResult = await weftBurnCdp({
            cdpId: p.cdpId, vaultAddress, notarizerAddress,
            badgeResourceAddress, badgeLocalId, gatewayUrl,
          });
          const manifest = burnResult.manifest
            .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
            .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);
          const txId = await wallet.submitManifest(manifest);
          return JSON.stringify({ success: true, txId, message: `✅ CDP ${p.cdpId} burned. TX: ${txId}` });
        }

        const loanValue = parseFloat(health.totalLoanValue ?? "0");
        const collateralValue = parseFloat(health.totalCollateralValue ?? "0");

        // ── PASO 2: Si tiene deuda Y colateral → manage_cdp con ambos ──
        const hasDebt = loanValue > 0.000001;
        const hasCollateral = collateralValue > 0.000001;

        if (hasDebt || hasCollateral) {
          const repayments = hasDebt
            ? Object.entries(health.loanPositions).map(([tokenAddress, amount]) => ({
                tokenAddress,
                amount: (parseFloat(amount) * 1.01).toString(), // +1% buffer para intereses
              }))
            : [];

          const removeCollaterals = hasCollateral
            ? Object.entries(health.collateralPositions).map(([tokenAddress, amount]) => ({
                tokenAddress,
                amount,
              }))
            : [];

          const manageResult = await weftManageCdp({
            cdpId: p.cdpId,
            addCollaterals: [],
            removeCollaterals,
            borrows: [],
            repayments,
            vaultAddress,
            notarizerAddress,
            badgeResourceAddress,
            badgeLocalId,
            gatewayUrl,
          });

          const manageManifest = manageResult.manifest
            .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
            .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);

          console.log("=== CLOSE CDP - MANAGE MANIFEST ===\n", manageManifest);
          const manageTxId = await wallet.submitManifest(manageManifest);
          console.log(`[close_cdp] Manage TX: ${manageTxId}`);

          // Esperar un poco para que la TX se confirme
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // ── PASO 3: Quemar el CDP ──
        const burnResult = await weftBurnCdp({
          cdpId: p.cdpId, vaultAddress, notarizerAddress,
          badgeResourceAddress, badgeLocalId, gatewayUrl,
        });

        const burnManifest = burnResult.manifest
          .replaceAll("AGENT_BADGE_RESOURCE_ADDRESS", badgeResourceAddress)
          .replaceAll("AGENT_BADGE_LOCAL_ID", badgeLocalId);

        console.log("=== CLOSE CDP - BURN MANIFEST ===\n", burnManifest);
        const burnTxId = await wallet.submitManifest(burnManifest);

        return JSON.stringify({
          success: true,
          txId: burnTxId,
          message: `✅ CDP ${p.cdpId} closed completely and burned. TX: ${burnTxId}`,
        });

      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Close CDP failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createWeftLendingTools(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool[] {
  return [
    createWeftGetSupportedTokensTool(wallet),
    createWeftSupplyTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createWeftWithdrawTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createWeftCreateCdpTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createWeftManageCdpTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createWeftCdpHealthTool(wallet),
    createWeftBurnCdpTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createWeftCloseCdpTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
  ];
}
