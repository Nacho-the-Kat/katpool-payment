import axios, { AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import Monitoring from '../../monitoring';
import { CONFIG } from '../../constants';

export let KASPLEX_URL = 'https://api.kasplex.org';
if (CONFIG.network === 'testnet-10') {
  KASPLEX_URL = 'https://tn10api.kasplex.org';
}

let krc20TokenAPI = `${KASPLEX_URL}/v1/krc20/address/{address}/token/{ticker}`;

let KRC721_STREAM_URL = 'https://mainnet.krc721.stream';
if (CONFIG.network === 'testnet-10') {
  KRC721_STREAM_URL = 'https://testnet-10.krc721.stream';
}
let NFTAPI = `${KRC721_STREAM_URL}/api/v1/krc721/${CONFIG.network}/address/{address}/{ticker}`;

const monitoring = new Monitoring();

axiosRetry(axios, {
  retries: 5,
  retryDelay: retryCount => {
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
  },
});

export async function krc20Token(address: string, ticker = CONFIG.defaultTicker) {
  try {
    const url = krc20TokenAPI
      .replace('{address}', encodeURIComponent(address))
      .replace('{ticker}', ticker);

    const response = await axios.get(url);
    if (response.data.message.toLowerCase().includes('success')) {
      return { error: '', amount: response.data.result[0].balance };
    } else {
      // API responded but with an error message (controlled failure)
      const msg = `Fetching ${ticker} tokens failed for ${address}. API Response: ${JSON.stringify(response)}`;
      return { error: msg, amount: null }; // API failure, return null as safe fallback
    }
  } catch (error) {
    return { error, amount: -1 }; // Indicate network/system failure
  }
}

export async function nftAPI(address: string, ticker = CONFIG.defaultTicker) {
  try {
    const url = NFTAPI.replace('{address}', encodeURIComponent(address)).replace(
      '{ticker}',
      ticker
    );

    const response = await axios.get(url);

    if (response.data.message.toLowerCase().includes('success')) {
      return { error: '', count: response.data.result.length };
    } else {
      // API responded but with an error message (controlled failure)
      const msg = `API Response: ${JSON.stringify(response)}`;
      return { error: msg, count: null }; // API failure, return null as safe fallback
    }
  } catch (error) {
    return { error, count: -1 }; // Indicate network/system failure
  }
}
