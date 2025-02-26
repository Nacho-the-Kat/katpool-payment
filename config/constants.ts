import fs from "fs";
import Monitoring from "../src/monitoring";

const monitoring = new Monitoring();

// Default values
const DEFAULT_CONFIG = {
    node : [],
    network : "mainnet",
    payoutCronSchedule: "0 */12 * * *",
    thresholdAmount: "500000000",
    nachoThresholdAmount: "100000000000",    
    nachoRebateBuffer: "500000000",
    nachoSwap: 95,
    defaultTicker: "NACHO"
};

// Load `config.json` dynamically (if exists)
let CONFIG = { ...DEFAULT_CONFIG };
try {
  const configData = JSON.parse(fs.readFileSync("config.json", "utf8"));
  CONFIG = { ...CONFIG, ...configData }; // Merge with defaults
} catch (error) {
  monitoring.log("⚠️  config.json not found or invalid, using defaults.");
}

monitoring.log(`Current configuration used for Payments is : \n ${JSON.stringify(CONFIG, null, 4)}`);

// Export the config
export default CONFIG;
