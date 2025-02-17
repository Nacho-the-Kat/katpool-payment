import axios, { AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import Monitoring from '../../monitoring';

const krc20TokenAPI = "https://api.kasplex.org/v1/krc20/address/{address}/token/{ticker}"
const NFTAPI = "https://mainnet.krc721.stream/api/v1/krc721/mainnet/address/{address}/{ticker}"

const monitoring = new Monitoring();

axiosRetry(axios, { 
    retries: 5,
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
 
export async function krc20Token(address: string, ticker = 'NACHO') {
    try {
        const url = krc20TokenAPI
        .replace("{address}", address)
        .replace("{ticker}", ticker);
    
        const response = await axios.get(url);
    
        if (response.message === 'successful') {
            return response.result[0].balance;
        } else {
            return 0;
        }
    } catch (error) {
        monitoring.error(`Fetching ${ticker} tokens for address: ${address}`);
    }  
}

export async function nftAPI(address: string, ticker = 'NACHO') {
    try {
        const url = NFTAPI
        .replace("{address}", address)
        .replace("{ticker}", ticker);
    
        const response = await axios.get(url);

        if (response.message === 'successful') {
            return response.result.length;
        } else {
            return 0;
        }
    
        return response.data;
    } catch (error) {
        monitoring.error(`Fetching block hash for transaction ${address}`);
    }  
}