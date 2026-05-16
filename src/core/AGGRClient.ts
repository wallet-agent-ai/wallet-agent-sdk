import { AGGRConfig, AssetPrice, SupportedAsset, SwapParams } from "../types";

// Respuesta raw del endpoint swap del AGGR
interface AGGRSwapResponse {
  outputTokens: number;
  manifest: string;
}

// Resultado del quote antes de ejecutar
export interface SwapQuote {
  outputTokens: number;
  manifest: string;
  fromAsset: SupportedAsset;
  toAsset: SupportedAsset;
  amountIn: number;
}

export class AGGRClient {
  private endpoint: string;
  private partnerId: string;
  private timeoutMs: number;
  private mockMode: boolean; 

  constructor(config: AGGRConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.partnerId = config.partnerId;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.mockMode = config.mockMode ?? false; 
  }

  // Obtiene quote Y manifiesto listo para firmar en una sola llamada
  async getSwapQuote(
    fromTokenAddress: string,
    toTokenAddress: string,
    amount: number,
    fromAddress: string
  ): Promise<SwapQuote> {
  // MOCK FIRST  
  if (this.mockMode) {
  console.log("[AGGRClient] MOCK mode — simulating swap quote");
  return {
    outputTokens: amount * 0.95,
    manifest: `CALL_METHOD
    Address("${fromAddress}")
    "try_deposit_batch_or_abort"
    Expression("ENTIRE_WORKTOP")
    None
;`,
    fromAsset: fromTokenAddress as SupportedAsset,
    toAsset: toTokenAddress as SupportedAsset,
    amountIn: amount,
  };
}

    // REAL 
    const response = await this.fetchWithTimeout(
      `${this.endpoint}/partner/${this.partnerId}/swap`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputToken: fromTokenAddress,
          outputToken: toTokenAddress,
          inputAmount: amount,
          fromAddress: fromAddress,
        }),
      }
    );

    const data: AGGRSwapResponse = await response.json();

    return {
      outputTokens: data.outputTokens,
      manifest: data.manifest,
      fromAsset: fromTokenAddress as SupportedAsset,
      toAsset: toTokenAddress as SupportedAsset,
      amountIn: amount,
    };
  }

  // Monitorea precio via quotes y ejecuta callback cuando se cumple condición
  async watchPrice(
    fromTokenAddress: string,
    toTokenAddress: string,
    referenceAmount: number,
    fromAddress: string,
    triggerPrice: number,
    condition: "above" | "below",
    intervalMs: number,
    callback: (quote: SwapQuote) => void
  ): Promise<() => void> {
    //MOCK 
     if (this.mockMode) {
    console.log("[AGGRClient] MOCK watchPrice — triggering immediately");
    const mockQuote: SwapQuote = {
      outputTokens: referenceAmount * 0.95,
      manifest: "",
      fromAsset: fromTokenAddress as SupportedAsset,
      toAsset: toTokenAddress as SupportedAsset,
      amountIn: referenceAmount,
    };
    setTimeout(() => callback(mockQuote), 300000);
    return () => {};
  }

    //REAL
    const interval = setInterval(async () => {
      try {
        const quote = await this.getSwapQuote(
          fromTokenAddress,
          toTokenAddress,
          referenceAmount,
          fromAddress
        );

        // El precio implícito es outputTokens / referenceAmount
        const implicitPrice = quote.outputTokens / referenceAmount;

        const triggered =
          condition === "above"
            ? implicitPrice >= triggerPrice
            : implicitPrice <= triggerPrice;

        if (triggered) {
          callback(quote);
        }
      } catch (error) {
        console.error(`[AGGRClient] Error watching price:`, error);
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }

  // Fetch con timeout
  private async fetchWithTimeout(
    url: string,
    options?: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `[AGGRClient] HTTP error: ${response.status} ${response.statusText}`
        );
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
