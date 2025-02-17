import { RpcClient } from "../../../wasm/kaspa/kaspa";
import { transferKRC20 } from "./krc20Transfer";
import Database from '../../database';
import config from "../../../config/config.json";
import { krc20Token, nftAPI } from "./krc20Api";
import { parseUnits } from "ethers";

const fullRebateTokenThreshold = parseUnits("100", 14); // Minimum 100M (NACHO)
const fullRebateNFTThreshold = 1; // Minimum 1 NFT

export async function transferKRC20Tokens(pRPC: RpcClient, pTicker: string, krc20Amount: number) {
    const db = new Database(process.env.DATABASE_URL!)
    const balances = await db.getAllBalancesExcludingPool();
    let payments: { [address: string]: bigint } = {};
    
    // Aggregate balances by wallet address
    for (const { address, balance } of balances) {
        if (balance > 0) {
            payments[address] = (payments[address] || 0n) + balance;
        }
    }

    const NACHORebateBuffer = Number(config.nachoRebateBuffer);

    let poolBalance = 0n;
    let poolBalances = await this.transactionManager.db.getPoolBalance();
    if (poolBalances.length > 0) {
        poolBalance = balances[0].balance;
    } else {
        this.transactionManager.monitoring.error("Could not fetch Pool balance from Database.")
        return 0;
    }

    if (krc20Amount > NACHORebateBuffer) {
        krc20Amount = krc20Amount - NACHORebateBuffer;
    }
        
    Object.entries(payments).map(async ([address, amount]) => {
        // Check if the user is eligible for full fee rebate
        const fullRebate = await checkFullFeeRebate(address, "NACHO");
        if (fullRebate) {
            amount = amount * 3n;
        }
        
        // Set NACHO rebate amount in ratios.
        amount = (amount * BigInt(krc20Amount)) / poolBalance;
        
        let res = await transferKRC20(pRPC, pTicker, address, amount.toString());
        if (res?.error) {
            // Check
        } else {
            await recordPayment(address, amount, res?.revealHash);
        }
    });
}

async function checkFullFeeRebate(address: string, ticker: string) {    
    const amount = await krc20Token(address, ticker);
    if (amount >= fullRebateTokenThreshold) {
        return true;
    } 
    const nftCount = await nftAPI(address, ticker);
    if (nftCount >= fullRebateNFTThreshold) {
        return true;
    }
    return false;
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

export async function resetBalancesByWallet(address : string, balance: bigint) {
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