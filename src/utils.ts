import axios from 'axios';
import config from '../config/config.json';
import Monitoring from './monitoring';

let KASPA_BASE_URL = 'https://api.kaspa.org';

if( config.network === "testnet-10" ) {
 KASPA_BASE_URL = "https://api-tn10.kaspa.org"
} else if( config.network === "testnet-11" ) {
 KASPA_BASE_URL = "https://api-tn11.kaspa.org"
}

const monitoring = new Monitoring();

export async function fetchKASBalance(address: string) {
  try {
    const url = `${KASPA_BASE_URL}/addresses/${encodeURIComponent(address)}/balance`;
    const response = await axios.get(url);
    if (response.status == 200) {
      return response.data.balance;
    } else {
      return 0;
    }
  } catch (error) {
    monitoring.error(`utils: Fetching KAS balance for address: ${address} : ${error}`);
    return -1;
  }  
}

async function getDaaScoreFromBlockId(blockHash: string) {
  try {
    const url = `${KASPA_BASE_URL}/blocks/${blockHash}?includeColor=false`
    const response = await axios.get(url)
    if (response.status === 200) {
      const daaScore = response.data.header.daaScore
      return daaScore
    } else {
      return undefined
    }
  } catch (err) {
    monitoring.error(`utils: while getting daaScore from block: ${err}`);
    return undefined
  }
}

export async function getDaaScoreFromTx(tx: string) {
  try {
    const url = `${KASPA_BASE_URL}/transactions/${tx}?inputs=true&outputs=true&resolve_previous_outpoints=no`;
    const response = await axios.get(url)
    if (response.status === 200) {
      const blockHash = response.data.block_hash[0]
      const daaScore = await getDaaScoreFromBlockId(blockHash)
      return daaScore
    }
  } catch (err) {
    monitoring.error(`utils: while getting daaScore from tx: ${err}`);
    return undefined
  }
}

export async function getKaspaUSDPrice() {
  try {
    if (config.network.includes('mainnet')) {
      const url = `${KASPA_BASE_URL}/info/price?stringOnly=false`;
      const response = await axios.get(url);
      const usdPrice = BigInt(response.data.price)
      return usdPrice
    }
  } catch (err) {
    monitoring.error(`utils: While getting usd price of KASPA: ${err}`);
  }
}