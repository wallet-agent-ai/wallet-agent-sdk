import type { AgentTool } from "../../tools/LangChainTools";
import { genericStakingAdapter } from "../adapters/staking/generic";

// ─── Get Validator Info ───────────────────────────────────────────────────────

export function createGetValidatorInfoTool(wallet: any): AgentTool {
  return {
    name: "wallet_get_validator_info",
    description: `Get the LSU token address and claim NFT address for a specific validator.
      Use this before unstaking to find the correct LSU resource address for a validator.
      Also use this to map a validator name to its LSU resource address.
      Input: validator address. Output: lsuResourceAddress and claimNftResourceAddress.`,
    parameters: {
      type: "object",
      properties: {
        validatorAddress: {
          type: "string",
          description: "Component address of the validator. Starts with validator_",
        },
      },
      required: ["validatorAddress"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { validatorAddress: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const response = await fetch(
          `${gatewayUrl}/state/entity/details`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              addresses: [p.validatorAddress],
              opt_ins: { explicit_metadata: ["pool_unit", "claim_nft"] },
            }),
          }
        );
        const data = await response.json() as any;
        const metadata = data?.items?.[0]?.explicit_metadata?.items || [];
        const lsuResourceAddress = metadata.find((m: any) => m.key === "pool_unit")?.value?.typed?.value ?? null;
        const claimNftResourceAddress = metadata.find((m: any) => m.key === "claim_nft")?.value?.typed?.value ?? null;

        return JSON.stringify({
          success: true,
          validatorAddress: p.validatorAddress,
          lsuResourceAddress,
          claimNftResourceAddress,
          message: `Validator LSU resource: ${lsuResourceAddress} — Claim NFT resource: ${claimNftResourceAddress}`,
        });
      } catch (error) {
        return JSON.stringify({ success: false, error: `${error}` });
      }
    },
  };
}

// ─── Get Top Validators ───────────────────────────────────────────────────────
// Misma lógica que el dashboard web — fetch + ranking por score.
// Score = uptime * (1 - fee) * (1 - penalización por stake alto)

export function createGetValidatorsTool(wallet: any): AgentTool {
  return {
    name: "wallet_get_validators",
    description: `Get the top ranked Radix validators sorted by score (uptime, fee, stake distribution).
Call this BEFORE wallet_stake_xrd when the user has not specified a validator address.
Returns top 10 validators with name, address, fee, uptime and score.
Prefer validators with fee=0% and high uptime. Present the list to the user and ask which one to use.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { limit?: number };
      const limit = p.limit ?? 10;
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;

        const [listRes, uptimeRes] = await Promise.all([
          fetch(`${gatewayUrl}/state/validators/list`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          fetch(`${gatewayUrl}/statistics/validators/uptime`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start_state_version: 1 }),
          }),
        ]);

        const listData   = await listRes.json() as any;
        const uptimeData = await uptimeRes.json() as any;

        const uptimeMap = new Map(
          (uptimeData.validators?.items ?? []).map((v: any) => [v.address, v])
        );

        const validators = (listData.validators?.items ?? [])
          .filter((v: any) => v.state?.accepts_delegated_stake && v.state?.is_registered)
          .map((v: any) => {
            const name     = v.metadata?.items?.find((m: any) => m.key === "name")?.value?.typed?.value ?? "Unknown";
            const fee      = parseFloat(v.state?.validator_fee_factor ?? "1");
            const stakePct = v.active_in_epoch?.stake_percentage ?? 0;
            const uptime   = uptimeMap.get(v.address) as any;
            const made     = uptime?.proposals_made ?? 0;
            const missed   = uptime?.proposals_missed ?? 0;
            const uptimePct = made + missed > 0 ? made / (made + missed) : 0;
            const score = uptimePct * Math.pow(1 - fee, 3) * (1 - Math.max(0, stakePct - 5) / 100);
            return {
              name,
              address: v.address,
              fee: (fee * 100).toFixed(2) + "%",
              stakePct: stakePct.toFixed(2) + "%",
              uptimePct: (uptimePct * 100).toFixed(2) + "%",
              score: score.toFixed(4),
            };
          })
          .sort((a: any, b: any) => parseFloat(b.score) - parseFloat(a.score))
          .slice(0, limit);

        const summary = validators.map((v: any, i: number) =>
          `${i+1}. ${v.name} | fee:${v.fee} | uptime:${v.uptimePct} | stake:${v.stakePct}\n   Address: ${v.address}`
        ).join("\n\n");

        return JSON.stringify({
          success: true,
          totalValidators: validators.length,
          validators,
          message: `Top ${validators.length} validators by score:\n\n${summary}\n\nSTOP — present these options to the user and wait for their choice before calling wallet_stake_xrd.`,
        });
      } catch (error) {
        return JSON.stringify({ success: false, error: `Failed to fetch validators: ${error}` });
      }
    },
  };
}

// ─── Stake XRD ────────────────────────────────────────────────────────────────

export function createStakeXrdTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_stake_xrd",
    description: `Stake XRD with a Radix validator.
MANDATORY: If the user has not specified a validator_ address, call wallet_get_validators FIRST. NEVER invent or guess a validator address.
The validator must be whitelisted in the vault. After staking the LSU token is deposited in the vault automatically.
IMPORTANT: Never retry a failed stake.`,
    parameters: {
      type: "object",
      properties: {
        validatorAddress: {
          type: "string",
          description: "Validator address starting with validator_. Get it from wallet_get_validators.",
        },
        amount: {
          type: "string",
          description: "Amount of XRD to stake as a plain number string. Example: 10",
        },
      },
      required: ["validatorAddress", "amount"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { validatorAddress: string; amount: string };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;

        // Obtener LSU y claim NFT resource address del validador
        const metaResponse = await fetch(`${gatewayUrl}/state/entity/details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            addresses: [p.validatorAddress],
            opt_ins: { explicit_metadata: ["pool_unit", "claim_nft"] },
          }),
        });
        const metaData = await metaResponse.json() as any;
        const metadata = metaData?.items?.[0]?.explicit_metadata?.items || [];
        const lsuAddress = metadata.find((m: any) => m.key === "pool_unit")?.value?.typed?.value ?? null;
        const claimNftAddress = metadata.find((m: any) => m.key === "claim_nft")?.value?.typed?.value ?? null;

        // Ejecutar stake
        const result = await genericStakingAdapter.stake({
          validatorAddress: p.validatorAddress,
          amount: p.amount,
          vaultAddress,
          notarizerAddress,
          badgeResourceAddress,
          badgeLocalId,
        });

        const txId = await wallet.submitManifest(result.manifest);

        return JSON.stringify({
          success: true,
          txId,
          message: `Stake de ${p.amount} XRD completado. TX: ${txId}`,
          lsuResourceAddress: lsuAddress,
          claimNftResourceAddress: claimNftAddress,
          ownerAction: lsuAddress
            ? `⚠️ ACCIÓN REQUERIDA: Añade el LSU token a los assets permitidos del vault desde la web (Add Asset). LSU resource address: ${lsuAddress}`
            : "No se pudo obtener el LSU address — consúltalo manualmente en el dashboard.",
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Stake failed: ${error}. STOP — do not retry. Report to the user.`,
        });
      }
    },
  };
}

// ─── Unstake XRD ──────────────────────────────────────────────────────────────
// Autónomo — resuelve posiciones internamente igual que wallet_remove_liquidity.

export function createUnstakeXrdTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_unstake_xrd",
    description: `Unstake LSU tokens from a Radix validator.
The system finds staking positions automatically from the vault — do NOT ask the user for lsuResourceAddress or validatorAddress.
Provide validatorName if the user specified one (e.g. "CaviarNine"), otherwise leave empty and system picks the only position or asks user to choose.
After unstaking XRD is locked ~500 epochs. IMPORTANT: Never retry a failed unstake.`,
    parameters: {
      type: "object",
      properties: {
        validatorName: {
          type: "string",
          description: "Optional validator name to identify which position to unstake (e.g. 'CaviarNine'). Pass empty string if not specified.",
        },
        lsuAmountOverride: {
          type: "string",
          description: "Optional specific LSU amount to unstake. Pass empty string to unstake full position.",
        },
      },
      required: ["validatorName", "lsuAmountOverride"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { validatorName?: string; lsuAmountOverride?: string; };
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const balance = await wallet.getBalance();

        // ── Resolver posiciones LSU internamente ──
        const KNOWN_NON_LSU = new Set([
          "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd",
          "resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf",
        ]);

        const unknownFungibles = (balance.resources ?? []).filter(
          (r: any) => !KNOWN_NON_LSU.has(r.resourceAddress)
        );

        if (unknownFungibles.length === 0) {
          return JSON.stringify({ success: false, error: "No LSU tokens found in vault. Nothing to unstake." });
        }

        // Batch query metadata
        const metaRes = await fetch(`${gatewayUrl}/state/entity/details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            addresses: unknownFungibles.map((r: any) => r.resourceAddress),
            opt_ins: { explicit_metadata: ["name", "validator"] },
          }),
        });
        const metaData = await metaRes.json() as any;

        // Construir posiciones LSU
        const lsuPositions: any[] = [];
        for (const item of metaData?.items ?? []) {
          const meta = item?.explicit_metadata?.items ?? [];
          const validatorAddress = meta.find((m: any) => m.key === "validator")?.value?.typed?.value ?? "";
          if (!validatorAddress) continue;
          const resource = unknownFungibles.find((r: any) => r.resourceAddress === item.address);
          if (!resource) continue;
          lsuPositions.push({
            validatorAddress,
            lsuResourceAddress: item.address,
            lsuAmount: resource.amount,
          });
        }

        if (lsuPositions.length === 0) {
          return JSON.stringify({ success: false, error: "No active staking positions found. Call wallet_get_my_stake to check." });
        }

        // Enriquecer con nombre del validador
        const validatorRes = await fetch(`${gatewayUrl}/state/entity/details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            addresses: lsuPositions.map((p: any) => p.validatorAddress),
            opt_ins: { explicit_metadata: ["name"] },
          }),
        });
        const validatorData = await validatorRes.json() as any;
        const nameMap = new Map<string, string>();
        for (const item of validatorData?.items ?? []) {
          const name = item?.explicit_metadata?.items?.find((m: any) => m.key === "name")?.value?.typed?.value ?? item.address;
          nameMap.set(item.address, name);
        }
        lsuPositions.forEach((pos: any) => { pos.validatorName = nameMap.get(pos.validatorAddress) ?? pos.validatorAddress; });

        // ── Filtrar por nombre si el usuario especificó uno ──
        let candidates = lsuPositions;
        if (p.validatorName && p.validatorName.trim() !== "") {
          const filter = p.validatorName.toLowerCase();
          candidates = lsuPositions.filter((pos: any) => pos.validatorName.toLowerCase().includes(filter));
        }

        // ── Múltiples → pedir al usuario que elija ──
        if (candidates.length > 1) {
          const list = candidates.map((pos: any, i: number) =>
            `${i+1}. ${pos.validatorName} | LSU: ${pos.lsuAmount} | validator: ${pos.validatorAddress}`
          ).join("\n");
          return JSON.stringify({
            success: false,
            needsChoice: true,
            message: `Multiple staking positions found. Ask the user which one to unstake:\n\n${list}\n\nThen call wallet_unstake_xrd again with the specific validatorName.`,
          });
        }

        if (candidates.length === 0) {
          const list = lsuPositions.map((pos: any, i: number) =>
            `${i+1}. ${pos.validatorName} | LSU: ${pos.lsuAmount}`
          ).join("\n");
          return JSON.stringify({
            success: false,
            needsChoice: true,
            message: `Validator not found. Available positions:\n\n${list}\n\nAsk the user which one to unstake.`,
          });
        }

        // ── Una sola posición → ejecutar ──
        const pos = candidates[0];
        // Truncamos valor hacia abajo 
        const truncateTo16 = (amount: string): string => {
        const n = parseFloat(amount);
        const factor = Math.pow(10, 16);
        return (Math.floor(n * factor) / factor).toString();
      };
      
      const lsuAmount = (p.lsuAmountOverride && p.lsuAmountOverride.trim() !== "")
        ? truncateTo16(p.lsuAmountOverride)
        : truncateTo16(pos.lsuAmount.toString());


        const result = await genericStakingAdapter.unstake({
          validatorAddress: pos.validatorAddress,
          lsuAmount,
          lsuResourceAddress: pos.lsuResourceAddress,
          vaultAddress,
          notarizerAddress,
          badgeResourceAddress,
          badgeLocalId,
        });

        const txId = await wallet.submitManifest(result.manifest);

        return JSON.stringify({
          success: true,
          txId,
          message: `✅ Unstake de ${lsuAmount} LSU de ${pos.validatorName} completado. TX: ${txId}. XRD bloqueado ~500 epochs.`,
        });

      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Unstake failed: ${error}. STOP — do not retry.`,
        });
      }
    },
  };
}

// ─── Claim XRD ────────────────────────────────────────────────────────────────

export function createClaimXrdTool(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool {
  return {
    name: "wallet_claim_xrd",
    description: `Claim XRD from a validator after the unbonding period has finished.
      MANDATORY: If the user has not provided claimNftResourceAddress, call wallet_get_my_stake first to find pending claims automatically. NEVER ask the user for claimNftResourceAddress or claimNftIds.
      If unbonding is not finished yet, the transaction will fail on-chain.
      IMPORTANT: Never retry a failed claim. Report errors to the user.`,
    parameters: {
      type: "object",
      properties: {
        validatorAddress: {
          type: "string",
          description: "Component address of the Radix validator",
        },
        claimNftResourceAddress: {
          type: "string",
          description: "Resource address of the claim NFT. Get it from wallet_balance.",
        },
        claimNftIds: {
          type: "string",
          items: { type: "string" },
          description: "Array of NFT IDs to claim. Get them from wallet_balance. Example: [\"{abc123...}\"]",
        },
      },
      required: ["validatorAddress", "claimNftResourceAddress", "claimNftIds"],
    },
    call: async (params: unknown): Promise<string> => {
      const p = params as { validatorAddress: string; claimNftResourceAddress: string; claimNftIds: string[]; };
      try {
        const result = await genericStakingAdapter.claim({
          validatorAddress: p.validatorAddress,
          claimNftResourceAddress: p.claimNftResourceAddress,
          claimNftIds: p.claimNftIds,
          vaultAddress,
          notarizerAddress,
          badgeResourceAddress,
          badgeLocalId,
        });
        const txId = await wallet.submitManifest(result.manifest);
        return JSON.stringify({
          success: true,
          txId,
          message: `Claim de ${p.claimNftIds.length} NFT(s) completado. XRD depositado en vault. TX: ${txId}`,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Claim failed: ${error}. STOP — do not retry. Report to the user.`,
        });
      }
    },
  };
}

// ─── wallet_get_my_stake ──────────────────────────────────────────────────────
// Escanea el vault y devuelve todas las posiciones de staking:
//   - LSU activos (fungibles con metadata.validator)
//   - Claim tokens pendientes (NFTs con metadata.validator)
// Con esta info el LLM puede llamar directamente a wallet_unstake_xrd o wallet_claim_xrd.

export function createGetMyStakeTool(wallet: any): AgentTool {
  return {
    name: "wallet_get_my_stake",
    description: `Show all active staking positions and pending claims in the vault.
Call this BEFORE wallet_unstake_xrd or wallet_claim_xrd when the user has not specified a validator address or LSU resource.
Returns:
- Active stakes: validator name, validatorAddress, lsuResourceAddress, lsuAmount
- Pending claims: validator name, validatorAddress, claimNftResourceAddress, claimNftIds (ready to claim after unbonding period)
After showing results ask the user which position they want to unstake or claim.
NEVER ask the user for lsuResourceAddress or claimNftResourceAddress — find them using this tool.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    call: async (_params: unknown): Promise<string> => {
      try {
        const gatewayUrl = wallet.networkConfig.gatewayUrl;
        const balance = await wallet.getBalance();

        // Tokens conocidos que NO son LSU — excluirlos del análisis
        const KNOWN_NON_LSU = new Set([
          "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd", // XRD
          "resource_rdx1thksg5ng70g9mmy9ne7wz0sc7auzrrwy7fmgcxzel2gvp8pj0xxfmf", // LSULP
        ]);

        // ── Buscar LSU activos en fungibles ──────────────────────────────────
        const unknownFungibles = (balance.resources ?? []).filter(
          (r: any) => !KNOWN_NON_LSU.has(r.resourceAddress)
        );

        // ── Buscar claim tokens en NFTs ───────────────────────────────────────
        // Excluir NFTs conocidos (LP receipts, credit receipts, agent badges)
        const KNOWN_NON_CLAIM_PREFIXES = ["resource_rdx1ng", "resource_rdx1nt"]; // LP/credit receipts
        const unknownNfts = (balance.nfts ?? []).filter(
          (n: any) => !KNOWN_NON_CLAIM_PREFIXES.some(p => n.resourceAddress.startsWith(p))
        );

        if (unknownFungibles.length === 0 && unknownNfts.length === 0) {
          return JSON.stringify({
            success: true,
            message: "No staking positions found in the vault.",
          });
        }

        // ── Batch query metadata para fungibles y NFTs ──────────────────────
        const allAddresses = [
          ...unknownFungibles.map((r: any) => r.resourceAddress),
          ...unknownNfts.map((n: any) => n.resourceAddress),
        ];

        const metaRes = await fetch(`${gatewayUrl}/state/entity/details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            addresses: allAddresses,
            opt_ins: { explicit_metadata: ["name", "validator"] },
          }),
        });
        const metaData = await metaRes.json() as any;

        // Construir mapa resource → { name, validatorAddress }
        const metaMap = new Map<string, { name: string; validatorAddress: string }>();
        for (const item of metaData?.items ?? []) {
          const meta = item?.explicit_metadata?.items ?? [];
          const name = meta.find((m: any) => m.key === "name")?.value?.typed?.value ?? "";
          const validator = meta.find((m: any) => m.key === "validator")?.value?.typed?.value ?? "";
          if (validator) {
            metaMap.set(item.address, { name, validatorAddress: validator });
          }
        }

        // ── Filtrar LSU activos ───────────────────────────────────────────────
        const lsuPositions = unknownFungibles
          .filter((r: any) => metaMap.has(r.resourceAddress))
          .map((r: any) => {
            const meta = metaMap.get(r.resourceAddress)!;
            return {
              type: "active_stake",
              validatorAddress: meta.validatorAddress,
              lsuResourceAddress: r.resourceAddress,
              lsuAmount: r.amount,
            };
          });

        // ── Filtrar claim tokens pendientes ───────────────────────────────────
        const claimPositions = unknownNfts
          .filter((n: any) => metaMap.has(n.resourceAddress))
          .map((n: any) => {
            const meta = metaMap.get(n.resourceAddress)!;
            return {
              type: "pending_claim",
              validatorAddress: meta.validatorAddress,
              claimNftResourceAddress: n.resourceAddress,
              claimNftIds: n.ids,
            };
          });

        // ── Enriquecer con nombre del validador ───────────────────────────────
        const validatorAddresses = [
          ...new Set([
            ...lsuPositions.map((p: any) => p.validatorAddress),
            ...claimPositions.map((p: any) => p.validatorAddress),
          ]),
        ];

        const validatorRes = await fetch(`${gatewayUrl}/state/entity/details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            addresses: validatorAddresses,
            opt_ins: { explicit_metadata: ["name"] },
          }),
        });
        const validatorData = await validatorRes.json() as any;

        const validatorNameMap = new Map<string, string>();
        for (const item of validatorData?.items ?? []) {
          const name = item?.explicit_metadata?.items
            ?.find((m: any) => m.key === "name")?.value?.typed?.value ?? item.address;
          validatorNameMap.set(item.address, name);
        }

        // ── Construir summary ─────────────────────────────────────────────────
        let index = 1;
        const lines: string[] = [];

        for (const pos of lsuPositions) {
          const validatorName = validatorNameMap.get(pos.validatorAddress) ?? pos.validatorAddress;
          lines.push(
            `${index++}. ACTIVE STAKE | ${validatorName}\n` +
            `   Validator: ${pos.validatorAddress}\n` +
            `   LSU Resource: ${pos.lsuResourceAddress}\n` +
            `   LSU Amount: ${pos.lsuAmount}\n` +
            `   ACTION: wallet_unstake_xrd validatorAddress:${pos.validatorAddress} lsuResourceAddress:${pos.lsuResourceAddress} lsuAmount:${pos.lsuAmount}`
          );
        }

        for (const pos of claimPositions) {
          const validatorName = validatorNameMap.get(pos.validatorAddress) ?? pos.validatorAddress;
          lines.push(
            `${index++}. PENDING CLAIM | ${validatorName}\n` +
            `   Validator: ${pos.validatorAddress}\n` +
            `   Claim NFT Resource: ${pos.claimNftResourceAddress}\n` +
            `   NFT IDs: ${pos.claimNftIds.join(", ")}\n` +
            `   ACTION: wallet_claim_xrd validatorAddress:${pos.validatorAddress} claimNftResourceAddress:${pos.claimNftResourceAddress} claimNftIds:[${pos.claimNftIds.map((id: string) => `"${id}"`).join(",")}]`
          );
        }

        const totalPositions = lsuPositions.length + claimPositions.length;
        const message = `Found ${totalPositions} staking position(s):\n\n${lines.join("\n\n")}\n\nSTOP — present these to the user. For unstaking use wallet_unstake_xrd with the ACTION parameters. For claiming use wallet_claim_xrd with the ACTION parameters.`;

        return JSON.stringify({
          success: true,
          activeStakes: lsuPositions.length,
          pendingClaims: claimPositions.length,
          message,
        });

      } catch (error) {
        return JSON.stringify({
          success: false,
          error: `Failed to get staking positions: ${error}`,
        });
      }
    },
  };
}


// ─── Factory ──────────────────────────────────────────────────────────────────

export function createStakingTools(
  vaultAddress: string,
  notarizerAddress: string,
  badgeResourceAddress: string,
  badgeLocalId: string,
  wallet: any
): AgentTool[] {
  return [
    createGetValidatorsTool(wallet),
    createGetMyStakeTool(wallet),
    createGetValidatorInfoTool(wallet),
    createStakeXrdTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createUnstakeXrdTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
    createClaimXrdTool(vaultAddress, notarizerAddress, badgeResourceAddress, badgeLocalId, wallet),
  ];
}
