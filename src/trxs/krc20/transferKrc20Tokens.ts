import { RpcClient } from "../../../wasm/kaspa/kaspa";
import { transferKRC20 } from "./krc20Transfer";
import Database, { pendingKRC20TransferField, status } from '../../database';
import { CONFIG } from "../../constants";
import { krc20Token, nftAPI } from "./krc20Api";
import { parseUnits } from "ethers";
import trxManager from "..";
import Monitoring from "../../monitoring";

const fullRebateTokenThreshold = parseUnits("100", 14); // Minimum 100M (NACHO)
const fullRebateNFTThreshold = 1; // Minimum 1 NFT

const monitoring = new Monitoring();

// Currently used to transfer NACHO tokens.
export async function transferKRC20Tokens(pRPC: RpcClient, pTicker: string, krc20Amount: bigint, balances: any, poolBal: bigint, transactionManager: trxManager) {
    let payments: { [address: string]: bigint } = {};
    
    // Aggregate balances by wallet address
    for (const { address, nachoBalance } of balances) {
        if (nachoBalance > 0) {
            payments[address] = (payments[address] || 0n) + nachoBalance;
        }
    }

    const nachoThresholdAmount = BigInt(CONFIG.nachoThresholdAmount);
        
    const NACHORebateBuffer = BigInt(CONFIG.nachoRebateBuffer);

    let poolBalance = poolBal;
    
    if (krc20Amount > NACHORebateBuffer) {
        krc20Amount = krc20Amount - NACHORebateBuffer;
    }
      
    let eligibleNACHOTransfer = 0;
    // amount is the actual value paid accounting the full rebate status.
    for (let [address, amount] of Object.entries(payments)) {
        // Check if the user is eligible for full fee rebate
        const fullRebate = await checkFullFeeRebate(address, CONFIG.defaultTicker);
        let kasAmount = amount;
        if (fullRebate) {
            monitoring.debug(`transferKRC20Tokens: Full rebate to address: ${address}`);
            amount = amount * 3n;
        }
        
        // Set NACHO rebate amount in ratios.
        if (!krc20Amount || isNaN(Number(krc20Amount))) {
            throw new Error("transferKRC20Tokens: Invalid krc20Amount value");
        }
        if (!poolBalance || isNaN(Number(poolBalance))) {
            throw new Error("transferKRC20Tokens: Invalid poolBalance value");
        }
        
        const numerator = BigInt(amount) * krc20Amount;
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
            eligibleNACHOTransfer++;
            monitoring.debug(`transferKRC20Tokens: Transfering ${nachoAmount.toString()} ${pTicker} to ${address}`);
            monitoring.debug(`transferKRC20Tokens: Transfering NACHO equivalent to ${amount} KAS in current cycle to ${address}.`);
            await transferKRC20(pRPC, pTicker, address, nachoAmount.toString(), kasAmount, transactionManager!, fullRebate);
        } catch(error) {
            monitoring.error(`transferKRC20Tokens: Transfering ${nachoAmount.toString()} ${pTicker} to ${address} : ${error}`);
        }

        // ⏳ Add a small delay before sending the next transaction
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3s delay
    }

    monitoring.debug(`transferKRC20Tokens: Total eligible NACHO transfers: ${eligibleNACHOTransfer}`);    
}

async function checkFullFeeRebate(address: string, ticker: string) {    
    const res = await krc20Token(address, ticker);
    const amount = res.amount;
    if (res.error != '') {
        monitoring.error(`transferKRC20Tokens: Error fetching ${ticker} balance for address - ${address} : ${res.error}`);
    } 
    
    if (amount != null && BigInt(amount) >= fullRebateTokenThreshold) {
        return true;
    } 
    const result = await nftAPI(address, ticker);
    const nftCount = result.count;
    if (result.error != '') {
        monitoring.error(`transferKRC20Tokens: Error fetching ${ticker} NFT holdings for address - ${address} : ${result.error}`);
    } 

    if (nftCount != null && BigInt(nftCount) >= fullRebateNFTThreshold) {
        return true;
    }
    return false;
}

export async function recordPayment(address: string, amount: bigint, transactionHash: string, p2shAddr: string, db: Database) {
    const client = await db.getClient();

    let values: string[] = [];
    let queryParams: string[][] = []
    values.push(`($${1}, ${amount}, NOW(), '${transactionHash}') `);
    const valuesPlaceHolder = values.join(',');
    const query = `INSERT INTO nacho_payments (wallet_address, nacho_amount, timestamp, transaction_hash) VALUES ${valuesPlaceHolder};`;
    queryParams.push([address]);
    try {
      await client.query('BEGIN'); // Start transaction

      monitoring.log(`transferKRC20Tokens: Recording NACHO payment for - address: ${address} of ${amount} NACHO (with decimals) with hash: ${transactionHash} for P2SH address: ${p2shAddr}`);
      await client.query(query, queryParams);

      if (!p2shAddr || p2shAddr != '') {
        monitoring.log(`transferKRC20Tokens: Updating pending krc20 table for - address: ${address} of ${amount} NACHO (with decimals) with hash: ${transactionHash} for P2SH address: ${p2shAddr}`);
        await db.updatePendingKRC20TransferStatus(p2shAddr, pendingKRC20TransferField.dbEntryStatus, status.COMPLETED);
      }

      await client.query("COMMIT"); // Commit everything together
    } catch (error) {
      await client.query("ROLLBACK"); // Rollback everything if any step fails
      monitoring.error(`transferKRC20Tokens: DB Rollback performed due to error: ${error}`);
    } finally {
      client.release();
    }
}

export async function resetBalancesByWallet(db: Database, address : string, balance: bigint, column: string, fullRebate: boolean) {
    try {        
        this.monitoring.log(`TrxManager: Reset ${column} for wallet ${address}`);
        const client = await db.getClient(); 
        // Fetch balance and entry count
        const res = await client.query(`SELECT SUM(${column}) as balance, COUNT(*) AS entry_count FROM miners_balance WHERE wallet = $1 GROUP BY wallet`, [address]);
        
        if (res.rows.length === 0) {
            monitoring.error(`transferKRC20Tokens: resetBalancesByWallet - No record found for Address: ${address}, Column: ${column}. Skipping update.`);
            return; // Exit early
        }

        let minerBalance = BigInt(res.rows[0].balance);
        const count = BigInt(res.rows[0].entry_count);

        monitoring.debug(`transferKRC20Tokens: Address: ${address}, Column: ${column}, Initial Balance: ${minerBalance}, Entries: ${count}`);

        minerBalance -= balance;
        
        if (minerBalance < 0n) {
            monitoring.error(`transferKRC20Tokens: Address: ${address}, Column: ${column}, Original Balance: ${res.rows[0].balance}, Deduction: ${balance}, New Balance: 0`);
            minerBalance = 0n;
            if (!fullRebate) {
                monitoring.error(`transferKRC20Tokens: Negative balance detected for ${address}`);
            }
        }

        const newBalance = count > 0 ? minerBalance / count : 0n; // ✅ Prevent division by zero 

        // Update balance for all matching entries
        await client.query(`UPDATE miners_balance SET ${column} = $1 WHERE wallet = $2`, [newBalance, address]);

    } catch (error) {
        monitoring.error(`transferKRC20Tokens: Error updating miner balance for ${address} - ${error}`);
    } 
}