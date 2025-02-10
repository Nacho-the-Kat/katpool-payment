import BigNumber from 'bignumber.js';
import { formatUnits, parseUnits } from 'ethers'
import { signMessage, createTransactions, RpcClient } from "../../wasm/kaspa";
import { DEBUG } from '../index.ts';
import trxManager from './index.ts';
import Monitoring from '../monitoring/index.ts';

const fromAmountToCalculateQuote = parseUnits("10", 8).toString(); ; // Below 10KAS or some value we don't get quote
const fromTicker = "KAS";
const toTicker = "NACHO";
const Chain = "KAS";

let customSlippage = "5"; // percentage format, ex: 5%
let toAmountSwap = "";
let toAmountMinSwap = "";

let fromAmountInKAS = fromAmountToCalculateQuote;
let fromAmount = parseUnits(fromAmountInKAS, 8).toString(); // The decimals for KRC20 tokens are all set to 8.
if (DEBUG) new Monitoring().log(`SwapToKrc20: fromAmount in SOMPI : ${fromAmount}`)
    
export default class swapToKrc20 {
    private transactionManager: trxManager;
    constructor(transactionManager: trxManager) {
        this.transactionManager = transactionManager;
    }
    
    fnGetQuote = async () => {
        const quoteParams = {
            fromTicker,
            toTicker,
            fromAmount: fromAmountToCalculateQuote
        }
        
        // quote 
        const response = await fetch(`https://api2.chainge.finance/fun/quote?fromTicker=${quoteParams.fromTicker}&toTicker=${quoteParams.toTicker}&fromAmount=${quoteParams.fromAmount}`)
        const quoteResult = await response.json()
        if (DEBUG) console.log("SwapToKrc20: fnGetQuote ~ quoteResult: ", quoteResult);
        if(quoteResult.code !== 0) return
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
        const miniAmount = (BigInt(fromAmount) * parseUnits(miniAmountHr, 8) / BigInt(fromAmountToCalculateQuote)).toString()
        
        toAmountSwap = (BigInt(fromAmount) * receiveAmount / BigInt(fromAmountToCalculateQuote)).toString()
        if (DEBUG) this.transactionManager.monitoring.debug(`SwapToKrc20: fnGetQuote ~ toAmountSwap: ${toAmountSwap}`)
            toAmountMinSwap = miniAmount;
        if (DEBUG) this.transactionManager.monitoring.debug(`SwapToKrc20: fnGetQuote ~ toAmountMinSwap: ${toAmountMinSwap}`)
        }
    
    fnSubmitSwap = async (tradeHash) => {
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
        if (DEBUG) console.log("Header: ", header);

        const response = await fetch('https://api2.chainge.finance/fun/submitSwap', {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...header
            },
            body: JSON.stringify(params)
        })
        const result = await response.json()
        console.log("Result : ", result);
    }

    fnGetMinterAddr = async () => {
        const response = await fetch('https://api2.chainge.finance/fun/getVault?ticker=KAS')
        const result = await response.json()
        return result.data.vault
    }

    async fnCore(fromAmountInKASLocal: string): Promise<void> {
        fromAmountInKAS = fromAmountInKASLocal;
        fromAmount = parseUnits(fromAmountInKAS, 8).toString(); // The decimals for KRC20 tokens are all set to 8.

        // step 1: quote 
        await this.fnGetQuote()
        
        // step 2: get minter address
        const minterAddr = await this.fnGetMinterAddr()

        // step 3: Send transaction 
        // You need to initiate a transaction to our minter through the wallet, and obtain the hash. This hash will be the transaction hash.
        let txHash = "";
        try {
            if (this == null) {
                return;
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
            return ;
        }

        // step 4: submitOrder
        this.transactionManager.monitoring.log(`SwapToKrc20: fnCore ~ txHash: ${txHash}`);
        await this.fnSubmitSwap(txHash)
    }
}