import axios from 'axios';
import { CONFIG, KASPA_BASE_URL } from './constants';
import Monitoring from './monitoring';
import { kaspaToSompi } from '../wasm/kaspa/kaspa';

const monitoring = new Monitoring();

// Also to be used for NACHO as it also has 8 decimals
export function sompiToKAS(amount: number) {
  return Number((amount / Number(kaspaToSompi('1')!)).toFixed(2));
}

export async function fetchKASBalance(address: string) {
  try {
    const url = `${KASPA_BASE_URL}/addresses/${encodeURIComponent(address)}/balance`;
    const response = await axios.get(url);
    if (response.status == 200) {
      return response.data.balance;
    } else {
      return null; // To avoid confusion with actual 0 balance.
    }
  } catch (error) {
    monitoring.error(`utils: Fetching KAS balance for address: ${address} : `, error);
    return -1;
  }
}

async function getDaaScoreFromBlockId(blockHash: string) {
  try {
    const url = `${KASPA_BASE_URL}/blocks/${blockHash}?includeColor=false`;
    const response = await axios.get(url);
    if (response.status === 200) {
      const daaScore = response.data.header.daaScore;
      return daaScore;
    } else {
      return undefined;
    }
  } catch (error) {
    monitoring.error(`utils: while getting daaScore from block: `, error);
    return undefined;
  }
}

export async function getDaaScoreFromTx(tx: string) {
  try {
    const url = `${KASPA_BASE_URL}/transactions/${tx}?inputs=true&outputs=true&resolve_previous_outpoints=no`;
    const response = await axios.get(url);
    if (response.status === 200) {
      const blockHash = response.data.block_hash[0];
      const daaScore = await getDaaScoreFromBlockId(blockHash);
      return daaScore;
    }
  } catch (error) {
    monitoring.error(`utils: while getting daaScore from tx: `, error);
    return undefined;
  }
}

export async function getKaspaUSDPrice() {
  try {
    if (CONFIG.network.includes('mainnet')) {
      const url = `${KASPA_BASE_URL}/info/price?stringOnly=false`;
      const response = await axios.get(url);
      const usdPrice = BigInt(response.data.price);
      return usdPrice;
    }
  } catch (error) {
    monitoring.error(`utils: While getting usd price of KASPA: `, error);
  }
}

export async function fetchAccountTransactionCount(address: string) {
  const url = `${KASPA_BASE_URL}/addresses/${encodeURIComponent(address)}/transactions-count`;
  try {
    const response = await axios.get(url);
    const count = response.data.total;
    return count;
  } catch (error) {
    monitoring.error(`utils: While getting transaction count of ${address} : `, error);
    return 0;
  }
}
