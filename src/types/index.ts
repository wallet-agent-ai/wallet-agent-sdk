export type SupportedAsset = string;

// Redes soportadas
export type NetworkType = "mainnet" | "stokenet" | "localnet";

// Configuración inicial de la wallet
export interface AgentWalletConfig {
  // Dirección del componente PolicyVault desplegado en Radix
  componentAddress: string;
  // Dirección del resource del badge del agente
  badgeLocalId?: string;        // defaults to "#1#"
  ownerBadgeAddress?: string;   // for multisig transfers
  notarizerAddress: string;
  badgeResourceAddress: string;
  // Clave privada del notarizador para firmar transacciones (opcional — si no se provee se lee del keystore)
  notarizerPrivateKey?: string;
  network: NetworkType;
  // Configuración opcional del AGGR para trading
  aggrConfig?: AGGRConfig;
  onLowFunds?: (warnings: string[]) => void;
  onTransferApproved?: (details: { to: string; amount: string; asset: string; reason: string }) => void;
  onTransferRejected?: (details: { to: string; amount: string; asset: string; reason: string }) => void;


}

// Configuración del AGGR — público (ASTRL) o privado (nuestro)
export interface AGGRConfig {
  // URL base del endpoint — solo cambia esto entre ASTRL y el nuestro
  endpoint: string;
  partnerId: string;
  // Timeout en ms para las llamadas al AGGR
  timeoutMs?: number;
  mockMode?: boolean;
}

// Parámetros de una transferencia
export interface TransferParams {
  // Dirección destino — tiene que estar en la whitelist del PolicyVault
  to: string;
  // Cantidad a transferir
  amount: number;
  // Asset a transferir
  asset: SupportedAsset;
  // Motivo de la transferencia — para el audit log
  reason: string;
}

// Parámetros de un swap a través del AGGR
export interface SwapParams {
  // Asset de origen
  fromAsset: SupportedAsset;
  // Asset destino
  toAsset: SupportedAsset;
  // Cantidad a intercambiar
  amount: number;
  // Slippage máximo aceptado en porcentaje (ej: 0.5 = 0.5%)
  maxSlippage: number;
  // Motivo — para el audit log
  reason: string;
}

// Orden condicional de trading
export interface ConditionalOrder {
  // Tipo de orden
  type: "buy" | "sell";
  // Asset a comprar o vender
  asset: SupportedAsset;
  // Asset contra el que se opera (normalmente HUSDC o XRD)
  againstAsset: SupportedAsset;
  // Cantidad
  amount: number;
  // Precio trigger — ejecuta cuando el precio pase este valor
  triggerPrice: number;
  // Condición: por encima o por debajo del precio trigger
  condition: "above" | "below";
  // Slippage máximo
  maxSlippage: number;
}

// Resultado de una transferencia
export interface TransferResult {
  txId: string;
  amount: number;
  asset: SupportedAsset;
  to: string;
  reason: string;
  timestamp: Date;
  success: boolean;
}

// Resultado de un swap
export interface SwapResult {
  txId: string;
  fromAsset: SupportedAsset;
  toAsset: SupportedAsset;
  amountIn: number;
  amountOut: number;
  executedPrice: number;
  reason: string;
  timestamp: Date;
  success: boolean;
}

// Resultado de consultar el balance del vault — multi-asset
export interface BalanceResult {
  balances: Partial<Record<string, number>>;
  resources: Array<{ symbol: string; resourceAddress: string; amount: number }>;
  nfts: Array<{ resourceAddress: string; ids: string[] }>;
  componentAddress: string;
  timestamp: Date;
}


// Precio de un asset desde el AGGR
export interface AssetPrice {
  asset: SupportedAsset;
  priceInUSDC: number;
  timestamp: Date;
}

// Configuración de red
export interface NetworkConfig {
  gatewayUrl: string;
  networkId: number;
}

// Addresses de los recursos en cada red
export interface AssetAddresses {
  XRD: string;
  HUSDC: string;
  HWBTC: string;
  HETH: string;
  HUSDT: string;
}
// Addresses de un asset custom por red
export interface CustomAssetAddresses {
  mainnet?: string;
  stokenet?: string;
  localnet?: string;
}

