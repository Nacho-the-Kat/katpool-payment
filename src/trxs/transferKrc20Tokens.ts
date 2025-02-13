import { RpcClient } from "../../wasm/kaspa/kaspa";
import { transferKRC20 } from "./krc20Transfer";
import Database from '../database';

export async function transferKRC20Tokens(pRPC: RpcClient, pTicker: string) {
    const balances = await this.db.getAllBalancesExcludingPool();
    let payments: { [address: string]: bigint } = {};
    
    // Aggregate balances by wallet address
    for (const { address, balance } of balances) {
        if (balance > 0) {
            payments[address] = (payments[address] || 0n) + balance;
        }
    }
    
    /* TODO: 
        1. Use NACHORebateBuffer.
        2. Add check for 100M NACHO or 1 NFT and adjust balance accordingly.
        3. Set amount into ratio of NACHO.
    */
    
    Object.entries(payments).map(async ([address, amount]) => {
        let res = await transferKRC20(pRPC, pTicker, address, amount.toString());
        if (res?.error) {
            // Check
        } else {
            await recordPayment(address, amount, res?.revealHash);
        }
    });
}

async function recordPayment(address: string, amount: bigint, transactionHash: string) {
    const db = new Database(process.env.databaseUrl!);
    const client = await db.getClient();

    let values: string[] = [];
    values.push(`($${address}, ${amount}, NOW(), '${transactionHash}') `);
    
    const valuesPlaceHolder = values.join(',')
    const query = `INSERT INTO nacho_payments (wallet_address, nacho_amount, timestamp, transaction_hash) VALUES ${valuesPlaceHolder};`
    try {
      await client.query(query);
      resetBalancesByWallet(address, amount);
    } finally {
      client.release();
    }
}

async function resetBalancesByWallet(address : string, balance: bigint) {
    const client = await this.pool.connect();
    try {
        // Update miners_balance table
        const res = await client.query('SELECT balance FROM miners_balance WHERE id = $1', [address]);
        let minerBalance = res.rows[0] ? BigInt(res.rows[0].balance) : 0n;
        minerBalance -= balance;

        await client.query('UPDATE miners_balance SET balance = $1 WHERE wallet = ANY($2)', [minerBalance, address]);
    } finally {
        client.release();
    }
}