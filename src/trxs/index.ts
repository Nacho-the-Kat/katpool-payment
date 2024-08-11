import Database from '../database';
import { sompiToKaspaStringWithSuffix, type IPaymentOutput, createTransactions, PrivateKey, UtxoProcessor, UtxoContext, type RpcClient, type PendingTransaction } from "../../wasm/kaspa";
import Monitoring from '../monitoring';
import { DEBUG } from "../index";
import { Address } from "../../wasm/kaspa";

export default class trxManager {
  private networkId: string;
  private privateKey: PrivateKey;
  private address: string;
  private processor: UtxoProcessor;
  private context: UtxoContext;
  private db: Database;
  private monitoring: Monitoring;
  private transactionAddressMap: Map<string, string> = new Map(); // Mapping to store transaction IDs and corresponding addresses

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
    await this.db.client.query(`
        INSERT INTO payments (wallet_address, amount, timestamp, transaction_hash)
        VALUES ($1, $2, NOW(), $3)
    `, [walletAddress, amount.toString(), transactionHash]);
  }

  private async transferBalances() {
    const balances = await this.db.getAllBalancesExcludingPool();
    let payments: { [address: string]: bigint } = {};

    // Aggregate balances by wallet address
    for (const { address, balance } of balances) {
      if (balance > 0) {
        payments[address] = (payments[address] || 0n) + balance;
      }
    }

    const paymentOutputs: IPaymentOutput[] = Object.entries(payments).map(([address, amount]) => ({
      address: address as string, // Cast to string explicitly
      amount,
    }));

    if (paymentOutputs.length === 0) {
      return this.monitoring.log('TrxManager: No payments found for current transfer cycle.');
    }

    // Create and map transactions to addresses
    const { transactions } = await createTransactions({
      entries: this.context,
      outputs: paymentOutputs,
      changeAddress: this.address,
      priorityFee: 0n
    });

    // Log the lengths to debug any potential mismatch
    this.monitoring.debug(`Created ${transactions.length} transactions for ${paymentOutputs.length} outputs.`);

    transactions.forEach((transaction, index) => {
      if (index >= paymentOutputs.length) {
        this.monitoring.error(`TrxManager: Index ${index} out of bounds for paymentOutputs length ${paymentOutputs.length}`);
        return;
      }

      const outputAddress = paymentOutputs[index]?.address;
      if (!outputAddress) {
        this.monitoring.error(`TrxManager: No address found for transaction at index ${index}`);
        return;
      }

      const address = typeof outputAddress === 'string'
        ? outputAddress
        : (outputAddress as Address).toString();

      this.transactionAddressMap.set(transaction.id, address);
    });

    // Process each transaction sequentially
    for (const transaction of transactions) {
      await this.processTransaction(transaction);
    }
  }

  private async processTransaction(transaction: PendingTransaction) {
    if (DEBUG) this.monitoring.debug(`TrxManager: Signing transaction ID: ${transaction.id}`);
    await transaction.sign([this.privateKey]);

    if (DEBUG) this.monitoring.debug(`TrxManager: Submitting transaction ID: ${transaction.id}`);
    const transactionHash = await transaction.submit(this.processor.rpc);

    if (DEBUG) this.monitoring.debug(`TrxManager: Waiting for transaction ID: ${transaction.id} to mature`);
    await this.waitForMatureUtxo(transactionHash);

    if (DEBUG) this.monitoring.debug(`TrxManager: Transaction ID ${transactionHash} has matured. Proceeding with next transaction.`);

    // Retrieve the address from the mapping and reset the balance
    const address = this.transactionAddressMap.get(transaction.id);
    if (address) {
      await this.db.resetBalancesByWallet(address);
      this.monitoring.log(`TrxManager: Reset balances for wallet ${address}`);
    } else {
      this.monitoring.error(`TrxManager: Address not found for transaction ID ${transaction.id}`);
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
