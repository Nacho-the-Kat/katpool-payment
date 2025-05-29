import { Pool, QueryResult, QueryResultRow } from 'pg';
import Monitoring from '../monitoring';

const monitoring = new Monitoring();

type Miner = {
  balance: bigint;
};

const balFallBack: Miner[] = [
  {
    balance: -1n,
  },
];

export type MinerBalanceRow = {
  minerId: string;
  address: string;
  balance: bigint;
  nachoBalance: bigint;
  upholdBalance: bigint;
};

const fallback: MinerBalanceRow[] = [
  {
    minerId: '',
    address: '',
    balance: -1n,
    nachoBalance: -1n,
    upholdBalance: -1n,
  },
];

export enum status {
  PENDING = 'PENDING',
  FAILED = 'FAILED',
  COMPLETED = 'COMPLETED',
}

function isValidStatus(value: any): value is status {
  return Object.values(status).includes(value);
}

export enum pendingKRC20TransferField {
  nachoTransferStatus = 'nacho_transfer_status',
  dbEntryStatus = 'db_entry_status',
}

function isValidpendingKRC20TransferField(value: any): value is pendingKRC20TransferField {
  return Object.values(pendingKRC20TransferField).includes(value);
}

export default class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    monitoring.debug(`database: New pool created.`);
    this.pool = new Pool({
      connectionString: connectionString,
      max: 50,
      // idleTimeoutMillis: 60000, // 1 minute idle timeout
      // connectionTimeoutMillis: 7000, // fail fast if DB is not responding
      // statement_timeout: 30000, // max query time
    });

    this.pool.on('acquire', () => monitoring.debug('database: Client acquired'));
    this.pool.on('release', () => monitoring.debug('database: Client released'));
    this.pool.on('error', err => monitoring.error(`database: Pool error ${err}`));
  }

  public getDBPoolStats() {
    monitoring.debug(
      `database: getClient() ~ DB Pool - total: ${this.pool.totalCount}, idle: ${this.pool.idleCount}, waiting: ${this.pool.waitingCount}`
    );
  }

  public async runQuery<T extends QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async getAllBalancesExcludingPool() {
    try {
      const res = await this.pool.query(
        `SELECT 
           SUM(balance) FILTER (WHERE wallet LIKE 'kaspa:%') AS total_balance,
           SUM(nacho_rebate_kas) AS nacho_total_balance,
           SUM(balance) FILTER (WHERE wallet NOT LIKE 'kaspa:%') AS uphold_balance
         FROM miners_balance
         WHERE miner_id != $1;`,
        ['pool']
      );

      return res.rows.map(
        (row: {
          wallet: string;
          total_balance: string;
          nacho_total_balance: string;
          uphold_balance: string;
        }): MinerBalanceRow => ({
          minerId: 'aggregate', // Placeholder ID for aggregated balance, since we're grouping by wallet.
          address: row.wallet,
          balance: BigInt(row.total_balance),
          nachoBalance: BigInt(row.nacho_total_balance),
          upholdBalance: BigInt(row.uphold_balance),
        })
      );
    } catch (error) {
      monitoring.error(`database: getAllBalancesExcludingPool - query error: ${error}`);
      return fallback;
    }
  }

  async getAllPendingBalanceAboveThreshold(threshold: number) {
    try {
      const res = await this.pool.query(
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
    } catch (error) {
      monitoring.error(`database: getAllPendingBalanceAboveThreshold - query error: ${error}`);
      return -1n;
    }
  }

  // Get Nacho Rebate KAS saved in pool entry
  async getPoolBalance() {
    try {
      const res = await this.pool.query(
        `SELECT balance
         FROM miners_balance 
         WHERE miner_id = $1`,
        ['pool']
      );

      return res.rows.map(
        (row: { balance: string }): Miner => ({
          balance: BigInt(row.balance),
        })
      );
    } catch (error) {
      monitoring.error(`database: getPoolBalance - query error: ${error}`);
      return balFallBack;
    }
  }

  async resetBalancesByWallet(wallets: string[]) {
    try {
      await this.pool.query('UPDATE miners_balance SET balance = $1 WHERE wallet = ANY($2)', [
        0n,
        wallets,
      ]);
      monitoring.debug(
        `database: reset for wallet balance - query executed for wallets: ${wallets}`
      );
    } catch (error) {
      monitoring.error(`database: resetBalancesByWallet - query error: ${error}`);
    }
  }

  async recordPendingKRC20Transfer(
    firstTxnID: string,
    sompiToMiner: bigint,
    nachoAmount: bigint,
    address: string,
    p2shAddress: string,
    nachoTransferStatus: status,
    dbEntryStatus: status
  ) {
    monitoring.debug(`database: recordPendingKRC20Transfer - first txn id - ${firstTxnID}`);
    try {
      const query = `INSERT INTO pending_krc20_transfers (first_txn_id, sompi_to_miner, nacho_amount, address, p2sh_address, nacho_transfer_status, db_entry_status, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());`;

      const values = [
        firstTxnID,
        sompiToMiner.toString(), // Convert BigInt to string if using PostgreSQL
        nachoAmount.toString(), // Convert BigInt to string if using PostgreSQL
        address,
        p2shAddress,
        nachoTransferStatus,
        dbEntryStatus,
      ];

      await this.pool.query(query, values);
      monitoring.debug(
        `database: recording pending KRC20 transfer - query executed for P2SH address: ${p2shAddress} - first txn hash ${firstTxnID}`
      );
    } catch (error) {
      monitoring.error(`database: recording pending KRC20 transfer: ${error}`);
    }
  }

  /**
   * Updates the status of a pending KRC20 transfer in the database.
   *
   * @param updateField - The field to be updated in the transfer record.
   * @param newValue - The new value to set for the field.
   * @throws {Error} If the provided update field is not allowed or if a database error occurs.
   */
  async updatePendingKRC20TransferStatus(
    p2shAddr: string,
    fieldToBeUpdated: string,
    updatedStatus: status
  ) {
    monitoring.debug(
      `database: updatePendingKRC20TransferStatus - p2sh: ${p2shAddr}, fieldToBeUpdated: ${fieldToBeUpdated} and updatedStatus: ${updatedStatus}`
    );
    if (!isValidpendingKRC20TransferField(fieldToBeUpdated)) {
      monitoring.error(
        `database: updatePendingKRC20TransferStatus ~ Invalid fieldToBeUpdated provided: ${fieldToBeUpdated}`
      );
      throw new Error(`Invalid fieldToBeUpdated provided: ${fieldToBeUpdated}`);
    }

    if (!isValidStatus(updatedStatus)) {
      monitoring.error(
        `database: updatePendingKRC20TransferStatus ~ Invalid status provided: ${updatedStatus}`
      );
      throw new Error(`Invalid status provided: ${updatedStatus}`);
    }

    try {
      const query = `UPDATE pending_krc20_transfers 
                   SET ${fieldToBeUpdated} = $1 
                   WHERE p2sh_address = $2`;

      monitoring.debug(
        `database: updatePendingKRC20TransferStatus - query will be invoked for ${p2shAddr}`
      );
      await this.pool.query(query, [updatedStatus, p2shAddr]);
      monitoring.debug(
        `database: updatePendingKRC20TransferStatus - query executed for ${p2shAddr}`
      );
    } catch (error) {
      monitoring.error(`database: updating pending KRC20 transfer: ${error}`);
      throw error;
    }
  }

  async getPayoutPreferenceFromUpholdId(uphold_id: string) {
    try {
      // Fetch user id from Uphold id
      const idRes = await this.pool.query(
        `SELECT id FROM uphold_connections WHERE uphold_id = $1`,
        [uphold_id]
      );

      if (idRes.rows.length === 0) {
        monitoring.error(
          `database: getPayoutPreferenceFromUpholdId - no user found for uphold_id: ${uphold_id}`
        );
        return null;
      }

      const user_id = idRes.rows[0].id;

      // Fetch uphold payout preference
      const res = await this.pool.query(
        `SELECT asset_code, network FROM uphold_payout_preferences WHERE user_id = $1`,
        [user_id]
      );

      if (res.rows.length === 0) {
        monitoring.error(
          `database: getPayoutPreferenceFromUpholdId - no payout preference found for user_id: ${user_id}`
        );
        return null;
      }

      return {
        asset_code: res.rows[0].asset_code,
        network: res.rows[0].network,
      };
    } catch (error) {
      monitoring.error(
        `database: getPayoutPreferenceFromUpholdId - database query error: ${error instanceof Error ? error.stack : error}`
      );
      return null;
    }
  }

  async recordUpholdPayment(
    address: string,
    amount: bigint,
    kas_amount: bigint,
    upholdTransactionId: string,
    asset_code: string,
    network: string
  ) {
    try {
      // Fetch user id from Uphold id
      const idRes = await this.pool.query(
        `SELECT id FROM uphold_connections WHERE uphold_id = $1`,
        [address]
      );

      if (idRes.rows.length === 0) {
        monitoring.error(
          `database: getPayoutPreferenceFromUpholdId - no user found for uphold_id: ${address}`
        );
        return null;
      }

      const user_id = idRes.rows[0].id;

      // Insert into uphold payments
      const query = `INSERT INTO uphold_payments (user_id, amount, kas_amount, asset_code, network, uphold_transaction_id) VALUES ($1, $2, $3, $4, $5, $6);`;
      const values = [user_id, amount, kas_amount, asset_code, network, upholdTransactionId];
      const res = await this.pool.query(query, values);

      if (res.rowCount !== 1) {
        monitoring.error(`database: recordUpholdPayment - insert failed for address: ${address}`);
        return false;
      }

      monitoring.log(`database: recordUpholdPayment - insert successful for address: ${address}`);
      return true;
    } catch (error) {
      monitoring.error(`database: recordUpholdPayment - query error: ${error}`);
      return false;
    }
  }

  async getUserDetails(uphold_id: string) {
    const client = await this.pool.connect();
    try {
      const res = await client.query(`SELECT * FROM uphold_connections WHERE uphold_id = $1`, [
        uphold_id,
      ]);

      if (res.rows.length === 0) {
        return null; // Indicates user not found. Caller handles logic based on null return.
      }
      return res.rows[0];
    } catch (error) {
      monitoring.error(`database: getUserDetails: ${error}`);
      return null;
    } finally {
      client.release();
    }
  }
}
