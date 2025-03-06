import { RpcClient } from "../../../wasm/kaspa/kaspa";
import { transferKRC20 } from "./krc20Transfer";
import Database from '../../database';
import config from "../../../config/config.json";
import { krc20Token, nftAPI } from "./krc20Api";
import { parseUnits } from "ethers";
import trxManager from "..";
import Monitoring from "../../monitoring";

const fullRebateTokenThreshold = parseUnits("100", 14); // Minimum 100M (NACHO)
const fullRebateNFTThreshold = 1; // Minimum 1 NFT

const monitoring = new Monitoring();

// Currently used to transfer NACHO tokens.
export async function transferKRC20Tokens(pRPC: RpcClient, pTicker: string, krc20Amount: number, balances: any, poolBal: bigint, transactionManager: trxManager) {
    let payments: { [address: string]: bigint } = {};
    
    // Aggregate balances by wallet address
    for (const { address, nachoBalance } of balances) {
        if (nachoBalance > 0) {
            payments[address] = (payments[address] || 0n) + nachoBalance;
        }
    }

    const nachoThresholdAmount = BigInt(config.nachoThresholdAmount) || BigInt("100000000000");
        
    const NACHORebateBuffer = Number(config.nachoRebateBuffer);

    let poolBalance = poolBal;
    
    if (krc20Amount > NACHORebateBuffer) {
        krc20Amount = krc20Amount - NACHORebateBuffer;
    }
        
    for (let [address, amount] of Object.entries(payments)) {
        // Check if the user is eligible for full fee rebate
        const fullRebate = await checkFullFeeRebate(address, config.defaultTicker);
        let kasAmount = amount;
        if (fullRebate) {
            monitoring.debug(`transferKRC20Tokens: Full rebate to address: ${address}`);
            amount = amount * 3n;
        }
        
        // Chances are KRC20 amount is not rounded.
        krc20Amount = Math.floor(krc20Amount);

        // Set NACHO rebate amount in ratios.
        if (!krc20Amount || isNaN(Number(krc20Amount))) {
            throw new Error("Invalid krc20Amount value");
        }
        if (!poolBalance || isNaN(Number(poolBalance))) {
            throw new Error("Invalid poolBalance value");
        }
        
        const numerator = BigInt(amount) * BigInt(Math.floor(krc20Amount));
        const denominator = BigInt(poolBalance);
        
        // NACHO amount to be transferred
        let nachoAmount = 0n;
        if (numerator % denominator !== BigInt(0)) {
            nachoAmount = BigInt(Math.floor(Number(numerator) / Number(denominator))); // Use safe rounding
        } else {
            nachoAmount = numerator / denominator;
        }
        
        // Filter payments that meet the threshold
        if (nachoAmount < nachoThresholdAmount) {
            monitoring.debug(`transferKRC20Tokens: Skipping ${address}: nachoAmount (${nachoAmount}) is below threshold (${nachoThresholdAmount})`);
            continue;
        }

        try {            
            monitoring.debug(`transferKRC20Tokens: Transfering ${nachoAmount.toString()} ${pTicker} to ${address}`);
            let res = await transferKRC20(pRPC, pTicker, address, nachoAmount.toString(), transactionManager!);
            if (res?.error != null) {
                monitoring.error(`transferKRC20Tokens: Error from KRC20 transfer : ${res?.error!}`);
            } else {
                await recordPayment(address, nachoAmount, res?.revealHash, transactionManager?.db!, kasAmount, fullRebate);
            }
        } catch(error) {
            monitoring.error(`transferKRC20Tokens: Transfering ${nachoAmount.toString()} ${pTicker} to ${address} : ${error}`);
        }

        // ⏳ Add a small delay before sending the next transaction
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3s delay
    }
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

async function recordPayment(address: string, amount: bigint, transactionHash: string, db: Database, kasAmount: bigint, fullRebate: boolean) {
    const client = await db.getClient();

    let values: string[] = [];
    let queryParams: string[][] = []
    values.push(`($${1}, ${amount}, NOW(), '${transactionHash}') `);
    const valuesPlaceHolder = values.join(',');
    const query = `INSERT INTO nacho_payments (wallet_address, nacho_amount, timestamp, transaction_hash) VALUES ${valuesPlaceHolder};`;
    queryParams.push([address]);
    try {
      await client.query(query, queryParams);
      await resetBalancesByWallet(address, kasAmount, db, 'nacho_rebate_kas', fullRebate);
    } finally {
      client.release();
    }
}

export async function resetBalancesByWallet(address : string, balance: bigint, db: Database, column: string, fullRebate: boolean) {
    const client = await db.getClient();
    try {
        // Update miners_balance table
        const res = await client.query(`SELECT ${column} FROM miners_balance WHERE wallet = $1`, [[address]]);
        let minerBalance = res.rows[0] ? BigInt(res.rows[0].balance) : 0n;
        minerBalance -= balance;
        
        if (minerBalance < 0n) {
            const logMinerBalance = res.rows[0] ? BigInt(res.rows[0].balance) : 0n;
            monitoring.error(`transferKRC20Tokens: Address: ${address}, Column: ${column}, Original Balance: ${logMinerBalance}, new Deduction: ${balance}, NewBalance=${minerBalance}`);            
            minerBalance = 0n;
            if (!fullRebate) {
                monitoring.error(`transferKRC20Tokens: Negative value for minerBalance: ${address}`);
            }
        }

        await client.query(`UPDATE miners_balance SET ${column} = $1 WHERE wallet = ANY($2)`, [minerBalance, [address]]);
    } catch (error) {
        monitoring.error(`transferKRC20Tokens: Error updating miner balance for ${address} - ${error}`);
    } finally {
        client.release();
    }
}