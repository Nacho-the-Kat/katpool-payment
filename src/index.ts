/**
 * Made by the Nacho the Kat Team
 * 
 * This script initializes the katpool Payment App, sets up the necessary environment variables,
 * and schedules a balance transfer task based on configuration. It also provides progress logging 
 * every 10 minutes.
 */

import { RpcClient, Encoding, Resolver, kaspaToSompi } from "../wasm/kaspa";
import config from "../config/config.json";
import dotenv from 'dotenv';
import Monitoring from './monitoring';
import trxManager from './trxs';
import cron from 'node-cron';
import * as cronParser from 'cron-parser';
import { cronValidation } from "./cron-schedule";
import swapToKrc20 from "./trxs/krc20/swapToKrc20";
import { transferKRC20Tokens } from "./trxs/krc20/transferKrc20Tokens";
import { krc20Token } from "./trxs/krc20/krc20Api";
import { fetchKASBalance, sompiToKAS } from "./utils";

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
const swapToKrc20Obj = new swapToKrc20();

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
      // Fetch and save balances map before performing payout
      const balances = await transactionManager!.db.getAllBalancesExcludingPool();
      let poolBalances = await transactionManager!.db.getPoolBalance();

      monitoring.log(`Main: KAS payout threshold: ${sompiToKAS(Number(config.thresholdAmount))} KAS`)
      monitoring.log(`Main: NACHO payout threshold: ${sompiToKAS(Number(config.nachoThresholdAmount))} ${config.defaultTicker}`)

      let treasuryNACHOBalance = 0n;
      try {
        // Fetch treasury wallet address balance before Payout
        const treasuryKASBalance  = await fetchKASBalance(transactionManager!.address);
        monitoring.debug(`Main: KAS balance before transfer : ${sompiToKAS(Number(treasuryKASBalance))} KAS`);

        treasuryNACHOBalance = await krc20Token(transactionManager!.address, config.defaultTicker);
        monitoring.debug(`Main: ${config.defaultTicker} balance before transfer  : ${sompiToKAS(Number(treasuryNACHOBalance))} ${config.defaultTicker}`);
      } catch (error) {
        monitoring.error(`Main: Balance fetch before payout: ${error}`);  
      }

      let poolBalance = 0n;
      let amount: bigint = 0n;
      if (poolBalances.length > 0) {
        poolBalance = BigInt(poolBalances[0].balance);
      } else {
        transactionManager!.monitoring.error("Main: Could not fetch Pool balance from Database.")
      }

      // KAS Payout
      try {
        await transactionManager!.transferBalances(balances);
      } catch(error) {
        monitoring.error(`Main: Error during KAS payout: ${error}`);
      }

      // Get quote for KASPA to NACHO for rebate
      if (poolBalance == 0n){
        monitoring.error("Main: Pool treasury balance is 0. Could not perform any KRC20 payout.");
      } else {        
        try {
          poolBalance = ((BigInt(poolBalance) * BigInt(config.nachoSwap * 100)) / 10000n);
          amount = await swapToKrc20Obj!.swapKaspaToKRC(poolBalance);
          monitoring.debug(`Main: Amount of ${config.defaultTicker} tokens to be used for NACHO rebate: ${Number(amount) / Number(kaspaToSompi('1')!)} ${config.defaultTicker}`); 
        } catch (error) {
          monitoring.error(`Main: Fetching KAS to NACHO quote: ${error}`);
        }
      }
      
      // Transfer NACHO
      if (amount != 0n && treasuryNACHOBalance > amount) {
        try {
          monitoring.log(`Main: Running scheduled KRC20 balance transfer`);
          await transferKRC20Tokens(rpc, config.defaultTicker, amount!, balances, poolBalance, transactionManager!);          
          monitoring.log(`Main: Scheduled KRC20 balance transfer completed`);
        } catch (error) {
          monitoring.error(`Main: Error during KRC20 transfer: ${error}`);
        }
      } else {
        monitoring.debug(`Main: Current amount of KASPA is to low to distribute NACHO rebate.`);
      }

      try {
        // Fetch treasury wallet address balance after Payout
        const treasuryKASBalance  = await fetchKASBalance(transactionManager!.address);
        monitoring.log(`Main: KAS balance after transfer : ${sompiToKAS(Number(treasuryKASBalance))} KAS`);
  
        const treasuryNACHOBalance  = await krc20Token(transactionManager!.address, config.defaultTicker);
        monitoring.log(`Main: ${config.defaultTicker} balance after transfer  : ${sompiToKAS(Number(treasuryNACHOBalance))} ${config.defaultTicker}`);
      } catch (error) {
        monitoring.error(`Main: Balance fetch after payout: ${error}`);  
      }
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
