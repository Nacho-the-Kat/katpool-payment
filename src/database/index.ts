import { Client } from 'pg';

type Miner = {
  balance: bigint;
};

type MinerBalanceRow = {
  miner_id: string;
  wallet: string;
  balance: string;
};

export default class Database {
  client: Client;

  constructor(connectionString: string) {
    this.client = new Client({
      connectionString: connectionString,
    });
    this.client.connect();
  }

  async getAllBalancesExcludingPool() {
    const res = await this.client.query(
      `SELECT wallet, SUM(balance) as total_balance 
       FROM miners_balance 
       WHERE miner_id != $1 
       GROUP BY wallet`,
      ['pool']
    );

    return res.rows.map((row: { wallet: string, total_balance: string }) => ({
      minerId: 'aggregate', // Placeholder ID for aggregated balance, since we're grouping by wallet.
      address: row.wallet,
      balance: BigInt(row.total_balance)
    }));
  }

  async resetBalancesByWallet(wallet: string) {
    await this.client.query('UPDATE miners_balance SET balance = $1 WHERE wallet = $2', [0n, wallet]);
  }
}
