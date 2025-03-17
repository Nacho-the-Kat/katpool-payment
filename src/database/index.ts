import { Pool } from 'pg';
import Monitoring from '../monitoring';

type Miner = {
  balance: bigint;
};

type MinerBalanceRow = {
  miner_id: string;
  wallet: string;
  balance: string;
};

export enum status {
  PENDING = "PENDING",
  FAILED = "FAILED",
  COMPLETED = "COMPLETED"
}

export enum pendingKRC20TransferField {
  nachoTransferStatus = 'nacho_transfer_status',
  dbEntryStatus = 'db_entry_status'
}

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

  async recordPendingKRC20Transfer(firstTxnID: string, 
    sompiToMiner: bigint, 
    nachoAmount: bigint, 
    address: string, 
    p2shAddress: string, 
    nachoTransferStatus: status, 
    dbEntryStatus: status) {
    const client = await this.pool.connect();
    
    const query = `INSERT INTO pending_krc20_transfers (first_txn_id, sompi_to_miner, nacho_amount, address, p2sh_address, nacho_transfer_status, db_entry_status, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());`;

    const values = [
      firstTxnID,
      sompiToMiner.toString(), // Convert BigInt to string if using PostgreSQL
      nachoAmount.toString(),  // Convert BigInt to string if using PostgreSQL
      address,
      p2shAddress,
      nachoTransferStatus,
      dbEntryStatus
    ];
  
    try {
      await client.query(query, values);
    } catch (error) {
      new Monitoring().error(`database: recording pending KRC20 transfer: ${error}`);      
    } finally {
      client.release();
    }
  }

  async updatePendingKRC20TransferStatus(p2shAddr: string, fieldToBeUpdated: string, updatedStatus: status) {
    const client = await this.pool.connect();

    const query = `UPDATE pending_krc20_transfers 
                   SET ${fieldToBeUpdated} = $1 
                   WHERE p2sh_address = $2`;
    
    try {
      await client.query(query, [updatedStatus, p2shAddr]);
    } catch (error) {
      new Monitoring().error(`database: updating pending KRC20 transfer: ${error}`);      
    } finally {
      client.release();
    }
  }
}
