import { RpcClient } from "../../../wasm/kaspa/kaspa";
import { transferKRC20 } from "./krc20Transfer";
import Database from '../../database';
import config from "../../../config/config.json";
import { krc20Token, nftAPI } from "./krc20Api";
import { parseUnits } from "ethers";
import trxManager from "..";

const fullRebateTokenThreshold = parseUnits("100", 14); // Minimum 100M (NACHO)
const fullRebateNFTThreshold = 1; // Minimum 1 NFT

export async function transferKRC20Tokens(pRPC: RpcClient, pTicker: string, krc20Amount: number, balances: any, poolBal: bigint, transactionManager: trxManager) {
    let payments: { [address: string]: bigint } = {};
    
    // Aggregate balances by wallet address
    for (const { address, nachoBalance } of balances) {
        if (nachoBalance > 0) {
            payments[address] = (payments[address] || 0n) + nachoBalance;
        }
    }

    const NACHORebateBuffer = Number(config.nachoRebateBuffer);

    let poolBalance = poolBal;
    
    if (krc20Amount > NACHORebateBuffer) {
        krc20Amount = krc20Amount - NACHORebateBuffer;
    }
        
    Object.entries(payments).map(async ([address, amount]) => {
        // Check if the user is eligible for full fee rebate
        const fullRebate = await checkFullFeeRebate(address, "NACHO");
        let kasAmount = amount;
        if (fullRebate) {
            amount = amount * 3n;
            kasAmount = amount;
        }
        
        // Set NACHO rebate amount in ratios.
        amount = (amount * BigInt(krc20Amount)) / poolBalance;
        
        let res = await transferKRC20(pRPC, pTicker, address, amount.toString(), transactionManager!);
        if (res?.error != null) {
            // Check
        } else {
            await recordPayment(address, amount, res?.revealHash, transactionManager?.db!, kasAmount);
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

async function recordPayment(address: string, amount: bigint, transactionHash: string, db: Database, kasAmount: bigint) {
    const client = await db.getClient();

    let values: string[] = [];
    let queryParams: string[][] = []
    values.push(`($${1}, ${amount}, NOW(), '${transactionHash}') `);
    const valuesPlaceHolder = values.join(',');
    const query = `INSERT INTO nacho_payments (wallet_address, nacho_amount, timestamp, transaction_hash) VALUES ${valuesPlaceHolder};`;
    queryParams.push([address]);
    try {
      await client.query(query, queryParams);
      await resetBalancesByWallet(address, kasAmount, db, 'nacho_rebate_kas');
    } finally {
      client.release();
    }
}

export async function resetBalancesByWallet(address : string, balance: bigint, db: Database, column: string) {
    const client = await db.getClient();
    try {
        // Update miners_balance table
        const res = await client.query(`SELECT ${column} FROM miners_balance WHERE wallet = $1`, [[address]]);
        let minerBalance = res.rows[0] ? BigInt(res.rows[0].balance) : 0n;
        minerBalance -= balance;

        await client.query(`UPDATE miners_balance SET ${column} = $1 WHERE wallet = ANY($2)`, [minerBalance, [address]]);
    } finally {
        client.release();
    }
}