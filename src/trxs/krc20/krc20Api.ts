import axios, { AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import Monitoring from '../../monitoring';
import config from "../../../config/config.json";

export let KASPLEX_URL = 'https://api.kasplex.org'
if( config.network === "testnet-10" ) {
    KASPLEX_URL = "https://tn10api.kasplex.org"
} else if( config.network === "testnet-11" ) {
    KASPLEX_URL = "https://tn11api.kasplex.org"
}

let krc20TokenAPI = `${KASPLEX_URL}/v1/krc20/address/{address}/token/{ticker}`;

let KRC721_STREAM_URL = 'https://mainnet.krc721.stream'
if( config.network === "testnet-10" ) {
    KRC721_STREAM_URL = "https://testnet-10.krc721.stream"
} else if( config.network === "testnet-11" ) {
    KRC721_STREAM_URL = "https://testnet-11.krc721.stream"
}
let NFTAPI = `${KRC721_STREAM_URL}/api/v1/krc721/${config.network}}/address/{address}/{ticker`;

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
 
export async function krc20Token(address: string, ticker = config.defaultTicker) {
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

export async function nftAPI(address: string, ticker = config.defaultTicker) {
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
        monitoring.error(`Fetching NFT holding for address: ${address}`);
    }  
}