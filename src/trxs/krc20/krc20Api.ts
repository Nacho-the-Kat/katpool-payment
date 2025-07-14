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
let NFTAPI = `${KRC721_STREAM_URL}/api/v1/krc721/${CONFIG.network}/address/{address}?offset={offset}`;

const monitoring = new Monitoring();

axiosRetry(axios, {
  retries: 5,
  retryDelay: retryCount => {
    return retryCount * 1000;
  },
  retryCondition(error) {
    // Ensure error.response exists before accessing status
    if (!error.response) {
      monitoring.error(`krc20Api: No response received: ${error.message}`);
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

export async function nftAPI(address: string) {
  try {
    let offset = 0;

    while (true) {
      let url = NFTAPI.replace('{address}', encodeURIComponent(address)).replace(
        '{offset}',
        offset.toString()
      );
      if (offset == 0) {
        url = NFTAPI.replace('{address}', encodeURIComponent(address)).replace(
          '?offset={offset}',
          ''
        );
      }
      monitoring.log(`krc20API: nftAPI - Fetching NFTs for address: ${address} with url: ${url}`);
      const response = await axios.get(url);

      if (!response.data.result?.length) break;

      for (const item of response.data.result) {
        if (item.tick && CONFIG.nftAllowedTicks.includes(item.tick.toUpperCase())) {
          // Allow only KATCLAIM Level 3 NFTs with token IDs in the range 736–843 (inclusive)
          if (
            item.tick.toUpperCase() === 'KATCLAIM' &&
            (item.tokenId < 736 || item.tokenId > 843)
          ) {
            continue; // Skip non-Level 3 KATCLAIM NFTs
          }

          monitoring.debug(`krc20API: nftAPI - Found allowed tick: ${JSON.stringify(item)}`);
          return { error: '', count: 1 };
        }
      }

      if (response.data.result.next) {
        offset += response.data.result.next;
      } else {
        break; // No more results to fetch
      }
    }

    return { error: '', count: null };
  } catch (error) {
    return { error, count: -1 }; // Indicate network/system failure
  }
}
