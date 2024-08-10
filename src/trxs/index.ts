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
    if (DEBUG) this.monitoring.debug(`TrxManager: Pool Address: ${this.address}`);
    this.processor = new UtxoProcessor({ rpc, networkId });
    this.context = new UtxoContext({ processor: this.processor });
    this.registerProcessor()
  }

  async transferBalances() {
    const balances = await this.db.getAllBalancesExcludingPool();
    let payments: { [address: string]: bigint } = {};
  
    // Aggregate balances by wallet address
    for (const { address, balance } of balances) {
      if (balance > 0) {
        if (!payments[address]) {
          payments[address] = balance;
        } else {
          payments[address] += balance;
        }
      }
    }
  
    // Convert the payments object into an array of IPaymentOutput
    const paymentOutputs: IPaymentOutput[] = Object.entries(payments).map(([address, amount]) => ({
      address,
      amount,
    }));
  
    if (paymentOutputs.length === 0) {
      return this.monitoring.log('TrxManager: No payments found for current transfer cycle.');
    }
  
    const transactionId = await this.send(paymentOutputs);
    this.monitoring.log(`TrxManager: Sent payments. Transaction ID: ${transactionId}`);
  
    if (transactionId) {
      // Reset balances for all affected addresses
      for (const address of Object.keys(payments)) {
        await this.db.resetBalancesByWallet(address);
        this.monitoring.log(`TrxManager: Reset balances for wallet ${address}`);
      }
    }
  }

  async send(outputs: IPaymentOutput[]) {
    console.log(outputs);
    if (DEBUG) this.monitoring.debug(`TrxManager: Context to be used: ${this.context}`);
    const { transactions, summary } = await createTransactions({
      entries: this.context,
      outputs,
      changeAddress: this.address,
      priorityFee: 0n
    });

    for (const transaction of transactions) {
      if (DEBUG) this.monitoring.debug(`TrxManager: Payment with ransaction ID: ${transaction.id} to be signed`);
      await transaction.sign([this.privateKey]);
      if (DEBUG) this.monitoring.debug(`TrxManager: Payment with ransaction ID: ${transaction.id} to be submitted`);
      await transaction.submit(this.processor.rpc);
      if (DEBUG) this.monitoring.debug(`TrxManager: Payment with ransaction ID: ${transaction.id} submitted`);
    }

    if (DEBUG) this.monitoring.debug(`TrxManager: summary.finalTransactionId: ${summary.finalTransactionId}`);
    return summary.finalTransactionId;

  }


  private registerProcessor () {
    this.processor.addEventListener("utxo-proc-start", async () => {
      if (DEBUG) this.monitoring.debug(`TrxManager: registerProcessor - this.context.clear()`);
      await this.context.clear()
      if (DEBUG) this.monitoring.debug(`TrxManager: registerProcessor - tracking pool address`);
      await this.context.trackAddresses([ this.address ])
    })
    this.processor.start()
  }  

  // stopProcessor () {
  //   this.processor.stop()
  // }  


}
