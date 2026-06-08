import {
  PrivateKey,
  RadixEngineToolkit,
  TransactionBuilder,
  TransactionHeader,
  TransactionManifest,
  NotarizedTransaction,
  generateRandomNonce,
} from "@steleaio/radix-engine-toolkit";
import { NetworkConfig } from "../types";

export class RadixClient {
  private privateKey: PrivateKey;
  private networkConfig: NetworkConfig;
  private networkId: number;

  constructor(privateKeyHex: string, networkConfig: NetworkConfig) {
    this.privateKey = new PrivateKey.Ed25519(privateKeyHex);
    this.networkConfig = networkConfig;
    this.networkId = networkConfig.networkId;
  }

  // Firma y envía un manifiesto a la red Radix
async submitManifest(manifestString: string): Promise<string> {
  const currentEpoch = await this.getCurrentEpoch();
  const transaction = await this.buildTransaction(manifestString, currentEpoch);
  
  // Calculamos el intent hash antes de compilar
  const intentHash = await RadixEngineToolkit.NotarizedTransaction.intentHash(transaction);
  
  const compiled = await RadixEngineToolkit.NotarizedTransaction.compile(transaction);
  await this.submitToGateway(compiled);
  
  // Esperamos confirmación usando el intent hash
  await this.waitForCommit(intentHash.id);
  
  return intentHash.id;
}


  // Construye la transacción firmada
  private async buildTransaction(
    manifestString: string,
    currentEpoch: number
  ): Promise<NotarizedTransaction> {
    const header: TransactionHeader = {
      networkId: this.networkId,
      startEpochInclusive: currentEpoch,
      endEpochExclusive: currentEpoch + 10, // válida por 10 epochs
      nonce: generateRandomNonce(),
      notaryPublicKey: this.privateKey.publicKey(),
      notaryIsSignatory: true,
      tipPercentage: 0,
    };

    const manifest: TransactionManifest = {
      instructions: {
        kind: "String",
        value: manifestString,
      },
      blobs: [],
    };

    const transaction = await TransactionBuilder.new().then((builder) =>
      builder
        .header(header)
        .manifest(manifest)
        .notarize(this.privateKey)
    );

    return transaction;
  }

  // Obtiene la epoch actual de la red
  private async getCurrentEpoch(): Promise<number> {
    const response = await fetch(
      `${this.networkConfig.gatewayUrl}/status/gateway-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    );

    const data = await response.json();
    return data.ledger_state.epoch;
  }

  // Envía la transacción compilada al Gateway
private async submitToGateway(compiled: Uint8Array): Promise<string> {
  const response = await fetch(
    `${this.networkConfig.gatewayUrl}/transaction/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notarized_transaction_hex: Buffer.from(compiled).toString("hex"),
      }),
    }
  );

  const data = await response.json();
  console.log("Gateway response:", JSON.stringify(data, null, 2));

  // Babylon Gateway devuelve intent_hash no transaction_identifier
  if (data.error_response) {
    throw new Error(`[RadixClient] Submit failed: ${JSON.stringify(data.error_response)}`);
  }

  // El intent_hash viene del toolkit — lo calculamos antes de enviar
  return data.intent_hash ?? "submitted";
}


  // Espera a que la transacción sea confirmada en el ledger
private async waitForCommit(
  intentHash: string,
  maxAttempts: number = 20,
  intervalMs: number = 3000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(
      `${this.networkConfig.gatewayUrl}/transaction/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent_hash: intentHash,
        }),
      }
    );

    const data = await response.json();
console.log(`[RadixClient] TX status (attempt ${i + 1}):`, JSON.stringify(data, null, 2));

    const status = data.intent_status ?? data.status;

    if (status === "CommittedSuccess") {
      console.log("[RadixClient] Transaction committed successfully");
      return;
    }

    if (status === "CommittedFailure" || status === "Rejected" || status === "PermanentlyRejected") {
      throw new Error(
        `[RadixClient] Transaction failed with status: ${status} — ${JSON.stringify(data)}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`[RadixClient] Transaction not committed after ${maxAttempts} attempts`);
}
// Carga la private key del keystore automáticamente
static fromKeystore(networkConfig: NetworkConfig): RadixClient {
  const { unlockKeystore } = require("../cli/unlock");
  const privateKeyHex = unlockKeystore();
  return new RadixClient(privateKeyHex, networkConfig);
}

// Devuelve la dirección del notarizador desde el keystore
static getAddress(): string {
  const { getNotarizerAddress } = require("../cli/unlock");
  return getNotarizerAddress();
}


}
