import type { LiquidityProvider, LiquidityProtocol, Pool } from "../../types";
import { DefiPlazaAdapter } from "./defiplaza";
import { getTwoPoolAdapter } from "./twopool";
import { getPrecisionAdapter } from "./ociswap_precision";
import { getQuantaSwapAdapter } from "./caviar_quantaswap";
import { getLsuPoolAdapter } from "./caviar_lsupool";
// Registry dinámico — el gatewayUrl se inyecta en runtime
let _defiPlazaAdapter: DefiPlazaAdapter | null = null;

function getDefiPlazaAdapter(gatewayUrl: string): DefiPlazaAdapter {
  if (!_defiPlazaAdapter) {
    _defiPlazaAdapter = new DefiPlazaAdapter(gatewayUrl);
  }
  return _defiPlazaAdapter;
}

export function getAdapter(protocol: LiquidityProtocol, gatewayUrl?: string): LiquidityProvider {
  switch (protocol) {
    case "caviar_lsupool":
  if (!gatewayUrl) throw new Error("gatewayUrl requerido para Caviar LSU Pool");
  return getLsuPoolAdapter(gatewayUrl);
      case "caviar_quantaswap":
  if (!gatewayUrl) throw new Error("gatewayUrl requerido para Caviar QuantaSwap");
  return getQuantaSwapAdapter(gatewayUrl);
    case "caviar":
      if (!gatewayUrl) throw new Error("gatewayUrl requerido para TwoPool Caviar");
      return getTwoPoolAdapter(gatewayUrl);
    case "ociswap":
      if (!gatewayUrl) throw new Error("gatewayUrl requerido para Ociswap BasicPool");
      return getTwoPoolAdapter(gatewayUrl);
    case "ociswap_precision":
      if (!gatewayUrl) throw new Error("gatewayUrl requerido para Ociswap PrecisionPool");
      return getPrecisionAdapter(gatewayUrl);
    case "defiPlaza":
      if (!gatewayUrl) throw new Error("gatewayUrl requerido para DefiPlaza");
      return getDefiPlazaAdapter(gatewayUrl);
    default:
      throw new Error(
        `Protocolo '${protocol}' no disponible. Protocolos soportados: caviar, ociswap, ociswap_precision, defiPlaza,caviar_lsupool, caviar_quantaswap`
      );
  }
}
export async function getAllPools(gatewayUrl?: string): Promise<Pool[]> {
  const twoPools       = gatewayUrl ? await getTwoPoolAdapter(gatewayUrl).getPools() : [];
  const precisionPools = gatewayUrl ? await getPrecisionAdapter(gatewayUrl).getPools() : [];
  const quantaPools    = gatewayUrl ? await getQuantaSwapAdapter(gatewayUrl).getPools() : [];
  const lsuPools       = gatewayUrl ? await getLsuPoolAdapter(gatewayUrl).getPools() : [];
  const defiPools      = gatewayUrl ? await getDefiPlazaAdapter(gatewayUrl).getPools() : [];
  return [...twoPools, ...precisionPools, ...quantaPools, ...lsuPools, ...defiPools];
}

export function getSupportedProtocols(): LiquidityProtocol[] {
  return ["caviar", "ociswap", "defiPlaza","caviar_quantaswap","ociswap_precision", "caviar_lsupool"];
}
