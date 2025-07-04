import Database, { MinerBalanceRow } from '../database';
import {
  PendingTransaction,
  type IPaymentOutput,
  createTransactions,
  PrivateKey,
  UtxoProcessor,
  UtxoContext,
  type RpcClient,
  addressFromScriptPublicKey,
  // calculateTransactionFee,
  kaspaToSompi,
} from '../../wasm/kaspa-dev';
import Monitoring from '../monitoring';
import { db, DEBUG } from '../index';
import { CONFIG, FIXED_FEE } from '../constants';
import type { ScriptPublicKey } from '../../wasm/kaspa-dev/kaspa';
import { sompiToKAS } from '../utils';
import { validatePendingTransactions } from './utils';
import Jsonbig from 'json-bigint';
export default class trxManager {
  public networkId: string;
  public rpc: RpcClient;
  public privateKey: PrivateKey;
  public address: string;
  public processor: UtxoProcessor;
  public context: UtxoContext;
  public db: Database;
  public monitoring: Monitoring;

  constructor(networkId: string, privKey: string, databaseUrl: string, rpc: RpcClient) {
    this.monitoring = new Monitoring();
    this.networkId = networkId;
    this.rpc = rpc;
    if (DEBUG) this.monitoring.debug(`TrxManager: Network ID is: ${this.networkId}`);
    this.db = db;
    this.privateKey = new PrivateKey(privKey);
    this.address = this.privateKey.toAddress(networkId).toString();
    if (DEBUG) this.monitoring.debug(`TrxManager: Pool Treasury Address: ${this.address}`);
    this.processor = new UtxoProcessor({ rpc: this.rpc, networkId });
    this.context = new UtxoContext({ processor: this.processor });
    this.registerProcessor();
  }

  private async recordPayment(
    transactionHash: string,
    entries: { address: string; amount: bigint }[]
  ) {
    try {
      let values: string[] = [];
      let queryParams: string[][] = [];
      for (let i = 0; i < entries.length; i++) {
        const address = [entries[i].address];
        const amount = entries[i].amount;
        values.push(`($${i + 1}, ${amount}, NOW(), '${transactionHash}') `);
        queryParams.push(address);
      }
      const valuesPlaceHolder = values.join(',');
      const query = `INSERT INTO payments (wallet_address, amount, timestamp, transaction_hash) VALUES ${valuesPlaceHolder};`;
      await db.runQuery(query, queryParams);
    } catch (error) {
      this.monitoring.error(`TrxManager: recording payment for ${transactionHash}: ${error}`);
    }
  }

  async transferBalances(balances: MinerBalanceRow[]) {
    let payments: { [address: string]: bigint } = {};

    // Aggregate balances by wallet address
    for (const { address, balance } of balances) {
      if (!address) {
        this.monitoring.error(`TrxManager: transferBalances ~ Invalid address found: ${address}`);
        continue;
      }

      if (balance > 0) {
        payments[address] = (payments[address] || 0n) + balance;
      }
    }

    // Convert the payments object into an array of IPaymentOutput
    const paymentOutputs: IPaymentOutput[] = Object.entries(payments).map(([address, amount]) => {
      return {
        address,
        amount,
      };
    });

    const thresholdAmount = CONFIG.thresholdAmount;
    const thresholdEligiblePayments = paymentOutputs.filter(
      data => data.amount >= BigInt(thresholdAmount)
    );

    if (thresholdEligiblePayments.length === 0) {
      return this.monitoring.log('TrxManager: No payments found for current transfer cycle.');
    }

    // All pending balance to be transferred in current payment cycle
    const totalEligibleAmount = await this.db.getAllPendingBalanceAboveThreshold(
      Number(thresholdAmount)
    );
    this.monitoring.debug(
      `TrxManager: Total eligible KAS to be transferred in current payment cycle: ${sompiToKAS(Number(totalEligibleAmount))} KAS.`
    );

    // All pending balance
    const totalAmount = await this.db.getAllPendingBalanceAboveThreshold(0);
    this.monitoring.debug(
      `TrxManager: Total pending KAS to be transferred: ${sompiToKAS(Number(totalAmount))} KAS.`
    );

    // Enqueue transactions for processing
    await this.enqueueTransactions(thresholdEligiblePayments);
    this.monitoring.log(`TrxManager: Transactions queued for processing.`);
  }

  private async enqueueTransactions(outputs: IPaymentOutput[]) {
    const matureEntries = await this.fetchMatureUTXOs();
    const feeInSompi = kaspaToSompi(FIXED_FEE)!;

    let transactions: PendingTransaction[];
    try {
      const result = await createTransactions({
        entries: matureEntries,
        outputs,
        changeAddress: this.address,
        priorityFee: feeInSompi,
        networkId: this.networkId,
      });
      transactions = result.transactions;
    } catch (error) {
      this.monitoring.error(`TrxManager: Failed to create transactions: ${error}`);
      return;
    }

    // Log the lengths to debug any potential mismatch
    this.monitoring.log(
      `TrxManager: Created ${transactions.length} transactions for ${outputs.length} outputs.`
    );

    // Process each transaction sequentially with its associated address
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      await this.processTransaction(transaction); // Explicitly cast to string here too
    }
  }

  private async processTransaction(transaction: PendingTransaction) {
    validatePendingTransactions(transaction, this.privateKey, this.networkId);
    try {
      transaction.sign([this.privateKey]);
    } catch (error) {
      this.monitoring.error(`TrxManager: Failed to sign transaction ${transaction.id}: ${error}`);
      return;
    }

    //const txFee = calculateTransactionFee(this.networkId, transaction.transaction, 1)!;
    //this.monitoring.log(`TrxManager: Tx Fee ${sompiToKaspaStringWithSuffix(txFee, this.networkId)}`);

    if (DEBUG) this.monitoring.debug(`TrxManager: Submitting transaction ID: ${transaction.id}`);
    let transactionHash;
    try {
      transactionHash = await transaction.submit(this.rpc);
    } catch (error) {
      this.monitoring.error(`TrxManager: Failed to submit transaction ${transaction.id}: ${error}`);
      return;
    }

    if (DEBUG)
      this.monitoring.debug(`TrxManager: Waiting for transaction ID: ${transaction.id} to mature`);
    await this.waitForMatureUtxo(transactionHash);

    if (DEBUG)
      this.monitoring.debug(
        `TrxManager: Transaction ID ${transactionHash} has matured. Proceeding with next transaction.`
      );

    const txOutputs = transaction.transaction.outputs;
    const entries: { address: string; amount: bigint }[] = [];
    const toAddresses: string[] = [];
    for (const data of txOutputs) {
      const decodedAddress = addressFromScriptPublicKey(
        data.scriptPublicKey as ScriptPublicKey,
        this.networkId
      );
      if (!decodedAddress) {
        this.monitoring.error(
          `TrxManager: decodedAddress is undefined. for ${Jsonbig.stringify(data)}`
        );
      }
      const address = decodedAddress!.prefix + ':' + decodedAddress!.payload;
      const amount = data.value;
      if (address == this.address) continue;
      toAddresses.push(address);
      entries.push({ address, amount });
    }

    if (toAddresses.length > 0) {
      await this.recordPayment(transactionHash, entries);
    }
    // Reset the balance for the wallet after the transaction has matured
    await this.db.resetBalancesByWallet(toAddresses);
    this.monitoring.log(`TrxManager: Reset balances for wallet ${toAddresses}`);
    // Log all successful payments with amounts, recipient, and transaction ID.
    try {
      this.monitoring.log(`TrxManager: Transaction ID: ${transactionHash}`);
      for (const address of toAddresses) {
        try {
          const entry = entries.find(e => e.address === address);
          const amount = entry && entry.amount ? sompiToKAS(Number(entry.amount)) : 'UNKNOWN';
          this.monitoring.log(
            `TrxManager: Recipient: ${address} | amount: ${amount} | transaction hash: ${transactionHash}`
          );
        } catch (error) {
          this.monitoring.error(
            `TrxManager: Error logging recipient ${address} | transaction hash: ${transactionHash} | error: ${error}`
          );
          // Continue with next address
        }
      }
    } catch (error) {
      this.monitoring.error(`TrxManager: Error during logging: ${error}`);
    }
  }

  private async waitForMatureUtxo(transactionId: string): Promise<void> {
    const pollingInterval = 5000; // 5 seconds
    const maxAttempts = 60; // 5 minutes

    for (let i = 0; i < maxAttempts; i++) {
      const matureLength = this.context.matureLength;
      if (matureLength > 0) {
        if (DEBUG) this.monitoring.debug(`Transaction ID ${transactionId} is now mature.`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, pollingInterval));
    }

    throw new Error(`Timeout waiting for transaction ID ${transactionId} to mature.`);
  }

  utxoProcStartHandler = async () => {
    if (DEBUG) this.monitoring.debug(`TrxManager: this.context.clear()`);
    await this.context.clear();
    if (DEBUG) this.monitoring.debug(`TrxManager: tracking pool address`);
    await this.context.trackAddresses([this.address]);
  };

  private registerProcessor() {
    this.processor.addEventListener('utxo-proc-start', this.utxoProcStartHandler);
    this.processor.start();
  }

  async unregisterProcessor() {
    if (DEBUG) this.monitoring.debug(`TrxManager: unregisterProcessor - this.context.clear()`);
    await this.context.clear();
    if (DEBUG) this.monitoring.debug(`TrxManager: removeEventListener("utxo-proc-start")`);
    this.context.unregisterAddresses([this.address]);
    this.processor.removeEventListener('utxo-proc-start', this.utxoProcStartHandler);
    await this.processor.stop();
  }

  async fetchMatureUTXOs() {
    const coinbaseMaturity = 1000;
    // Fetch current DAA score
    const { virtualDaaScore } = await this.rpc.getBlockDagInfo();

    // Check if `virtualDaaScore` is undefined before proceeding
    if (virtualDaaScore === undefined) {
      throw new Error('Unable to fetch DAA score.');
    }

    // 1. Fetch and sort UTXOs by amount
    let utxoEntries = await this.rpc.getUtxosByAddresses([this.address]);

    // Ensure that `utxoEntries.entries` is not undefined
    if (!utxoEntries?.entries || !Array.isArray(utxoEntries.entries)) {
      throw new Error('Invalid or empty UTXO entries.');
    }

    const sortedEntries = utxoEntries.entries
      .slice() // Create a copy to avoid mutating the original array
      .sort((a, b) => Number(b.amount - a.amount)); // Sort by amount descending

    // 2. Filter based on Coinbase maturity (coinbase UTXOs only mature after a certain DAA score)
    let matureEntries = sortedEntries.filter(entry => {
      // Ensure that `entry` and required properties exist before proceeding
      if (
        !entry ||
        typeof entry.isCoinbase === 'undefined' ||
        typeof entry.blockDaaScore === 'undefined'
      ) {
        return false; // Skip invalid or incomplete entries
      }

      return (
        !entry.isCoinbase || // Allow non-coinbase UTXOs
        virtualDaaScore - entry.blockDaaScore >= coinbaseMaturity // Check if coinbase UTXOs are mature
      );
    });

    // If `matureEntries` is empty or undefined, use the fallback `entries` from `getMatureRange`
    if (!matureEntries || matureEntries.length === 0) {
      matureEntries = this.context.getMatureRange(0, this.context.matureLength);
    }

    return matureEntries;
  }
}
