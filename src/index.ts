/**
 * Made by the Nacho the Kat Team
 * 
 * This script initializes the katpool Payment App, sets up the necessary environment variables,
 * and schedules a balance transfer task based on configuration. It also provides progress logging 
 * every 10 minutes.
 */

import { RpcClient, Encoding, Resolver } from "../wasm/kaspa";
import config from "../config/config.json";
import dotenv from 'dotenv';
import Monitoring from './monitoring';
import trxManager from './trxs';
import cron from 'node-cron';
import * as cronParser from 'cron-parser';
import { cronValidation } from "./cron-schedule";

// Debug mode setting
export let DEBUG = 0;
if (process.env.DEBUG === "1") {
  DEBUG = 1;
}

const monitoring = new Monitoring();
monitoring.log(`Main: Starting katpool Payment App`);

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

const katpoolPshGw = process.env.PUSHGATEWAY;
if (!katpoolPshGw) {
  throw new Error('Environment variable PUSHGATEWAY is not set.');
}
if (DEBUG) monitoring.debug(`Main: PushGateway URL obtained`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Environment variable DATABASE_URL is not set.');
}
if (DEBUG) monitoring.debug(`Main: Database URL obtained`);

// Configuration parameters
const paymentCronSchedule = cronValidation(config.payoutCronSchedule); // Defaults to twice a day if not set
if (DEBUG) monitoring.debug(`Main: Payment cron is set to ${paymentCronSchedule}`);

if (DEBUG) monitoring.debug(`Main: Setting up RPC client`);

if (DEBUG) {
  monitoring.debug(`Main: Resolver Options:${config.node}`);
}

const interval = cronParser.parseExpression(paymentCronSchedule);
const nextScedule = new Date(interval.next().getTime()).toISOString();
if (DEBUG) monitoring.debug(`Main: Next payment is scheduled at ${nextScedule}`);

const rpc = new RpcClient({  
  resolver: new Resolver(),
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


cron.schedule(paymentCronSchedule, async () => {
  if (rpcConnected) {
    monitoring.log('Main: Running scheduled balance transfer');
    try {
      await transactionManager!.transferBalances();

    } catch (transactionError) {
      monitoring.error(`Main: Transaction manager error: ${transactionError}`);
    }
  } else {
    monitoring.error('Main: RPC connection is not established before balance transfer');
  }
});

// Progress indicator logging every 10 minutes
setInterval(() => {
  if (DEBUG) monitoring.debug(`Main: Waiting for next payment cycle ...`);
}, 10 * 60 * 1000); // 10 minutes in milliseconds
