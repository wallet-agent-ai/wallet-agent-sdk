import {
  AgentWalletConfig,
  TransferParams,
  TransferResult,
  SwapParams,
  SwapResult,
  BalanceResult,
  ConditionalOrder,
  NetworkConfig,
  SupportedAsset,
} from "../types";
import { AGGRClient, SwapQuote } from "./AGGRClient";
import { RadixClient } from "./RadixClient";
import { NETWORK_CONFIG } from "../network-config.js";
import { KNOWN_TOKENS, resolveTokenAddress } from "../mcp/known-pools.js";


export class AgentWallet {
  private config: AgentWalletConfig;
  private networkConfig: NetworkConfig;
  private aggrClient?: AGGRClient;
  private activeOrders: Map<string, () => void>;
  private radixClient: RadixClient;


constructor(config: AgentWalletConfig) {
  const network = config.network ?? "mainnet";
  
  if (!NETWORK_CONFIG[network]) {
    throw new Error(
      `[AgentWallet] Invalid network "${network}". Valid options: mainnet, stokenet, localnet`
    );
  }

  this.config = { ...config, network };
  this.networkConfig = NETWORK_CONFIG[network];
  this.activeOrders = new Map();

  if (config.aggrConfig) {
    this.aggrClient = new AGGRClient(config.aggrConfig);
  }

if (config.notarizerPrivateKey) {
  this.radixClient = new RadixClient(config.notarizerPrivateKey, this.networkConfig);
} else {
  this.radixClient = RadixClient.fromKeystore(this.networkConfig);
}

}
    get agentConfig() {
       return {
         vaultAddress:         this.config.componentAddress,
         notarizerAddress:     this.config.notarizerAddress ?? RadixClient.getAddress(),
         badgeResourceAddress: this.config.badgeResourceAddress,
         badgeLocalId:         this.config.badgeLocalId ?? "#1#",
       };
     }


  private async checkFunds(): Promise<void> {
    try {
      const config = await this.getConfig();
      const balance = await this.getBalance();
      const warnings: string[] = [];
  
      const xrdBalance = balance.balances["XRD"] ?? 0; 
      const threshold = config.maxPerTransaction + 10;
  
      if (xrdBalance < threshold) {
        warnings.push(
          `Low funds in component: ${xrdBalance} XRD. Minimum recommended: ${threshold} XRD`
        );
      }
  
      if (warnings.length > 0 && this.config.onLowFunds) {
        this.config.onLowFunds(warnings);
      }
    } catch (err) {
      console.error("[AgentWallet] checkFunds error:", err);
    }
  }


  // Obtiene la dirección del resource de un asset
  // Fuente única de verdad: KNOWN_TOKENS en known-pools.ts
getAssetAddress(asset: SupportedAsset): string {
  const assetStr = asset.toString();
  
  // 1. Si ya es una resource address → devolver directamente
  if (assetStr.startsWith("resource_")) return assetStr;

  // 2. Buscar en KNOWN_TOKENS por símbolo (case insensitive)
  const known = KNOWN_TOKENS.find(
    t => t.symbol.toUpperCase() === assetStr.toUpperCase()
  );
  if (known) return known.address;

  throw new Error(
    `[AgentWallet] Asset "${asset}" not found in KNOWN_TOKENS. Add it to known-pools.ts.`
  );
}

// Lista todos los assets disponibles desde KNOWN_TOKENS
listAssets(): string[] {
  return KNOWN_TOKENS.map(t => t.symbol);
}



  // Consulta el balance del PolicyVault
async getBalance(): Promise<BalanceResult> {
  const response = await fetch(
    `${this.networkConfig.gatewayUrl}/state/entity/details`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addresses: [this.config.componentAddress],
        aggregation_level: "Vault",
        opt_ins: {
          explicit_metadata: ["name", "symbol"],
          non_fungible_include_nfids: true,
          non_fungible_include_metadata: true,
        },
      }),
    }
  );

  const data = await response.json();
  const item = data?.items?.[0];
  const fungibles = item?.fungible_resources?.items || [];
  const nonFungibles = item?.non_fungible_resources?.items || [];

  const balances: Partial<Record<string, number>> = {};
  const resources: Array<{ symbol: string; resourceAddress: string; amount: number }> = [];

  for (const resource of fungibles) {
    
    const metadata = resource.explicit_metadata?.items || [];
    const symbol = metadata.find((m: any) => m.key === "symbol")?.value?.typed?.value;
    const amount = parseFloat(resource.vaults?.items?.[0]?.amount || "0");
    if (amount <= 0) continue;
    const resourceAddress: string = resource.resource_address;
    const label = symbol ?? resourceAddress;
    balances[label] = amount;
    resources.push({ symbol: label, resourceAddress, amount });
  }

const nfts: Array<{ name: string; resourceAddress: string; ids: string[] }> = [];

for (const nf of nonFungibles) {
  const resourceAddress: string = nf.resource_address;
  const metadata = nf.explicit_metadata?.items || [];
  const symbol = metadata.find((m: any) => m.key === "symbol")?.value?.typed?.value;
  const name = metadata.find((m: any) => m.key === "name")?.value?.typed?.value;
  const label = symbol ?? name ?? resourceAddress;
  const vaultItems = nf.vaults?.items || [];
  for (const vault of vaultItems) {
    const ids: string[] = vault.items || [];
    if (ids.length === 0) continue;
    nfts.push({ name: label, resourceAddress, ids });
  }
}

  return {
    balances,
    resources,
    nfts,
    componentAddress: this.config.componentAddress,
    timestamp: new Date(),
  };
}


  // Transfiere assets a una dirección — el agente presenta su badge automáticamente
async transfer(params: TransferParams): Promise<TransferResult> {
  const assetAddress = this.getAssetAddress(params.asset);
  const badgeLocalId = this.config.badgeLocalId ?? "#1#";

  // 1. Obtener configuración actual del contrato
  const config = await this.getConfig();
  
  // 2. VALIDAR FROZEN
  if (config.frozen) {
    throw new Error(
      `[AgentWallet] Contract is frozen. No transfers allowed.`
    );
  }
  // 3. VALIDAR MULTISIG THRESHOLD PRIMERO
// Si supera el umbral del owner — necesita aprobación del owner

let manifest: string;
if (config.multisigThreshold && params.amount > config.multisigThreshold) {
  console.log(`[AgentWallet] Amount ${params.amount} exceeds multisig threshold (${config.multisigThreshold}). Requesting owner approval...`);
  await this.requestLargeTransfer({
    to: params.to,
    amount: params.amount,
    asset: params.asset,
    reason: params.reason,
  });
  return {
    txId: "pending_owner_approval",
    amount: params.amount,
    asset: params.asset,
    to: params.to,
    reason: params.reason,
    timestamp: new Date(),
    success: false,
  };
}



// 4. VALIDAR MAX PER TRANSACTION
// Si supera el límite del agente pero NO el del owner — rechazar
else if (params.amount > config.maxPerTransaction) {
  throw new Error(
    `[AgentWallet] Amount ${params.amount} exceeds max per transaction (${config.maxPerTransaction}). ` +
    `For larger transfers up to ${config.multisigThreshold}, owner approval is required. ` +
    `Use requestOwnerApproval() instead.`
  );
}
// 5. TRANSFERENCIA NORMAL — dentro de los límites del agente
else {
  console.log(`[AgentWallet] Amount ${params.amount} within agent limits. Normal transfer.`);
  manifest = this.buildTransferManifest(
    params.to,
    assetAddress,
    params.amount,
    this.config.badgeResourceAddress,
    badgeLocalId
  );
}

  // 5. Enviar la transacción
    let txId!: string;   
    try {
      txId = await this.submitManifest(manifest);
      console.log("[AgentWallet] TX submitted:", txId);
    } catch (err) {
      console.error("[AgentWallet] submitManifest ERROR:", err);
      throw err;
    }

  this.checkFunds().catch(console.error);
  return {
    txId,
    amount: params.amount,
    asset: params.asset,
    to: params.to,
    reason: params.reason,
    timestamp: new Date(),
    success: true,
  };
}

// Agent need these to know the limits 
async getConfig(): Promise<{
  maxPerTransaction: number;
  multisigThreshold: number;
  dailyCap: number;
  frozen: boolean;
}> {
  try {
    // Usar el endpoint correcto
    const response = await fetch(
      `${this.networkConfig.gatewayUrl}/state/entity/details`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: [this.config.componentAddress],
        }),
      }
    );

    const data = await response.json();
    // Extraer los fields del state
    const fields = data?.items?.[0]?.details?.state?.fields ?? [];
    
    // Buscar los valores por field_name
    let maxPerTransaction = 100;
    let multisigThreshold = 500;
    let dailyCap = 1000;
    let frozen = false;
    
    for (const field of fields) {
      switch (field.field_name) {
        case "max_per_transaction":
          maxPerTransaction = parseFloat(field.value);
          break;
        case "multisig_threshold":
          multisigThreshold = parseFloat(field.value);
          break;
        case "daily_cap":
          dailyCap = parseFloat(field.value);
          break;
        case "frozen":
          frozen = field.value === true;
          break;
      }
    }
    
    console.log("  ✅ Config get from  agent component:");
    console.log(`  📈 Max for transaction: ${maxPerTransaction}`);
    console.log(`  🔐 Multisig level: ${multisigThreshold}`);
    console.log(`  💰 Dairy limit: ${dailyCap}`);
    console.log(`  ❄️  Frozen: ${frozen}`);
    
    return {
      maxPerTransaction,
      multisigThreshold,
      dailyCap,
      frozen,
    };
    
  } catch (error) {
    console.error("❌ Error when consult the endpoint:", error);
  }
  
  // Fallback en caso de error
  return {
    maxPerTransaction: 100,
    multisigThreshold: 500,
    dailyCap: 1000,
    frozen: false,
  };
}


// ─── Pending Transfer — Large TX que requiere aprobación del owner ─────────

async requestLargeTransfer(params: {
  to: string;
  amount: number;
  asset: SupportedAsset;
  reason: string;
}): Promise<{ requested: boolean; to: string; amount: number; asset: string; reason: string }> {
  const assetAddress = this.getAssetAddress(params.asset);
  const badgeLocalId = this.config.badgeLocalId ?? "#1#";

const notarizer = this.config.notarizerAddress ?? RadixClient.getAddress();

  const manifest = `
CALL_METHOD
    Address("${notarizer}")
    "lock_fee"
    Decimal("2")
;
CALL_METHOD
    Address("${this.config.componentAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${notarizer}")
    "create_proof_of_non_fungibles"
    Address("${this.config.badgeResourceAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${badgeLocalId}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${this.config.componentAddress}")
    "request_large_transfer"
    Address("${params.to}")
    Decimal("${params.amount}")
    Address("${assetAddress}")
    "${params.reason}"
    Proof("agent_proof")
;
`;
  
  await this.submitManifest(manifest);

  this.checkFunds().catch(console.error);
  
  console.log(`[AgentWallet] Large transfer requested:`);
  console.log(`   To: ${params.to}`);
  console.log(`   Amount: ${params.amount} ${params.asset}`);
  console.log(`   Reason: ${params.reason}`);
  console.log(`   ⚠️  Owner approval required — check the web dashboard`);

  return {
    requested: true,
    to: params.to,
    amount: params.amount,
    asset: params.asset,
    reason: params.reason,
  };
}

async getPendingTransfer(): Promise<{
  hasPending: boolean;
  to?: string;
  amount?: string;
  asset?: string;
  reason?: string;
  requestedAtEpoch?: string;
} | null> {



const manifest = `
CALL_METHOD
    Address("${this.config.componentAddress}")
    "get_pending_transfer"
;
`;

  const response = await fetch(
    `${this.networkConfig.gatewayUrl}/transaction/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest,
        start_epoch_inclusive: 1,
        end_epoch_exclusive: 100,
        nonce: 1,
        signer_public_keys: [],
        notary_public_key: {
          key_type: "EddsaEd25519",
          key_hex: "0000000000000000000000000000000000000000000000000000000000000001"
        },
        notary_is_signatory: true,
        tip_percentage: 0,
        flags: {
          use_free_credit: true,
          assume_all_signature_proofs: true,
          skip_epoch_check: true
        }
      })
    }
  );

  const data = await response.json();
  const output = data?.receipt?.output?.[0]?.programmatic_json;

  if (!output || output.variant_id === "0") {
    return { hasPending: false };
  }

  const fields = output?.fields?.[0]?.fields;
  return {
    hasPending: true,
    to:                fields?.[0]?.value,
    amount:            fields?.[1]?.value,
    asset:             fields?.[2]?.value,
    reason:            fields?.[3]?.value,
    requestedAtEpoch:  fields?.[4]?.value,
  };
}


  
//Ejecuta un swap a través del AGGR
async swap(params: SwapParams): Promise<SwapResult> {
  

    if (!this.aggrClient) {
    throw new Error(
      "[AgentWallet] AGGR not configured. Pass aggrConfig to use swap."
    );
  }

  const fromAddress = this.getAssetAddress(params.fromAsset);
  const toAddress = this.getAssetAddress(params.toAsset);
  const badgeLocalId = this.config.badgeLocalId ?? "#1#";

  // Descuentamos el fee del PolicyVault (0.1%) antes de llamar al AGGR
  // para que el monto que llega al AGGR sea el real disponible
  const FEE_RATE = 0.001;
  const adjustedAmount = params.amount * (1 - FEE_RATE);

  // Llamamos al AGGR con el monto ajustado y el PolicyVault como fromAddress
  const quote = await this.aggrClient.getSwapQuote(
    fromAddress,
    toAddress,
    adjustedAmount,
    this.config.componentAddress
  );

  // VERSION MOCK 
   //console.log("=== AGGR MANIFEST RAW ===");
   //console.log(quote.manifest);
   
  if ((this.config.aggrConfig as any)?.mockMode) {
    console.log("[AgentWallet] SWAP MOCK — simulando resultado sin TX");
    return {
      txId: "mock_swap_" + Date.now(),
      fromAsset: params.fromAsset,
      toAsset: params.toAsset,
      amountIn: params.amount,
      amountOut: quote.outputTokens,
      executedPrice: quote.outputTokens / params.amount,
      reason: params.reason,
      timestamp: new Date(),
      success: true,
    };
  }
  // FIN MOCK 

   const aggrManifest = quote.manifest;
//
  const withdrawPattern = /CALL_METHOD\s+Address\("[^"]+"\)\s+"withdraw"[^;]+;/;
  const manifestWithoutWithdraw = aggrManifest.replace(withdrawPattern, "");

const notarizer = this.config.notarizerAddress ?? RadixClient.getAddress();

// Construimos el resto manifiesto
const manifest = `
CALL_METHOD
    Address("${notarizer}")
    "lock_fee"
    Decimal("10")
;
CALL_METHOD
    Address("${this.config.componentAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${notarizer}")
    "create_proof_of_non_fungibles"
    Address("${this.config.badgeResourceAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${badgeLocalId}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${this.config.componentAddress}")
    "transfer"
    Address("${this.config.componentAddress}")
    Decimal("${params.amount}")
    Address("${fromAddress}")
    "swap ${params.fromAsset} to ${params.toAsset}"
    Proof("agent_proof")
;
${manifestWithoutWithdraw}
`;

  const txId = await this.submitManifest(manifest);

  this.checkFunds().catch(console.error);
return {
    txId,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    amountIn: params.amount,
    amountOut: quote.outputTokens,
    executedPrice: quote.outputTokens / params.amount,
    reason: params.reason,
    timestamp: new Date(),
    success: true,
  };
}




  // Crea una orden condicional — ejecuta cuando se cumple el precio trigger
  async createConditionalOrder(order: ConditionalOrder): Promise<string> {
    if (!this.aggrClient) {
      throw new Error(
        "[AgentWallet] AGGR not configured. Pass aggrConfig to use conditional orders."
      );
    }

    const orderId = `order_${Date.now()}`;
    const fromAddress = this.getAssetAddress(order.asset);
    const toAddress = this.getAssetAddress(order.againstAsset);

    const cancelWatch = await this.aggrClient.watchPrice(
      fromAddress,
      toAddress,
      order.amount,
      this.config.componentAddress,
      order.triggerPrice,
      order.condition,
      5000, 
      async (quote: SwapQuote) => {
        console.log(
          `[AgentWallet] Order ${orderId} triggered at price ${quote.outputTokens / order.amount}`
        );
        // Cancela el monitor antes de ejecutar
        this.cancelOrder(orderId);
        
       // Mock — no ejecutar swap real
       if ((this.config.aggrConfig as any)?.mockMode) {
          console.log(`[AgentWallet] MOCK order ${orderId} triggered`);
        return;
        }
        // FIN MOCK


        await this.swap({
          fromAsset: order.asset,
          toAsset: order.againstAsset,
          amount: order.amount,
          maxSlippage: order.maxSlippage,
          reason: `conditional order ${orderId} triggered at price ${quote.outputTokens / order.amount}`,
        });
      }
      
    );

    // Guardamos la función de cancelación
    this.activeOrders.set(orderId, cancelWatch);

    return orderId;
  }

  // Cancela una orden condicional activa
  cancelOrder(orderId: string): boolean {
    const cancel = this.activeOrders.get(orderId);
    if (cancel) {
      cancel();
      this.activeOrders.delete(orderId);
      return true;
    }
    return false;
  }

  // Lista las órdenes activas
  listActiveOrders(): string[] {
    return Array.from(this.activeOrders.keys());
  }

  // Construye el manifiesto de transferencia desde el PolicyVault

  private buildTransferManifest(
  to: string,
  assetAddress: string,
  amount: number,
  badgeResourceAddress: string,
  badgeLocalId: string = "#1#"
): string {
  
   const notarizer = this.config.notarizerAddress ?? RadixClient.getAddress();
  return `
CALL_METHOD
    Address("${notarizer}")
    "lock_fee"
    Decimal("2")
;
  CALL_METHOD    
    Address("${this.config.componentAddress}")
    "lock_fee"
    Decimal("8")
;
CALL_METHOD
    Address("${notarizer}")
    "create_proof_of_non_fungibles"
    Address("${badgeResourceAddress}")
    Array<NonFungibleLocalId>(NonFungibleLocalId("${badgeLocalId}"))
;
POP_FROM_AUTH_ZONE
    Proof("agent_proof")
;
CALL_METHOD
    Address("${this.config.componentAddress}")
    "transfer"
    Address("${to}")
    Decimal("${amount}")
    Address("${assetAddress}")
    "transfer"
    Proof("agent_proof")
;
CALL_METHOD
    Address("${to}")
    "try_deposit_batch_or_abort"
    Expression("ENTIRE_WORKTOP")
    None
;`;
}


  // Firma y envía un manifiesto a la red Radix
  protected async submitManifest(manifest: string): Promise<string> {
    return await this.radixClient.submitManifest(manifest);
  }


waitForOwnerApproval(
  pendingDetails: { to: string; amount: string; asset: string; reason: string },
  intervalMs: number = 30000
): () => void {
  let active = true;
  let fromStateVersion = 0;

  // Obtener state_version actual antes de arrancar el polling
  const init = async () => {
    try {
      const response = await fetch(
        `${this.networkConfig.gatewayUrl}/stream/transactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            affected_global_entities_filter: [this.config.componentAddress],
            limit_per_page: 1,
            order: "Desc",
          })
        }
      );
      const data = await response.json();
      fromStateVersion = data?.items?.[0]?.state_version ?? 0;
      console.log(`[AgentWallet] waitForOwnerApproval — starting from state_version: ${fromStateVersion}`);
    } catch (err) {
      console.error("[AgentWallet] waitForOwnerApproval init error:", err);
    }
    setTimeout(checkResult, intervalMs);
  };

  const checkResult = async () => {
    if (!active) return;
    try {
      const response = await fetch(
        `${this.networkConfig.gatewayUrl}/stream/transactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            affected_global_entities_filter: [this.config.componentAddress],
            limit_per_page: 10,
            order: "Desc",
            opt_ins: { manifest_instructions: true }
          })
        }
      );
      const data = await response.json();
      const items = data?.items || [];

      // Solo mirar TXs posteriores al inicio del polling
      const newItems = items.filter((tx: any) => tx.state_version > fromStateVersion);

      for (const tx of newItems) {
        const instructions = tx.manifest_instructions || "";
        if (instructions.includes("approve_transfer")) {
          active = false;
          this.config.onTransferApproved?.(pendingDetails);
          return;
        }
        if (instructions.includes("reject_transfer")) {
          active = false;
          this.config.onTransferRejected?.(pendingDetails);
          return;
        }
      }
    } catch (err) {
      console.error("[AgentWallet] waitForOwnerApproval error:", err);
    }
    if (active) setTimeout(checkResult, intervalMs);
  };

  init();
  return () => { active = false; };
}

async getWhitelist(): Promise<{ name: string; address: string }[]> {
  const manifest = `
CALL_METHOD
    Address("${this.config.componentAddress}")
    "get_whitelist"
;
`;
  const response = await fetch(
    `${this.networkConfig.gatewayUrl}/transaction/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest,
        start_epoch_inclusive: 1,
        end_epoch_exclusive: 100,
        nonce: 1,
        signer_public_keys: [],
        notary_public_key: {
          key_type: "EddsaEd25519",
          key_hex: "0000000000000000000000000000000000000000000000000000000000000001"
        },
        notary_is_signatory: true,
        tip_percentage: 0,
        flags: {
          use_free_credit: true,
          assume_all_signature_proofs: true,
          skip_epoch_check: true
        }
      })
    }
  );
  const data = await response.json();
  const output = data?.receipt?.output?.[0]?.programmatic_json;
  if (!output || !output.elements) return [];
  return output.elements.map((item: any) => ({
    name: item.fields?.[0]?.value ?? "",
    address: item.fields?.[1]?.value ?? "",
  }));
}

async getSwapQuote(fromAsset: string, toAsset: string, amount: number): Promise<{ outputTokens: number; price: number }> {
  if (!this.aggrClient) {
    throw new Error("[AgentWallet] AGGR not configured. Pass aggrConfig to use swap quotes.");
  }
  const fromAddress = this.getAssetAddress(fromAsset as any);
  const toAddress = this.getAssetAddress(toAsset as any);
  
  const quote = await this.aggrClient.getSwapQuote(
    fromAddress,
    toAddress,
    amount,
    this.config.componentAddress
  );
  
  return {
    outputTokens: quote.outputTokens,
    price: quote.outputTokens / amount,
  };
}




}
