import axios from 'axios';
import { CONFIG, KASPA_BASE_URL } from './constants';
import Monitoring from './monitoring';
import { kaspaToSompi } from '../wasm/kaspa/kaspa';
import crypto from 'crypto';

const monitoring = new Monitoring();

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY!;
const IV_LENGTH = 16; // Configured from katpool-app

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
    monitoring.error(`utils: Fetching KAS balance for address: ${address} : ${error}`);
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
  } catch (err) {
    monitoring.error(`utils: while getting daaScore from block: ${err}`);
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
  } catch (err) {
    monitoring.error(`utils: while getting daaScore from tx: ${err}`);
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
  } catch (err) {
    monitoring.error(`utils: While getting usd price of KASPA: ${err}`);
  }
}

export async function fetchAccountTransactionCount(address: string) {
  const url = `${KASPA_BASE_URL}/addresses/${encodeURIComponent(address)}/transactions-count`;
  try {
    const response = await axios.get(url);
    const count = response.data.total;
    return count;
  } catch (err) {
    monitoring.error(`utils: While getting transaction count of ${address} : ${err}`);
    return 0;
  }
}

export async function withWatchdog(task: () => Promise<any>, timeoutMs: number) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: Task took more than ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([task(), timeoutPromise]);
}

export function decryptToken(encryptedToken: string): string {
  const [ivHex, encrypted] = encryptedToken.split(':');
  const iv = new Uint8Array(Buffer.from(ivHex, 'hex'));
  const key = new Uint8Array(Buffer.from(ENCRYPTION_KEY, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
