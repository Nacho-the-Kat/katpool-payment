/**
 * Made by the Nacho the Kat Team
 *
 * This script initializes the katpool Payment App, sets up the necessary environment variables,
 * and schedules a balance transfer task based on configuration. It also provides progress logging
 * every 10 minutes.
 */

import dotenv from 'dotenv';
dotenv.config();

import { RpcClient, Encoding, Resolver } from '../wasm/kaspa';
import { CONFIG } from './constants';
import Monitoring from './monitoring';
import trxManager from './trxs';
import cron from 'node-cron';
import * as cronParser from 'cron-parser';
import { cronValidation } from './cron-schedule';
import swapToKrc20 from './trxs/krc20/swapToKrc20';
import { transferKRC20Tokens } from './trxs/krc20/transferKrc20Tokens';
import { krc20Token } from './trxs/krc20/krc20Api';
import { fetchKASBalance, sompiToKAS } from './utils';
import { TelegramBotAlert } from './alerting/telegramBot';
import bot from './alerting/bot';
import Database from './database';
import { upholdPayout } from './trxs/uphold';

// Debug mode setting
export let DEBUG = 0;
if (process.env.DEBUG === '1') {
  DEBUG = 1;
}

const monitoring = new Monitoring();
monitoring.log(`Main: Starting katpool Payment App`);

process.on('exit', code => {
  monitoring.log(`Main: 🛑 Process is exiting with code: ${code}`);
});

process.on('uncaughtException', err => {
  monitoring.error(`Main: Uncaught Exception: ${err}`);
});

process.on('unhandledRejection', (reason, promise) => {
  monitoring.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('SIGINT', () => {
  monitoring.log('Main: SIGINT received. Exiting gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  monitoring.log('Main: SIGTERM received. Exiting gracefully...');
  process.exit(0);
});

// Environment variable checks
const treasuryPrivateKey = process.env.TREASURY_PRIVATE_KEY;
if (!treasuryPrivateKey) {
  throw new Error('Environment variable TREASURY_PRIVATE_KEY is not set.');
}
if (!CONFIG.network) {
  throw new Error('No network has been set in config.json');
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Environment variable DATABASE_URL is not set.');
}
export const db = new Database(databaseUrl);

if (!process.env.UPHOLD_CLIENT_ID) {
  throw new Error('Environment variable UPHOLD_CLIENT_ID is not set.');
}
if (!process.env.UPHOLD_CLIENT_SECRET) {
  throw new Error('Environment variable UPHOLD_CLIENT_SECRET is not set.');
}

// Configuration parameters
const paymentCronSchedule = cronValidation(CONFIG.payoutCronSchedule); // Defaults to twice a day if not set
if (DEBUG) monitoring.debug(`Main: Payment cron is set to ${paymentCronSchedule}`);

const paymentAlertCronSchedule = cronValidation(CONFIG.payoutAlertCronSchedule, true); // Defaults to four times a day if not set
if (DEBUG) monitoring.debug(`Main: Payment alert cron is set to ${paymentAlertCronSchedule}`);

if (bot) {
  monitoring.debug(`Main: Telegram bot is active.`);
}

const interval = cronParser.parseExpression(paymentCronSchedule);
const nextScedule = new Date(interval.next().getTime()).toISOString();
if (DEBUG) monitoring.debug(`Main: Next payment is scheduled at ${nextScedule}`);

const alertInterval = cronParser.parseExpression(paymentAlertCronSchedule);
const nextAlertScedule = new Date(alertInterval.next().getTime()).toISOString();
if (DEBUG) monitoring.debug(`Main: Next alert is scheduled at ${nextAlertScedule}`);

const rpc = new RpcClient({
  resolver: new Resolver(),
  encoding: Encoding.Borsh,
  networkId: CONFIG.network,
});
const swapToKrc20Obj = new swapToKrc20();

let transactionManager: trxManager | null = null;

const setupTransactionManager = () => {
  if (DEBUG) monitoring.debug(`Main: Starting transaction manager`);
  transactionManager = new trxManager(CONFIG.network, treasuryPrivateKey, databaseUrl, rpc!);
};

const startRpcConnection = async () => {
  if (DEBUG) monitoring.debug(`Main: Starting RPC connection`);
  try {
    await rpc.connect();
    monitoring.log(`Main RPC connected.`);
  } catch (rpcError) {
    throw Error(`RPC connection error: ${rpcError}`);
  }
  const serverInfo = await rpc.getServerInfo();
  if (!serverInfo.isSynced || !serverInfo.hasUtxoIndex) {
    throw Error('Provided node is either not synchronized or lacks the UTXO index.');
  }
};

const rpcConnectionTrxManagerSetup = async () => {
  await startRpcConnection();
  if (DEBUG) monitoring.debug('Main: RPC connection started');
  if (DEBUG) monitoring.debug(`Main: RPC connection established`);
  setupTransactionManager();
};

const getRpcStatus = () => {
  if (rpc?.isConnected) {
    return true;
  }
  return false;
};

const exitStepsPaymentCron = async () => {
  await Bun.sleep(60000);

  await transactionManager?.unregisterProcessor();
  try {
    rpc.removeEventListener('utxos-changed', () => {
      monitoring.debug(`Main: Removed event listener for 'utxos-changed'`);
    });
  } catch (error) {
    monitoring.error(`Main: Removing event listener for 'utxos-changed': ${error}`);
  }

  monitoring.log(`Main: Invoking DB Pool stats after every operation completion...`);
  db.getDBPoolStats();
};

cron.schedule(paymentCronSchedule, () => {
  (async () => {
    try {
      if (DEBUG) monitoring.debug(`Main: Setting up RPC client`);
      await rpcConnectionTrxManagerSetup();

      if (DEBUG) {
        monitoring.debug(`Main: Obtained treasury private key`);
        monitoring.debug(`Main: Network Id: ${CONFIG.network}`);
        monitoring.debug(`Main: Database URL obtained`);
        monitoring.debug(`Main: Resolver Options:${CONFIG.node}`);
      }

      // Wait for one minute before invoking balance transfer.
      await Bun.sleep(60000);

      if (getRpcStatus()) {
        monitoring.log('Main: Running scheduled balance transfer');
        try {
          if (!transactionManager) {
            monitoring.error('Main: transactionManager is undefined.');
          }

          if (!swapToKrc20Obj) {
            monitoring.error('Main: swapToKrc20Obj is undefined. Swap will be skipped.');
          }

          if (!CONFIG.defaultTicker) {
            monitoring.error('Main: CONFIG.defaultTicker is undefined. Using fallback.');
            CONFIG.defaultTicker = 'NACHO';
          }

          // Fetch and save balances map before performing payout
          const balances = await db.getAllBalancesExcludingPool();
          let poolBalances = await db.getPoolBalance();

          if (balances[0].balance === -1n) {
            monitoring.error('Main: Could not fetch balances for payout from Database.');
            exitStepsPaymentCron();
            monitoring.error(
              `Main: Payment Cron skipped for this cycle - ${new Date().toISOString()}.`
            );
            return;
          }

          monitoring.log(
            `Main: KAS payout threshold: ${sompiToKAS(Number(CONFIG.thresholdAmount))} KAS`
          );
          monitoring.log(
            `Main: NACHO payout threshold: ${sompiToKAS(Number(CONFIG.nachoThresholdAmount))} ${CONFIG.defaultTicker}`
          );

          let treasuryNACHOBalance = 0n;
          try {
            // Fetch treasury wallet address balance before Payout
            const treasuryKASBalance = await fetchKASBalance(transactionManager!.address);
            if (treasuryKASBalance == -1 || treasuryKASBalance == null) {
              monitoring.error(
                `Main: Fetching KAS balance for address - ${transactionManager!.address}`
              );
            } else {
              monitoring.debug(
                `Main: KAS balance before transfer: ${sompiToKAS(Number(treasuryKASBalance))} KAS`
              );
            }

            const result = await krc20Token(transactionManager!.address, CONFIG.defaultTicker);
            treasuryNACHOBalance = BigInt(result?.amount ?? 0);
            monitoring.debug(
              `Main: ${CONFIG.defaultTicker} balance before transfer: ${sompiToKAS(Number(treasuryNACHOBalance))} ${CONFIG.defaultTicker}`
            );
          } catch (error) {
            monitoring.error(`Main: Balance fetch before payout: ${error}`);
          }

          let poolBalance = 0n;
          let amount = 0n;
          if (Array.isArray(poolBalances) && poolBalances?.length > 0) {
            poolBalance = BigInt(poolBalances[0].balance);
          } else {
            monitoring.error('Main: Could not fetch Pool balance from Database.');
          }

          // 1. KAS Payout
          try {
            await transactionManager!.transferBalances(balances);
          } catch (error) {
            monitoring.error(`Main: Error during KAS payout: ${error}`);
          }

          // Get quote for KASPA to NACHO for rebate
          if (poolBalance == 0n) {
            monitoring.error(
              'Main: Pool treasury balance is 0. Could not perform any KRC20 payout.'
            );
          } else {
            try {
              poolBalance = (BigInt(poolBalance) * BigInt(CONFIG.nachoSwap * 100)) / 10000n;
              amount = await swapToKrc20Obj!.swapKaspaToKRC(poolBalance);
              monitoring.debug(
                `Main: Amount of ${CONFIG.defaultTicker} tokens to be used for NACHO rebate: ${sompiToKAS(Number(amount))} ${CONFIG.defaultTicker}`
              );
            } catch (error) {
              monitoring.error(`Main: Fetching KAS to NACHO quote: ${error}`);
            }
          }

          // 2. Transfer NACHO
          if (amount != 0n && treasuryNACHOBalance > amount) {
            try {
              // Wait for one minute before invoking KRC20 transfers.
              await Bun.sleep(60000);
              monitoring.log(`Main: Running scheduled KRC20 balance transfer`);
              await transferKRC20Tokens(
                rpc,
                CONFIG.defaultTicker,
                amount!,
                balances,
                poolBalance,
                transactionManager!
              );
              monitoring.log(`Main: Scheduled KRC20 balance transfer completed`);
            } catch (error) {
              monitoring.error(`Main: Error during KRC20 transfer: ${error}`);
            }
          } else {
            monitoring.debug(
              `Main: Current amount of KASPA is too low to distribute NACHO rebate.`
            );
          }

          // 3. Uphold Payout
          try {
            await upholdPayout(balances, transactionManager!);
          } catch (error) {
            monitoring.error(`Main: Error during Uphold payout: ${error}`);
          }

          try {
            await Bun.sleep(1000);
            // Fetch treasury wallet address balance after Payout
            const treasuryKASBalance = await fetchKASBalance(transactionManager!.address);
            monitoring.log(
              `Main: KAS balance after transfer : ${sompiToKAS(Number(treasuryKASBalance))} KAS`
            );

            const treasuryNACHOBalance = await krc20Token(
              transactionManager!.address,
              CONFIG.defaultTicker
            );
            monitoring.log(
              `Main: ${CONFIG.defaultTicker} balance after transfer: ${sompiToKAS(Number(treasuryNACHOBalance?.amount ?? 0))} ${CONFIG.defaultTicker}`
            );
          } catch (error) {
            monitoring.error(`Main: Balance fetch after payout: ${error}`);
          }
        } catch (transactionError) {
          monitoring.error(`Main: Transaction manager error: ${transactionError}`);
        }
      } else {
        monitoring.error('Main: RPC connection is not established before balance transfer');
      }

      exitStepsPaymentCron();

      monitoring.log('Main: ✅ Payment Cron final sleep done — safe to exit.');
    } catch (error) {
      monitoring.error(`Main: Unhandled error in paymentCronSchedule: ${error}`);
    }
  })();
});

cron.schedule(paymentAlertCronSchedule, () => {
  async () => {
    try {
      if (DEBUG) monitoring.debug(`Main: Setting up RPC client after Alerting cron is triggered`);
      await rpcConnectionTrxManagerSetup();

      // Wait for one minute before invoking balance transfer.
      await Bun.sleep(60000);

      if (getRpcStatus()) {
        try {
          const tgBotObj = new TelegramBotAlert();
          await tgBotObj.checkTreasuryWalletForAlert(transactionManager!);
        } catch (error) {
          monitoring.error(`Main: payment alert: ${error}`);
        }
      } else {
        monitoring.error('Main: RPC connection is not established before alerting cron');
      }

      await transactionManager?.unregisterProcessor();

      await Bun.sleep(1000); // Just before unregisterProcessor
      monitoring.log('Main: ✅ Alert Cron final sleep done — safe to exit.');
    } catch (error) {
      monitoring.error(`Main: Unhandled error in alertCronSchedule: ${error}`);
    }
  };
});
