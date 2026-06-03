// ─── Network Configuration ────────────────────────────────────────────────────
// Fuente única de verdad para configuración de red.
// Anteriormente dispersa en AgentWallet.ts — ahora centralizada aquí.

export interface NetworkConfig {
  gatewayUrl: string;
  networkId: number;
}

// ─── Network configs ──────────────────────────────────────────────────────────

export const NETWORK_CONFIG: Record<string, NetworkConfig> = {
  mainnet: {
    gatewayUrl: "https://mainnet.radixdlt.com",
    networkId: 0x01,
  },
  stokenet: {
    gatewayUrl: "https://stokenet.radixdlt.com",
    networkId: 0x02,
  },
  localnet: {
    gatewayUrl: "http://localhost:8080",
    networkId: 0xf2,
  },
};

export function getNetworkConfig(network: string): NetworkConfig {
  const config = NETWORK_CONFIG[network];
  if (!config) throw new Error(`Invalid network "${network}". Valid: mainnet, stokenet, localnet`);
  return config;
}

export function detectNetwork(gatewayUrl: string): string {
  if (gatewayUrl.includes("stokenet")) return "stokenet";
  if (gatewayUrl.includes("localhost")) return "localnet";
  return "mainnet";
}
