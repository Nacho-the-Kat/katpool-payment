import fs from 'fs';
import path from 'path';
import Monitoring from '../monitoring';
import { kaspaToSompi } from '../../wasm/kaspa/kaspa';

const monitoring = new Monitoring();

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
