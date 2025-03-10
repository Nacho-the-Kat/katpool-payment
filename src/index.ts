/**
 * Made by the Nacho the Kat Team
 * 
 * This script initializes the katpool Payment App, sets up the necessary environment variables,
 * and schedules a balance transfer task based on configuration. It also provides progress logging 
 * every 10 minutes.
 */

import { RpcClient, Encoding, Resolver } from "../wasm/kaspa";
import { CONFIG } from "./constants";
import dotenv from 'dotenv';
import Monitoring from './monitoring';
import trxManager from './trxs';
import cron from 'node-cron';
import * as cronParser from 'cron-parser';
import { cronValidation } from "./cron-schedule";
import swapToKrc20 from "./trxs/krc20/swapToKrc20";
import { transferKRC20Tokens } from "./trxs/krc20/transferKrc20Tokens";
import { krc20Token } from "./trxs/krc20/krc20Api";
import { fetchKASBalance } from "./utils";

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

if (!CONFIG.network) {
  throw new Error('No network has been set in config.json');
}
if (DEBUG) monitoring.debug(`Main: Network Id: ${CONFIG.network}`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Environment variable DATABASE_URL is not set.');
}
if (DEBUG) monitoring.debug(`Main: Database URL obtained`);

// Configuration parameters
const paymentCronSchedule = cronValidation(CONFIG.payoutCronSchedule); // Defaults to twice a day if not set
if (DEBUG) monitoring.debug(`Main: Payment cron is set to ${paymentCronSchedule}`);

if (DEBUG) monitoring.debug(`Main: Setting up RPC client`);

if (DEBUG) {
  monitoring.debug(`Main: Resolver Options:${CONFIG.node}`);
}

const interval = cronParser.parseExpression(paymentCronSchedule);
const nextScedule = new Date(interval.next().getTime()).toISOString();
if (DEBUG) monitoring.debug(`Main: Next payment is scheduled at ${nextScedule}`);

const rpc = new RpcClient({  
  resolver: new Resolver(),
  encoding: Encoding.Borsh,
  networkId: CONFIG.network,
});
let transactionManager: trxManager | null = null;
let swapToKrc20Obj: swapToKrc20 | null = null;
let rpcConnected = false;

const setupTransactionManager = () => {
  if (DEBUG) monitoring.debug(`Main: Starting transaction manager`);
  transactionManager = new trxManager(CONFIG.network, treasuryPrivateKey, databaseUrl, rpc!);
  setTimeout(() => {
    swapToKrc20Obj = new swapToKrc20(transactionManager!); // ✅ Delayed instantiation
  }, 0);
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
      if (!transactionManager) {
        monitoring.error("Main: transactionManager is undefined.");
      }
      
      if (!swapToKrc20Obj) {
        monitoring.error("Main: swapToKrc20Obj is undefined. Swap will be skipped.");
      }
      
      if (!CONFIG.defaultTicker) {
        monitoring.error("Main: CONFIG.defaultTicker is undefined. Using fallback.");
        CONFIG.defaultTicker = "NACHO";
      }      

      // Fetch and save balances map before performing payout
      const balances = await transactionManager!.db.getAllBalancesExcludingPool();
      let poolBalances = await transactionManager!.db.getPoolBalance();

      try {
        // Fetch treasury wallet address balance before Payout
        const treasuryKASBalance  = await fetchKASBalance(transactionManager!.address);
        if (treasuryKASBalance == -1 || treasuryKASBalance == null) {
          monitoring.error(`Main: Fetching KAS balance for address - ${transactionManager!.address}`);
        } else {
          monitoring.debug(`Main: KAS balance before transfer : ${treasuryKASBalance}`);
        }

        const treasuryNACHOBalance  = await krc20Token(transactionManager!.address, CONFIG.defaultTicker);
        monitoring.debug(`Main: ${CONFIG.defaultTicker} balance before transfer  : ${treasuryNACHOBalance.amount}`);
      } catch (error) {
        monitoring.error(`Main: Balance fetch before payout: ${error}`);  
      }

      let poolBalance = 0n;
      let amount: number = 0;
      if (poolBalances.length > 0) {
        poolBalance = BigInt(poolBalances[0].balance);
      } else {
        monitoring.error("Main: Could not fetch Pool balance from Database.")
      }

      // KAS Payout
      try {
        await transactionManager!.transferBalances(balances);
      } catch(error) {
        monitoring.error(`Main: Error during KAS payout: ${error}`);
      }

      // Swap KASPA to KRC20
      if (poolBalance == 0n){
        monitoring.error("Main: Pool treasury balance is 0. Could not perform any KRC20 payout.");
      } else {        
        try {
          poolBalance = ((BigInt(poolBalance) * BigInt(CONFIG.nachoSwap * 100)) / 10000n);
          monitoring.debug(`Main: Swapping ${poolBalance} sompi to ${CONFIG.defaultTicker} tokens`);
          amount = await swapToKrc20Obj!.swapKaspaToKRC(poolBalance);
          monitoring.debug(`Main: Amount of ${CONFIG.defaultTicker} received after swapping: ${amount} ${CONFIG.defaultTicker}`); 
        } catch (error) {
          monitoring.error(`Main: Error swapping KASPA to KRC20: ${error}`);
        }
      }

      let balanceAfter = -1;
      try {
        const res = await krc20Token(transactionManager!.address, CONFIG.defaultTicker);
        balanceAfter = res.amount;
      if (res.error != '') {
        monitoring.error(`Main: Error fetching ${CONFIG.defaultTicker} token balance: ${res.error}`);
      } else {
        monitoring.log(`Main: Treasury wallet ${transactionManager?.address} has ${balanceAfter} ${CONFIG.defaultTicker} tokens after swap.`);
      }
      } catch (error) {
        monitoring.error(`Main: Error fetching balance after swap: ${error}`);
      }
      // const maxAllowedBalance = amount * 115 / 100; // amount + 15%
      
      // /*
      //   Failure cases:
      //     1. If for some reason the KRC20 transfer was not performed or failed in previous cycle. Use all tokens as transfer amount.
      //     2. If swap fails and we have excess KRC20 tokens.
      // */
      // if (balanceAfter > maxAllowedBalance || (amount == 0 && balanceAfter >= parseInt("3600", 8))) {
      //   amount = balanceAfter; // No need to deduct rebate buffer here. It will be done in below transfer call.
      // }
      
      // Transfer KRC20
      if (amount != 0) {
        try {
          monitoring.log(`Main: Running scheduled KRC20 balance transfer`);
          await transferKRC20Tokens(rpc, CONFIG.defaultTicker, amount!, balances, poolBalance, transactionManager!);          
          monitoring.log(`Main: Scheduled KRC20 balance transfer completed`);
        } catch (error) {
          monitoring.error(`Main: Error during KRC20 transfer: ${error}`);
        }
      } else {
        monitoring.error("Main: KRC20 swap could not be performed");
      }

      try {
        // Fetch treasury wallet address balance after Payout
        const treasuryKASBalance  = await fetchKASBalance(transactionManager!.address);
        monitoring.log(`Main: KAS balance after transfer : ${treasuryKASBalance}`);
  
        const treasuryNACHOBalance  = await krc20Token(transactionManager!.address, CONFIG.defaultTicker);
        monitoring.log(`Main: ${CONFIG.defaultTicker} balance after transfer  : ${treasuryNACHOBalance}`);
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
