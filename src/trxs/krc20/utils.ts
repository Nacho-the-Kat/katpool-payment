import { kaspaToSompi } from '../../../wasm/kaspa/kaspa';
import Monitoring from '../../monitoring';
import { fetchAccountTransactionCount, fetchKASBalance, sompiToKAS } from '../../utils';
import { krc20Token, nftAPI } from './krc20Api';
import { parseUnits } from 'ethers';

// Full rebate constants
const fullRebateTokenThreshold = parseUnits('100', 14); // Minimum 100M (NACHO)
const fullRebateNFTThreshold = 1; // Minimum 1 NFT

// UTXO selection thresholds in sompi (1 KAS = 100_000_000 sompi)
export const PREFERRED_MIN_UTXO = BigInt(kaspaToSompi('3')!); // 3 KAS
const ABSOLUTE_MIN_UTXO = BigInt(kaspaToSompi('1')!); // 1 KAS

const monitoring = new Monitoring();

export const parseSignatureScript = (hex): any => {
  /* Decodes KRC-20 operations */
  /* Example tx deploy: 105424172e946f85daf87f50422e4a5a7f73d541a7a0eaf666cf40567a80ba5d */
  /* Example tx mint: e2792d606f7cae9994cbc233a2cdb9c4d4541ad195852ae8ecfd787254613ded */
  /* Example tx transfer: 657a7a3dbe5c6af4e49eba4c0cf82753f01d5e721f458d356f62bebd0afd54c8 */
  if (!hex) {
    return;
  }
  return parseSignature(hexToBytes(hex));
};

function parseSignature(bytes): any {
  let result: any = [];
  let offset = 0;
  while (offset < bytes.length) {
    const opcode = bytes[offset];
    offset += 1;
    if (opcode >= 0x01 && opcode <= 0x4b) {
      const dataLength = opcode;
      const data = bytes.slice(offset, offset + dataLength);
      if (isHumanReadable(data)) {
        result.push(`OP_PUSH ${bytesToString(data)}`);
      } else {
        result.push(`OP_PUSH ${bytesToHex(data)}`);
      }
      offset += dataLength;
    } else if (opcode === 0x4c) {
      const dataLength = bytes[offset];
      offset += 1;
      const data = bytes.slice(offset, offset + dataLength);
      if (isHumanReadable(data)) {
        result.push(`OP_PUSHDATA1 ${bytesToString(data)}`);
      } else {
        result = result.concat(parseSignature(data));
      }
      offset += dataLength;
    } else if (opcode === 0x00) {
      result.push('OP_0');
    } else if (opcode === 0x51) {
      result.push('OP_1');
    } else if (opcode === 0x63) {
      result.push('OP_IF');
    } else if (opcode === 0x68) {
      result.push('OP_ENDIF');
    } else if (opcode === 0xac) {
      result.push('OP_CHECKSIG');
    } else {
      result.push(`OP_UNKNOWN ${bytesToHex(opcode)}`);
    }
  }
  return result;
}

const hexToBytes = hex => {
  const bytes: any = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return new Uint8Array(bytes);
};

function isHumanReadable(bytes) {
  return bytes.every(byte => byte >= 0x20 && byte <= 0x7e);
}

const bytesToHex = bytes => {
  return Array.from(bytes)
    .map((b: any) => b.toString(16).padStart(2, '0'))
    .join('');
};

const bytesToString = bytes => {
  return new TextDecoder().decode(bytes);
};

// Helper function to find suitable UTXO
export function findSuitableUtxo(entries: any[]): any {
  if (!entries.length) return null;

  // First try to find a UTXO ≥ 3 KAS
  let utxo = entries.find(entry => BigInt(entry.entry.amount) >= PREFERRED_MIN_UTXO);

  // If not found, try to find a UTXO ≥ 1 KAS
  if (!utxo) {
    utxo = entries.find(entry => BigInt(entry.entry.amount) >= ABSOLUTE_MIN_UTXO);
  }

  return utxo;
}

export async function pollStatus(
  P2SHAddress: string,
  utxoAmount: bigint,
  control: { stopPolling: boolean },
  checkReveal: boolean,
  interval = 60000,
  maxAttempts = 30
): Promise<boolean> {
  let attempts = 0;

  return new Promise((resolve, reject) => {
    const checkStatus = async () => {
      if (control.stopPolling) {
        monitoring.log(`KRC20Transfer: ⏹ Polling stopped manually.`);
        resolve(false);
        return;
      }

      attempts++;

      try {
        const p2shKASBalance = BigInt(await fetchKASBalance(P2SHAddress));
        monitoring.log(`KRC20Transfer: Polling attempt ${attempts}: ${p2shKASBalance} sompi`);

        if (
          checkReveal &&
          p2shKASBalance === 0n &&
          (await fetchAccountTransactionCount(P2SHAddress)) % 2 == 0
        ) {
          monitoring.log('KRC20Transfer: ✅ Reveal operation completed successfully!');
          control.stopPolling = true;
          resolve(true); // ✅ Resolve with `true`
          return;
        }

        if (!checkReveal && (p2shKASBalance > 0 || p2shKASBalance >= utxoAmount)) {
          monitoring.log('KRC20Transfer: ✅ Submit operation completed successfully!');
          control.stopPolling = true;
          resolve(true); // ✅ Resolve with `true`
          return;
        }

        if (attempts >= maxAttempts) {
          monitoring.log(`KRC20Transfer: ❌ Max polling attempts reached. Stopping...`);
          monitoring.log(`KRC20Transfer: Stopping polling for id: ${P2SHAddress}`);
          resolve(false); // ✅ Resolve with `false` instead of rejecting
          return;
        }

        setTimeout(checkStatus, interval);
      } catch (error) {
        monitoring.error(`KRC20Transfer: Error polling API: `, error);
        reject(error);
      }
    };

    checkStatus();
  });
}

export async function checkFullFeeRebate(address: string, ticker: string) {
  const res = await krc20Token(address, ticker);
  const amount = res.amount;
  if (res.error != '') {
    monitoring.error(
      `transferKRC20Tokens: Error fetching ${ticker} balance for address - ${address} : `,
      res.error
    );
  }

  if (amount != null && BigInt(amount) >= fullRebateTokenThreshold) {
    monitoring.debug(
      `utils: checkFullFeeRebate: NACHO balance for address: ${address} - ${sompiToKAS(amount)} NACHO`
    );
    return { NACHO: sompiToKAS(amount) };
  }
  const result = await nftAPI(address);
  const nftCount = result.count;
  if (result.error != '') {
    monitoring.error(
      `transferKRC20Tokens: Error fetching ${ticker} NFT holdings for address - ${address} : `,
      result.error
    );
  }

  if (nftCount != null && BigInt(nftCount) >= fullRebateNFTThreshold) {
    return result.nft;
  }
  return false;
}
