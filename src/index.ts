/**
 * Made by the Nacho the Kat Team
 * 
 * This script initializes the kaspool Payment App, sets up the necessary environment variables,
 * and schedules a balance transfer task based on configuration. It also provides progress logging 
 * every 10 minutes.
 */

import { RpcClient, Encoding, Resolver } from "../wasm/kaspa";
import config from "../config/config.json";
import dotenv from 'dotenv';
import Monitoring from './monitoring';
import trxManager from './trxs';
import cron from 'node-cron';

// Debug mode setting
export let DEBUG = 0;
if (process.env.DEBUG === "1") {
  DEBUG = 1;
}

const monitoring = new Monitoring();
monitoring.log(`Main: Starting kaspool Payment App`);

dotenv.config();

// Environment variable checks
const treasuryPrivateKey = process.env.TREASURY_PRIVATE_KEY;
if (!treasuryPrivateKey) {
  throw new Error('Environment variable TREASURY_PRIVATE_KEY is not set.');
}
if (DEBUG) monitoring.debug(`Main: Obtained treasury private key`);

if (!config.network) {
  throw new Error('No network has been set in config.json');
}
if (DEBUG) monitoring.debug(`Main: Network Id: ${config.network}`);

const kaspoolPshGw = process.env.PUSHGATEWAY;
if (!kaspoolPshGw) {
  throw new Error('Environment variable PUSHGATEWAY is not set.');
}
if (DEBUG) monitoring.debug(`Main: PushGateway URL obtained`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Environment variable DATABASE_URL is not set.');
}
if (DEBUG) monitoring.debug(`Main: Database URL obtained`);

// Configuration parameters
const paymentInterval = config.paymentInterval || 2; // Default to 2 hours if not set
if (paymentInterval < 1 || paymentInterval > 24) {
  throw new Error('paymentInterval must be between 1 and 24 hours.');
}
if (DEBUG) monitoring.debug(`Main: Payment interval set to ${paymentInterval} hours`);


if (DEBUG) monitoring.debug(`Main: Setting up RPC client`);


if (DEBUG) {
  monitoring.debug(`Main: Resolver Options:`);

}
const rpc = new RpcClient({

  resolver: new Resolver({
    urls: config.node
  }),
  encoding: Encoding.Borsh,
  networkId: config.network,
});
let transactionManager: trxManager | null = null;
let rpcConnected = false;

const setupTransactionManager = () => {
  if (DEBUG) monitoring.debug(`Main: Starting transaction manager`);
  transactionManager = new trxManager(config.network, treasuryPrivateKey, databaseUrl, rpc!);
};

const startRpcConnection = async () => {
  if (DEBUG) monitoring.debug(`Main: Starting RPC connection`);
  try {
    await rpc.connect();
  } catch (rpcError) {
    throw Error('RPC connection error');
  }
  const serverInfo = await rpc.getServerInfo();
  if (!serverInfo.isSynced || !serverInfo.hasUtxoIndex) {
    throw Error('Provided node is either not synchronized or lacks the UTXO index.');
  }
  rpcConnected = true;

};

if (!rpcConnected) {
  await startRpcConnection();
  if (DEBUG) monitoring.debug('Main: RPC connection started');
  if (DEBUG) monitoring.debug(`Main: RPC connection established`);
  setupTransactionManager();
}


cron.schedule(`*/10 * * * *`, async () => {
  const now = new Date();
  const minutes = now.getMinutes();
  const hours = now.getHours();

  const isPaymentTime = minutes === 0 && (hours % paymentInterval === 0);


  if (isPaymentTime && rpcConnected) {
    monitoring.log('Main: Running scheduled balance transfer');
    try {
      await transactionManager!.transferBalances();

    } catch (transactionError) {
      monitoring.error(`Main: Transaction manager error: ${transactionError}`);
    }
  } else if (isPaymentTime && !rpcConnected) {
    monitoring.error('Main: RPC connection is not established before balance transfer');
  }
});

// Progress indicator logging every 10 minutes
setInterval(() => {
  const now = new Date();
  const minutes = now.getMinutes();
  const hours = now.getHours();

  const nextTransferHours = paymentInterval - (hours % paymentInterval);
  const remainingMinutes = nextTransferHours * 60 - minutes;
  const remainingTime = remainingMinutes === nextTransferHours * 60 ? 0 : remainingMinutes;

  if (DEBUG) monitoring.debug(`Main: ${remainingTime} minutes until the next balance transfer`);
}, 10 * 60 * 1000); // 10 minutes in milliseconds

monitoring.log(`Main: Scheduled balance transfer every ${paymentInterval} hours`);
