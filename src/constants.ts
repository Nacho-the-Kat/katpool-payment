import fs from 'fs';
import Monitoring from './monitoring';
import path from 'path';
import { kaspaToSompi } from '../wasm/kaspa/kaspa';
import { parseUnits } from 'ethers';

const monitoring = new Monitoring();

export const FIXED_FEE = '0.0001'; // Fixed minimal fee

// Default values
const DEFAULT_CONFIG = {
  node: [],
  network: 'mainnet',
  payoutCronSchedule: '0 */12 * * *',
  payoutAlertCronSchedule: '0 */6 * * *',
  thresholdAmount: kaspaToSompi('5')!,
  nachoThresholdAmount: kaspaToSompi('500')!,
  nachoRebateBuffer: kaspaToSompi('5')!,
  nachoSwap: 95,
  defaultTicker: 'NACHO',
  nachoAlertThreshold: kaspaToSompi('1000')!,
  kasAlertThreshold: kaspaToSompi('250')!,
  /*
   * Allowed NFT tickers eligible for full NACHO rebate.
   * Note: For 'KATCLAIM', only token IDs between 736 and 843 (inclusive) are considered valid.
   * This check is implemented in `krc20Api.ts`.
   */
  nftAllowedTicks: ['NACHO', 'KATCLAIM'],
};

// Function to validate config fields
const validateConfig = (config: any, defaults: any) => {
  const validatedConfig: any = { ...defaults };

  Object.keys(defaults).forEach(key => {
    if (config[key] !== undefined && config[key] !== null) {
      validatedConfig[key] = config[key]; // Use the value from config.json if valid
    }
  });

  return validatedConfig;
};

// Load `config.json` dynamically (if exists)
let CONFIG = { ...DEFAULT_CONFIG };
try {
  const configPath = path.resolve(__dirname, '../config/config.json');
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  monitoring.log(
    `Constants: Data loaded from config.json \n ${JSON.stringify(configData, null, 4)}`
  );
  CONFIG = validateConfig(configData, DEFAULT_CONFIG); // Ensure all fields are present
} catch (error) {
  monitoring.log(`Constants: ⚠️  config.json not found or invalid, using defaults. ${error}`);
}

monitoring.log(
  `Constants: Current configuration used for Payments is : \n ${JSON.stringify(CONFIG, null, 4)}`
);

export { CONFIG };

// Full rebate constants
export const fullRebateTokenThreshold = parseUnits('100', 14); // Minimum 100M (NACHO)
export const fullRebateNFTThreshold = 1; // Minimum 1 NFT

// UTXO selection thresholds in sompi (1 KAS = 100_000_000 sompi)
export const PREFERRED_MIN_UTXO = BigInt(kaspaToSompi('3')!); // 3 KAS
export const ABSOLUTE_MIN_UTXO = BigInt(kaspaToSompi('1')!); // 1 KAS

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set.`);
  }
  return value;
}

// Datadog Configuration
export const DATADOG_SECRET = getRequiredEnv('DATADOG_SECRET');
export const DATADOG_LOG_URL = getRequiredEnv('DATADOG_LOG_URL');
export const DATADOG_PAYMENT_SERVICE_NAME =
  process.env.DATADOG_PAYMENT_SERVICE_NAME || 'dev-katpool-payment';

// Debug Configuration
export const DEBUG = process.env.DEBUG === '1' ? 1 : 0;

// Treasury Configuration
export const treasuryPrivateKey = getRequiredEnv('TREASURY_PRIVATE_KEY');

// Database Configuration
export const databaseUrl = getRequiredEnv('DATABASE_URL');

// Network config
export const NETWORK_CONFIG = {
  mainnet: {
    rpcUrl: 'kaspad:17110',
    apiBaseUrl: 'https://api.kaspa.org',
  },
  'testnet-10': {
    rpcUrl: 'kaspad-test10:17210',
    apiBaseUrl: 'https://api-tn10.kaspa.org',
  },
} as const;

export type NetworkName = keyof typeof NETWORK_CONFIG;

export function getNetworkConfig(network: string) {
  const net = NETWORK_CONFIG[network as NetworkName];
  if (!net) throw new Error(`Unsupported network: ${network}`);
  return net;
}
