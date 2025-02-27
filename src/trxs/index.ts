import Database from '../database';
import { PendingTransaction, sompiToKaspaStringWithSuffix, type IPaymentOutput, createTransactions, PrivateKey, UtxoProcessor, UtxoContext, type RpcClient,  maximumStandardTransactionMass, addressFromScriptPublicKey, calculateTransactionFee } from "../../wasm/kaspa";
import Monitoring from '../monitoring';
import { DEBUG } from "../index";
import CONFIG from "../constants";
import type { ScriptPublicKey } from '../../wasm/kaspa/kaspa';

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
    this.db = new Database(databaseUrl);
    this.privateKey = new PrivateKey(privKey);
    this.address = this.privateKey.toAddress(networkId).toString();
    if (DEBUG) this.monitoring.debug(`TrxManager: Pool Treasury Address: ${this.address}`);
    this.processor = new UtxoProcessor({ rpc, networkId });
    this.context = new UtxoContext({ processor: this.processor });
    this.registerProcessor();
  }

  private async recordPayment(walletAddresses: string[], amount: bigint, transactionHash: string, entries: {address: string, amount: bigint}[]) {
    const client = await this.db.getClient();

    let values: string[] = [];
    let queryParams: string[][] = []
    for (let i = 0; i < entries.length; i++) {
      const address = [entries[i].address]
      const amount = entries[i].amount
      values.push(`($${i+1}, ${amount}, NOW(), '${transactionHash}') `)
      queryParams.push(address)
    }
    const valuesPlaceHolder = values.join(',')
    const query = `INSERT INTO payments (wallet_address, amount, timestamp, transaction_hash) VALUES ${valuesPlaceHolder};`
    try {
      await client.query(query, queryParams);
    } finally {
      client.release();
    }
  }

  async transferBalances(balances: any) {
    let payments: { [address: string]: bigint } = {};

    // Aggregate balances by wallet address
    for (const { address, balance } of balances) {
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
    const thresholdEligiblePayments = paymentOutputs.filter( data => data.amount >= BigInt(thresholdAmount));

    if (thresholdEligiblePayments.length === 0) {
      return this.monitoring.log('TrxManager: No payments found for current transfer cycle.');
    }

    // All pending balance to be transferred in current payment cycle
    const totalEligibleAmount = await this.db.getAllPendingBalanceAboveThreshold(Number(thresholdAmount));
    this.monitoring.debug(`TrxManager: Total eligible KAS to be transferred in current payment cycle: ${totalEligibleAmount}`);

    // All pending balance
    const totalAmount = await this.db.getAllPendingBalanceAboveThreshold(0);
    this.monitoring.debug(`TrxManager: Total pending KAS to be transferred: ${totalAmount}`);

    // Enqueue transactions for processing
    await this.enqueueTransactions(thresholdEligiblePayments);
    this.monitoring.log(`TrxManager: Transactions queued for processing.`);
  }

  private async enqueueTransactions(outputs: IPaymentOutput[]) {
    const { transactions } = await createTransactions({
      entries: this.context,
      outputs,
      changeAddress: this.address,
      priorityFee: 0n,
      networkId: this.networkId,
    });

    // Log the lengths to debug any potential mismatch
    this.monitoring.log(`TrxManager: Created ${transactions.length} transactions for ${outputs.length} outputs.`);

    // Process each transaction sequentially with its associated address
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      await this.processTransaction(transaction); // Explicitly cast to string here too
    }
  }

  private async processTransaction(transaction: PendingTransaction) {
    if (DEBUG) this.monitoring.debug(`TrxManager: Signing transaction ID: ${transaction.id}`);
    transaction.sign([this.privateKey]);

    //const txFee = calculateTransactionFee(this.networkId, transaction.transaction, 1)!;
    //this.monitoring.log(`TrxManager: Tx Fee ${sompiToKaspaStringWithSuffix(txFee, this.networkId)}`);

    if (DEBUG) this.monitoring.debug(`TrxManager: Submitting transaction ID: ${transaction.id}`);
    const transactionHash = await transaction.submit(this.processor.rpc);

    if (DEBUG) this.monitoring.debug(`TrxManager: Waiting for transaction ID: ${transaction.id} to mature`);
    await this.waitForMatureUtxo(transactionHash);

    if (DEBUG) this.monitoring.debug(`TrxManager: Transaction ID ${transactionHash} has matured. Proceeding with next transaction.`);

    const txOutputs = transaction.transaction.outputs;
    const entries: {address: string,amount: bigint}[] = [];
    const toAddresses: string[] = [];
    for(const data of txOutputs) {
      const decodedAddress = addressFromScriptPublicKey(data.scriptPublicKey as ScriptPublicKey, this.networkId);
      const address = (decodedAddress!.prefix + ":" + decodedAddress!.payload);
      const amount = data.value;
      if(address == this.address) continue
      toAddresses.push(address)
      entries.push({address, amount})
    }

    if(toAddresses.length > 0) {
      await this.recordPayment(toAddresses, transaction.paymentAmount, transactionHash, entries);
    }
    // Reset the balance for the wallet after the transaction has matured
    await this.db.resetBalancesByWallet(toAddresses);
    this.monitoring.log(`TrxManager: Reset balances for wallet ${toAddresses}`);
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

  private registerProcessor() {
    this.processor.addEventListener("utxo-proc-start", async () => {
      if (DEBUG) this.monitoring.debug(`TrxManager: registerProcessor - this.context.clear()`);
      await this.context.clear();
      if (DEBUG) this.monitoring.debug(`TrxManager: registerProcessor - tracking pool address`);
      await this.context.trackAddresses([this.address]);
    });
    this.processor.start();
  }
}
