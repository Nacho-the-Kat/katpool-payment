import BigNumber from 'bignumber.js';
import { formatUnits, parseUnits } from 'ethers'
import axios, { AxiosError } from 'axios';
import { signMessage, createTransactions } from "../../../wasm/kaspa";
import { DEBUG } from '../../index.ts';
import trxManager from '../index.ts';
import Monitoring from '../../monitoring/index.ts';
import CONFIG from "../../../config/constants";
import { parseSignatureScript } from './utils.ts';
import { resetBalancesByWallet } from './transferKrc20Tokens.ts';
import { KASPLEX_URL, krc20Token } from './krc20Api.ts';

let KASPA_BASE_URL = 'https://api.kaspa.org';

if( CONFIG.network === "testnet-10" ) {
 KASPA_BASE_URL = "https://api-tn10.kaspa.org"
} else if( CONFIG.network === "testnet-11" ) {
 KASPA_BASE_URL = "https://api-tn11.kaspa.org"
}

const chaingeUrl = 'https://api2.chainge.finance';

const fromTicker = "KAS";
const toTicker = CONFIG.defaultTicker;
const Chain = "KAS";

let customSlippage = "5"; // percentage format, ex: 5%
let toAmountSwap = "";
let toAmountMinSwap = "";

let fromAmountInSompi = "";
let fromAmount = "";
new Monitoring().debug(`SwapToKrc20: fromAmount in SOMPI : ${fromAmount}`)
    
export default class swapToKrc20 {
    private transactionManager: trxManager;
    constructor(transactionManager: trxManager) {
        this.transactionManager = transactionManager;
    }
    
    fnGetQuote = async () => {
        const quoteParams = {
            fromTicker,
            toTicker,
            fromAmount
        }
        
        // quote 
        const response = await fetch(`${chaingeUrl}/fun/quote?fromTicker=${quoteParams.fromTicker}&toTicker=${quoteParams.toTicker}&fromAmount=${quoteParams.fromAmount}`)
        const quoteResult = await response.json()
        if (DEBUG) this.transactionManager.monitoring.log(`SwapToKrc20: fnGetQuote ~ quoteResult: ${JSON.stringify(quoteResult)}`);
        if(quoteResult.code !== 0) return {toAmountMinSwap: "0", toAmountSwap: "0"};
        let { amountOut, serviceFee, gasFee, slippage } = quoteResult.data
        // slippage: 5%
        slippage = slippage.replace('%', '') // '5'
        
        const receiveAmount = BigInt(amountOut) - BigInt(serviceFee) - BigInt(gasFee)
        if(receiveAmount <= BigInt(0)) {
            throw new Error("The current quote amount cannot cover the fees. Please enter a larger amount.");
        }

        // Calculate the value the user should receive. 
        const receiveAmountHr = formatUnits(receiveAmount, 8)
                
        // Computed minimum, After calculating the minimum value, we need to convert it to the decimals of the target chain.
        // The slippage here is in percentage format. 
        // The slippage returned by this interface is our recommended value, but you can set your own slippage.
        const tempSlippage = customSlippage || slippage
        const miniAmountHr = BigNumber(receiveAmountHr).multipliedBy(BigNumber((1 - (tempSlippage * 0.01)))).toFixed(8, BigNumber.ROUND_DOWN)
        const miniAmount = parseUnits(miniAmountHr, 8).toString()
    
        toAmountSwap = receiveAmount.toString()
        if (DEBUG) this.transactionManager.monitoring.debug(`SwapToKrc20: fnGetQuote ~ toAmountSwap: ${toAmountSwap}`)
        toAmountMinSwap = miniAmount;
        if (DEBUG) this.transactionManager.monitoring.debug(`SwapToKrc20: fnGetQuote ~ toAmountMinSwap: ${toAmountMinSwap}`)

        return {toAmountMinSwap, toAmountSwap};
    }
    
    fnSubmitSwap = async (tradeHash, toAmountMinSwap, toAmountSwap) => {
        const params = {
            fromTicker,
            fromAmount: fromAmount,
            toTicker,    
            toAmount: toAmountSwap,
            toAmountMin: toAmountMinSwap,
            certHash: tradeHash,
            channel: "knot",
        };
        
        let raw = `${params.channel}_${params.certHash}_${params.fromTicker}_${params.fromAmount}_${params.toTicker}_${params.toAmount}_${params.toAmountMin}`
        
        // Use the signMessage method of the kasWare wallet to sign a string.
        let signature = signMessage({
            privateKey: this.transactionManager.privateKey!,
            message: raw,
        })

        const PublicKey = this.transactionManager.privateKey.toPublicKey().toString();
        if (!PublicKey) {
            throw new Error('Can not derive public key from private key');
        }

        const header = {
            Address: this.transactionManager.address!,
            PublicKey,
            Chain,
            Signature: signature
        }
        if (DEBUG) this.transactionManager.monitoring.log(`Header: ${JSON.stringify(header)}`);

        const response = await fetch(`${chaingeUrl}/fun/submitSwap`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...header
            },
            body: JSON.stringify(params)
        })

        const result = await response?.json();
        this.transactionManager.monitoring.log(`Result : ${JSON.stringify(result)}`);
        return result
    }

    fnGetMinterAddr = async () => {
        const response = await fetch(`${chaingeUrl}/fun/getVault?ticker=KAS`)
        const result = await response.json()
        return result.data.vault
    }

    async swapKaspaToKRC(balance: bigint) {        
        fromAmountInSompi = balance.toString();
        fromAmountInSompi = ((BigInt(fromAmountInSompi) * BigInt(CONFIG.nachoSwap * 100)) / 10000n).toString();
        fromAmount = fromAmountInSompi

        // step 1: quote 
        const {toAmountMinSwap, toAmountSwap} = await this.fnGetQuote()
        
        // Return when we did not get quote.
        if (toAmountMinSwap === '0' || toAmountSwap === '0') return 0;
        
        // step 2: get minter address
        const minterAddr = await this.fnGetMinterAddr()

        // step 3: Send transaction 
        // You need to initiate a transaction to our minter through the wallet, and obtain the hash. This hash will be the transaction hash.
        let txHash = "";
        try {
            if (this == null) {
                return 0;
            }
            const { transactions } = await createTransactions({
                entries: this.transactionManager.context,
                outputs: [{address: minterAddr, amount: BigInt(fromAmount)}],
                changeAddress: this.transactionManager.address,
                priorityFee: 0n,
                networkId: this.transactionManager.networkId,
            });

            for (let i = 0; i < transactions.length; i++) {
                const transaction = transactions[i];
                if (DEBUG) this.transactionManager.monitoring.log(`SwapToKrc20: Signing transaction ID: ${transaction.id}`);
                transaction.sign([this.transactionManager.privateKey]);
                    
                if (DEBUG) this.transactionManager.monitoring.log(`SwapToKrc20: Submitting transaction ID: ${transaction.id}`);
                txHash = await transaction.submit(this.transactionManager.rpc);
            }        
        } catch (error) {
            this.transactionManager.monitoring.error(`Error signing transaction: ${error}`);
            return 0;
        }

        // step 4: submitOrder
        this.transactionManager.monitoring.log(`SwapToKrc20: fnCore ~ txHash: ${txHash}`);
        const balanceBefore = await krc20Token(this.transactionManager.address, toTicker);
        if (balanceBefore === -1) {
            this.transactionManager.monitoring.error("Network/system failure. Retry later.");
        } else if (balanceBefore === null) {
            this.transactionManager.monitoring.error("API failure. Could not retrieve token balance.");
        } else {
            this.transactionManager.monitoring.log(`Treasury wallet has ${balanceBefore} ${CONFIG.defaultTicker} tokens.`);
        }

        let balanceAfter = balanceBefore;
        let res = await this.fnSubmitSwap(txHash, toAmountMinSwap, toAmountSwap)

        if (res.msg === 'success') {
            
            // Start polling the status
            let finalStatus;
            let txId: string = '';
            let amount: number = 0;
            try {
                finalStatus = await this.pollStatus(res.data.id);
                this.transactionManager.monitoring.log(`Final Result: ${JSON.stringify(finalStatus)}`);
            } catch (error) {
                this.transactionManager.monitoring.error(`❌ Operation failed:", ${error}`);
            }
            if (finalStatus?.msg === 'success') {
                txId = finalStatus?.data?.hash!;
                balanceAfter = await krc20Token(this.transactionManager.address, toTicker);
                if (balanceAfter === -1) {
                    this.transactionManager.monitoring.error("Network/system failure. Retry later.");
                } else if (balanceAfter === null) {
                    this.transactionManager.monitoring.error("API failure. Could not retrieve token balance.");
                } else {
                    this.transactionManager.monitoring.log(`Treasury wallet has ${balanceAfter} ${CONFIG.defaultTicker} tokens.`);
                }            
            }
            if (txId != '' || BigInt(balanceAfter) - BigInt(balanceBefore) >= BigInt(toAmountMinSwap))
                amount = await this.fetchKRC20SwapData(txId!);

            await resetBalancesByWallet('pool', BigInt(fromAmount), this.transactionManager.db, 'balance', false);
            return amount;
        } else {
            return 0;
        }
    }

    async fetchKRC20SwapData(txId: string) {        
        const apiURL = `${KASPA_BASE_URL}/transactions/${txId}?inputs=true&outputs=false&resolve_previous_outpoints=no`

        const txs = await axios.get(apiURL).then((data) => data.data)
    
        const txInputs = txs.inputs
        const { signature_script: signatureScript } = txInputs[0]
    
        const jsonString = parseSignatureScript(signatureScript)
            .findLast((s) => s.indexOf('OP_PUSH') === 0)
            .split(' ')[1]
    
        const krc20Data = JSON.parse(jsonString)
        const tick = krc20Data.tick.toUpperCase()
    
        const decimal = await this.getDecimalFromTick(tick)
        const amount = Number(krc20Data.amt);
        this.transactionManager.monitoring.log(`swapToKrc20 ~ fetchKRC20SwapData ~ amount: ${amount}`);
        return amount;
    }

    // get decimals for KRC-20 Token
    getDecimalFromTick = async (tick) => {
        const tokenMetaData = await axios
            .get(`${KASPLEX_URL}/v1/krc20/token/${tick}`)
            .then((data) => data.data)
        const decimal = tokenMetaData.result[0].dec

        return decimal
    }

    async pollStatus(id: string, interval = 60000, maxAttempts = 30): Promise<any> {
        let attempts = 0;
    
        return new Promise((resolve, reject) => {
            const checkStatus = async () => {
                attempts++;
    
                try {
                    const response = await fetch(`${chaingeUrl}/fun/checkSwap?id=${id}`);

                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    
                    const data = await response.json();
                    this.transactionManager.monitoring.log(`Polling attempt ${attempts}: ${JSON.stringify(data)}`);
    
                    if (data!.data!.status!.toString() === "Succeeded") {
                        this.transactionManager.monitoring.log("✅ Operation completed successfully!");
                        resolve(data);
                        return;
                    }
    
                    if (attempts >= maxAttempts) {
                        this.transactionManager.monitoring.log("❌ Max polling attempts reached. Stopping...");
                        this.transactionManager.monitoring.log(`Stopping polling for id: ${id}`);
                        reject(new Error("Polling timed out"));
                        return;
                    }
    
                    setTimeout(checkStatus, interval);
                } catch (error) {
                    this.transactionManager.monitoring.error(`Error polling API:", ${error}`);
                    reject(error);
                }
            };
    
            checkStatus();
        });
    }
}