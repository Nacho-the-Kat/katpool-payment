import Database from '../database';
import { PendingTransaction, sompiToKaspaStringWithSuffix, type IPaymentOutput, createTransactions, PrivateKey, UtxoProcessor, UtxoContext, type RpcClient } from "../../wasm/kaspa";
import Monitoring from '../monitoring';
import { DEBUG } from "../index";

export default class trxManager {
  private networkId: string;
  private privateKey: PrivateKey;
  private address: string;
  private processor: UtxoProcessor;
  private context: UtxoContext;
  private db: Database;
  private monitoring: Monitoring;

  constructor(networkId: string, privKey: string, databaseUrl: string, rpc: RpcClient) {
    this.monitoring = new Monitoring();
    this.networkId = networkId;
    if (DEBUG) this.monitoring.debug(`TrxManager: Network ID is: ${this.networkId}`);
    this.db = new Database(databaseUrl);
    this.privateKey = new PrivateKey(privKey);
    this.address = this.privateKey.toAddress(networkId).toString();
    if (DEBUG) this.monitoring.debug(`TrxManager: Pool Treasury Address: ${this.address}`);
    this.processor = new UtxoProcessor({ rpc, networkId });
    this.context = new UtxoContext({ processor: this.processor });
    this.registerProcessor();
  }

  private async recordPayment(walletAddress: string, amount: bigint, transactionHash: string) {
    const client = await this.db.getClient();
    try {
      await client.query(`
            INSERT INTO payments (wallet_address, amount, timestamp, transaction_hash)
            VALUES ($1, $2, NOW(), $3)
        `, [walletAddress, amount.toString(), transactionHash]);
    } finally {
      client.release();
    }
  }

  async transferBalances() {
    const balances = await this.db.getAllBalancesExcludingPool();
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

    if (paymentOutputs.length === 0) {
      return this.monitoring.log('TrxManager: No payments found for current transfer cycle.');
    }

    // Enqueue transactions for processing
    await this.enqueueTransactions(paymentOutputs);
    this.monitoring.log(`TrxManager: Transactions queued for processing.`);
  }

  private async enqueueTransactions(outputs: IPaymentOutput[]) {
    this.monitoring.log(`TrxManager: Preparing to create transactions for ${outputs.length} outputs.`);

    // Log the outputs being passed to createTransactions
    outputs.forEach((output, index) => {
      this.monitoring.debug(`Output ${index}: Address = ${output.address}, Amount = ${output.amount}`);
    });

    let transactions: PendingTransaction[];
    let attempts = 0;
    const maxRetries = 3;

    do {
      transactions = (await createTransactions({
        entries: this.context,
        outputs,
        changeAddress: this.address,
        priorityFee: 0n
      })).transactions;

      if (transactions.length === outputs.length) {
        break;
      }

      this.monitoring.log(`TrxManager: Mismatch detected on attempt ${attempts + 1}. Retrying...`);
      attempts++;

    } while (attempts < maxRetries);

    if (transactions.length !== outputs.length) {
      this.monitoring.error(`TrxManager: Failed to match transactions and outputs after ${maxRetries} attempts. Aborting.`);
      return;
    }

    this.monitoring.log(`TrxManager: Created ${transactions.length} transactions for ${outputs.length} outputs.`);

    // Process each transaction sequentially with its associated address
    for (let i = 0; i < transactions.length; i++) {
      if (!outputs[i]) {
        this.monitoring.error(`TrxManager: Missing output for transaction at index ${i}. Transactions length: ${transactions.length}, Outputs length: ${outputs.length}`);
        this.monitoring.debug(`Skipping transaction ID: ${transactions[i].id}`);
        continue;
      }

      const transaction = transactions[i];
      const address = typeof outputs[i].address === 'string'
        ? outputs[i].address
        : (outputs[i].address as any).toString();  // Explicitly cast Address to string

      this.monitoring.debug(`Processing transaction ID: ${transaction.id} for address: ${address}`);
      await this.processTransaction(transaction, address as string);
    }
  }

  private async processTransaction(transaction: PendingTransaction, address: string) {
    if (DEBUG) this.monitoring.debug(`TrxManager: Signing transaction ID: ${transaction.id}`);
    await transaction.sign([this.privateKey]);

    if (DEBUG) this.monitoring.debug(`TrxManager: Submitting transaction ID: ${transaction.id}`);
    const transactionHash = await transaction.submit(this.processor.rpc);

    if (DEBUG) this.monitoring.debug(`TrxManager: Waiting for transaction ID: ${transaction.id} to mature`);
    await this.waitForMatureUtxo(transactionHash);

    if (DEBUG) this.monitoring.debug(`TrxManager: Transaction ID ${transactionHash} has matured. Proceeding with next transaction.`);

    // Reset the balance for the wallet after the transaction has matured
    await this.db.resetBalancesByWallet(address);
    this.monitoring.log(`TrxManager: Reset balances for wallet ${address}`);
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
