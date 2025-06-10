import fs from 'fs';
import Monitoring from './monitoring';
import path from 'path';
import { kaspaToSompi } from '../wasm/kaspa/kaspa';

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

let KASPA_BASE_URL = 'https://api.kaspa.org';

if (CONFIG.network === 'testnet-10') {
  KASPA_BASE_URL = 'https://api-tn10.kaspa.org';
} else if (CONFIG.network === 'testnet-11') {
  KASPA_BASE_URL = 'https://api-tn11.kaspa.org';
}

export { KASPA_BASE_URL, CONFIG };
