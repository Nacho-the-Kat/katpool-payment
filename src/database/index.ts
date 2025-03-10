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
        `SELECT wallet, SUM(balance) as total_balance, SUM(nacho_rebate_kas) as nacho_total_balance
         FROM miners_balance 
         WHERE miner_id != $1 
         GROUP BY wallet`,
        ['pool']
      );

      return res.rows.map((row: { wallet: string, total_balance: string, nacho_total_balance: string }) => ({
        minerId: 'aggregate', // Placeholder ID for aggregated balance, since we're grouping by wallet.
        address: row.wallet,
        balance: BigInt(row.total_balance),
        nachoBalance: BigInt(row.nacho_total_balance)
      }));
    } finally {
      client.release();
    }
  }

  async getAllPendingBalanceAboveThreshold(threshold: number) {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT SUM(total_balance) 
          FROM (
            SELECT SUM(balance) AS total_balance
            FROM miners_balance 
            WHERE miner_id != $1 
            GROUP BY wallet
            HAVING SUM(balance) >= $2 
          ) AS subquery`,
        ['pool', threshold]
      );

      return res.rows[0]?.sum ? BigInt(res.rows[0].sum) : BigInt(0);
    } finally {
      client.release();
    }
  }

  // Get Nacho Rebate KAS saved in pool entry
  async getPoolBalance() {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT balance
         FROM miners_balance 
         WHERE miner_id = $1`,
        ['pool']
      );

      return res.rows.map((row: { balance: string }) => ({
        balance: row.balance
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
