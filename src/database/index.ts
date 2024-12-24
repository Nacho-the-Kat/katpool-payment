import { Pool } from 'pg';

type Miner = {
  balance: bigint;
};

type MinerBalanceRow = {
  miner_id: string;
  wallet: string;
  balance: string;
};

export default class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString: connectionString,
    });
  }

  public async getClient() {
    return this.pool.connect();
}

  async getAllBalancesExcludingPool() {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
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
    } finally {
      client.release();
    }
  }

  async resetBalancesByWallet(wallets: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query('UPDATE miners_balance SET balance = $1 WHERE wallet = ANY($2)', [0n, wallets]);
    } finally {
      client.release();
    }
  }
}
