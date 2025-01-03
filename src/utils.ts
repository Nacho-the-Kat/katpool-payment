import axios from 'axios';
import config from '../config/config.json';

const baseUrl = config.network.includes('testnet') ? 'https://api-tn10.kaspa.org' : 'https://api.kaspa.org';

async function getDaaScoreFromBlockId(blockHash: string) {
  try {
    const url = `${baseUrl}/blocks/${blockHash}?includeColor=false`
    const response = await axios.get(url)
    if (response.status === 200) {
      const daaScore = response.data.header.daaScore
      return daaScore
    } else {
      return undefined
    }
  } catch (err) {
    console.error('Error while getting daaScore from block:', err)
    return undefined
  }
}

export async function getDaaScoreFromTx(tx: string) {
  try {
    const url = `${baseUrl}/transactions/${tx}?inputs=true&outputs=true&resolve_previous_outpoints=no`;
    const response = await axios.get(url)
    if (response.status === 200) {
      const blockHash = response.data.block_hash[0]
      const daaScore = await getDaaScoreFromBlockId(blockHash)
      return daaScore
    }
  } catch (err) {
    console.error('Error while getting daaScore from tx:', err)
    return undefined
  }
}

export async function getKaspaUSDPrice() {
  try {
    if (config.network.includes('mainnet')) {
      const url = `${baseUrl}/info/price?stringOnly=false`;
      const response = await axios.get(url);
      const usdPrice = BigInt(response.data.price)
      return usdPrice
    }
  } catch (err) {
    console.error('Error while getting usd price of kaspa:', err)
  }
}