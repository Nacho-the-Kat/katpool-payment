import BigNumber from 'bignumber.js';
import { formatUnits, parseUnits } from 'ethers'
import { DEBUG } from '../../index.ts';
import trxManager from '../index.ts';
import Monitoring from '../../monitoring/index.ts';
import config from "../../../config/config.json";
import { resetBalancesByWallet } from './transferKrc20Tokens.ts';

const chaingeUrl = 'https://api2.chainge.finance';

const fromTicker = "KAS";
const toTicker = config.defaultTicker;

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

    /**
     * Calculates the equivalent amount of NACHO that can be obtained for a given KAS balance based on market rates.  
     * This determines the amount of NACHO to be distributed in the current payment cycle.  
     *  
     * - If a market swap for the given KAS balance can be performed, the corresponding NACHO amount is used for distribution.  
     * - If a swap cannot be executed at current market conditions, NACHO distribution is omitted for this cycle.  
     *  
     * @param balance - The amount of KAS (in bigint) to be swapped for NACHO.  
     * @returns The equivalent amount of NACHO if a swap is possible; otherwise, an indication that no swap occurred.  
     */ 
    async swapKaspaToKRC(balance: bigint) {        
        fromAmountInSompi = balance.toString();
        fromAmount = fromAmountInSompi

        // step 1: quote 
        const {toAmountMinSwap, toAmountSwap} = await this.fnGetQuote()

        // if (toAmountSwap != "0") {
        //     await resetBalancesByWallet(this.transactionManager.address, BigInt(fromAmount), this.transactionManager.db, 'balance', false);
        // }

        return BigInt(toAmountSwap);
    }
}