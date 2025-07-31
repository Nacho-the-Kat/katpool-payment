import { parseUnits } from 'ethers';
import { kaspaToSompi } from '../../wasm/kaspa/kaspa';

export const FIXED_FEE = '0.0001'; // Fixed minimal fee

// Full rebate constants
export const fullRebateTokenThreshold = parseUnits('100', 14); // Minimum 100M (NACHO)
export const fullRebateNFTThreshold = 1; // Minimum 1 NFT

// UTXO selection thresholds in sompi (1 KAS = 100_000_000 sompi)
export const PREFERRED_MIN_UTXO = BigInt(kaspaToSompi('3')!); // 3 KAS
export const ABSOLUTE_MIN_UTXO = BigInt(kaspaToSompi('1')!); // 1 KAS

// NACHO floor price url
export const quoteURL = 'https://api.kaspa.com/api/floor-price?ticker=NACHO';

// Network config
export const NETWORK_CONFIG = {
  mainnet: {
    rpcUrl: 'kaspad:17110',
    apiBaseUrl: 'https://api.kaspa.org',
    kasplexUrl: 'https://api.kasplex.org',
    krc721StreamUrl: 'https://mainnet.krc721.stream',
  },
  'testnet-10': {
    rpcUrl: 'kaspad-test10:17210',
    apiBaseUrl: 'https://api-tn10.kaspa.org',
    kasplexUrl: 'https://tn10api.kasplex.org',
    krc721StreamUrl: 'https://testnet-10.krc721.stream',
  },
} as const;

export type NetworkName = keyof typeof NETWORK_CONFIG;

export function getNetworkConfig(network: string) {
  const net = NETWORK_CONFIG[network as NetworkName];
  if (!net) throw new Error(`Unsupported network: ${network}`);
  return net;
}
