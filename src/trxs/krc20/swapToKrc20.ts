import Monitoring from '../../monitoring/index.ts';
import axios from 'axios';
import axiosRetry from 'axios-retry';

const quoteURL = 'https://api.kaspa.com/api/floor-price?ticker=NACHO';

const monitoring = new Monitoring();

axiosRetry(axios, { 
    retries: 3,
    retryDelay: (retryCount) => {
     return retryCount * 1000;
    },
    retryCondition(error) {
     // Ensure error.response exists before accessing status
     if (!error.response) {
       new Monitoring().error(`No response received: ${error.message}`);
       return false; // Do not retry if no response (e.g., network failure)
     }
 
     const retryableStatusCodes = [404, 422, 429, 500, 501];
     return retryableStatusCodes.includes(error.response.status);
    }
});
 
export default class swapToKrc20 {
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
        const response = await axios.get(quoteURL);
        
        const floorPrice = Number(response.data[0]?.floor_price);
        monitoring.log(`swapKaspaToKRC: floor price ${floorPrice}`);
        
        return BigInt(Math.floor(Number(balance) / floorPrice));
    }
}