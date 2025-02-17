import axios, { AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import Monitoring from '../../monitoring';
import config from "../../../config/config.json";

let krc20TokenAPI = "https://api.kasplex.org/v1/krc20/address/{address}/token/{ticker}"
if( config.network === "testnet-10" ) {
    krc20TokenAPI = "https://tn10api.kasplex.org/v1"
} else if( config.network === "testnet-11" ) {
    krc20TokenAPI = "https://tn11api.kasplex.org/v1"
}
   
let NFTAPI = "https://mainnet.krc721.stream/api/v1/krc721/mainnet/address/{address}/{ticker}"
if( config.network === "testnet-10" ) {
    NFTAPI = "https://testnet-10.krc721.stream/api/v1/krc721/testnet-10/address/{ticker}/{ticker}"
} else if( config.network === "testnet-11" ) {
    NFTAPI = "https://testnet-11.krc721.stream/api/v1/krc721/testnet-11/address/{ticker}/{ticker}"
}

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