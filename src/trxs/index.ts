import Database from '../database';
import { sompiToKaspaStringWithSuffix, type IPaymentOutput, createTransactions, PrivateKey, UtxoProcessor, UtxoContext, type RpcClient } from "../../wasm/kaspa";
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
    // Log payment into the katpool-app's payments table using the existing db connection
    await this.db.client.query(`
        INSERT INTO payments (wallet_address, amount, timestamp, transaction_hash)
        VALUES ($1, $2, NOW(), $3)
    `, [walletAddress, amount.toString(), transactionHash]);
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

    const paymentOutputs: IPaymentOutput[] = Object.entries(payments).map(([address, amount]) => ({ address, amount }));

    if (paymentOutputs.length === 0) {
      return this.monitoring.log('TrxManager: No payments found for current transfer cycle.');
    }

    // Ensure the send method is processed sequentially
    try {
      const transactionId = await this.send(paymentOutputs);
      this.monitoring.log(`TrxManager: Sent payments. Transaction ID: ${transactionId}`);

      if (transactionId) {
        for (const [address, amount] of Object.entries(payments)) {
          await this.recordPayment(address, amount, transactionId);
          await this.db.resetBalancesByWallet(address);
          this.monitoring.log(`TrxManager: Reset balances for wallet ${address}`);
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.monitoring.error(`Transfer failed: ${error.message}`);
      } else {
        this.monitoring.error('Transfer failed: An unknown error occurred');
      }
    }
  }

  async send(outputs: IPaymentOutput[]) {
    console.log(outputs);

    // Recreate the context and processor to avoid reuse issues
    this.context = new UtxoContext({ processor: this.processor });
    if (DEBUG) this.monitoring.debug(`TrxManager: Recreated Context: ${this.context}`);

    const { transactions, summary } = await createTransactions({
      entries: this.context,
      outputs,
      changeAddress: this.address,
      priorityFee: 0n
    });

    for (const transaction of transactions) {
      if (DEBUG) this.monitoring.debug(`TrxManager: Payment with Transaction ID: ${transaction.id} to be signed`);
      try {
        await transaction.sign([this.privateKey]);
      } catch (err: unknown) {
        if (err instanceof Error) {
          this.monitoring.error(`Error signing transaction ${transaction.id}: ${err.message}`);
        } else {
          this.monitoring.error(`Error signing transaction ${transaction.id}: An unknown error occurred`);
        }
        return;  // Early return or handle as needed
      }
      if (DEBUG) this.monitoring.debug(`TrxManager: Payment with Transaction ID: ${transaction.id} to be submitted`);
      try {
        await transaction.submit(this.processor.rpc);
      } catch (err: unknown) {
        if (err instanceof Error) {
          this.monitoring.error(`Error submitting transaction ${transaction.id}: ${err.message}`);
        } else {
          this.monitoring.error(`Error submitting transaction ${transaction.id}: An unknown error occurred`);
        }
        return;  // Early return or handle as needed
      }
      if (DEBUG) this.monitoring.debug(`TrxManager: Payment with Transaction ID: ${transaction.id} submitted`);
    }

    if (DEBUG) this.monitoring.debug(`TrxManager: Summary Final Transaction ID: ${summary.finalTransactionId}`);
    return summary.finalTransactionId;
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

  // stopProcessor () {
  //   this.processor.stop()
  // }
}
