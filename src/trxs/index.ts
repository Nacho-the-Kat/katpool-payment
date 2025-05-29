import Database, { MinerBalanceRow } from '../database';
import {
  PendingTransaction,
  sompiToKaspaStringWithSuffix,
  type IPaymentOutput,
  createTransactions,
  PrivateKey,
  UtxoProcessor,
  UtxoContext,
  type RpcClient,
  maximumStandardTransactionMass,
  addressFromScriptPublicKey,
  calculateTransactionFee,
} from '../../wasm/kaspa';
import Monitoring from '../monitoring';
import { db, DEBUG } from '../index';
import { CONFIG } from '../constants';
import type { ScriptPublicKey } from '../../wasm/kaspa/kaspa';
import { sompiToKAS } from '../utils';

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
    this.processor = new UtxoProcessor({ rpc, networkId });
    this.context = new UtxoContext({ processor: this.processor });
    this.registerProcessor();
  }

  async recordPayment(transactionHash: string, entries: { address: string; amount: bigint }[]) {
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

    const { transactions } = await createTransactions({
      entries: matureEntries,
      outputs,
      changeAddress: this.address,
      priorityFee: 0n,
      networkId: this.networkId,
    });

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
    if (DEBUG) this.monitoring.debug(`TrxManager: Signing transaction ID: ${transaction.id}`);
    if (!this.privateKey) {
      this.monitoring.error(`TrxManager: Private key is missing or invalid.`);
      return;
    }
    transaction.sign([this.privateKey]);

    //const txFee = calculateTransactionFee(this.networkId, transaction.transaction, 1)!;
    //this.monitoring.log(`TrxManager: Tx Fee ${sompiToKaspaStringWithSuffix(txFee, this.networkId)}`);

    if (DEBUG) this.monitoring.debug(`TrxManager: Submitting transaction ID: ${transaction.id}`);
    const transactionHash = await transaction.submit(this.processor.rpc);

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
  }

  async waitForMatureUtxo(transactionId: string): Promise<void> {
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
