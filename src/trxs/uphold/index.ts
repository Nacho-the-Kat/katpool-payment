import trxManager from '..';
import { db, DEBUG } from '../..';
import { createTransactions } from '../../../wasm/kaspa/kaspa';
import { CONFIG } from '../../constants';
import { MinerBalanceRow } from '../../database';
import Monitoring from '../../monitoring';
import { getUpholdAccessToken } from '../../uphold/client-credentials-flow';
import { decryptToken } from '../../utils';
import { resetBalancesByWallet } from '../krc20/transferKrc20Tokens';

type UpholdBalance = {
  total: string;
  available: string;
};

type UpholdAccount = {
  id: string;
  asset: string;
  balance: UpholdBalance;
};

export let UPHOLD_BASE_URL = 'https://api.enterprise.uphold.com/core';
if (CONFIG.network === 'testnet-10') {
  UPHOLD_BASE_URL = 'https://api.enterprise.sandbox.uphold.com/core';
}

const monitoring = new Monitoring();

const balanceColumnMinersBalance = 'balance';

// Currently used to perform Uphold payout.
export async function upholdPayout(balances: MinerBalanceRow[], transactionManager: trxManager) {
  let payments: { [address: string]: bigint } = {};

  let upholdDepositAmount = 0n;
  // Aggregate balances by wallet address
  for (const { address, upholdBalance } of balances) {
    upholdDepositAmount += upholdBalance;
    if (!address) {
      monitoring.error(`uphold: upholdPayout: Invalid address found: ${address}`);
      continue;
    }
    if (upholdBalance > 0) {
      payments[address] = (payments[address] || 0n) + upholdBalance;
    }
  }

  const tokenRes = await getUpholdAccessToken();
  const data = tokenRes.json();
  const poolAccessToken = data.access_token;

  try {
    let accountRes = await fetchDataForAsset('KAS', poolAccessToken);
    const treasuryUpholdAddr = accountRes.accountId;
    await depositKASToUphold(treasuryUpholdAddr, upholdDepositAmount, transactionManager!);
    accountRes = await fetchDataForAsset('KAS', poolAccessToken); // Fetch balance after deposit.
    const upholdBalanceStr = accountRes.balance;
    const upholdBalance = BigInt(Math.floor(parseFloat(upholdBalanceStr)));
    if (upholdBalance < upholdDepositAmount) {
      monitoring.debug(`uphold: WARN - Balance on account after deposit is less than expected.`);
      return;
    }

    let eligibleUpholdTransfer = 0;
    for (let [address, amount] of Object.entries(payments)) {
      const res = await db.getPayoutPreferenceFromUpholdId(address);
      let asset_code = '',
        network = '';
      if (res) {
        asset_code = res.asset_code;
        network = res.network;
      } else if (asset_code == '' || network == '') {
        continue; // Asset details are not fetched.
      }
      const upholdAddr = address;

      address = await fetchUsersUpholdPreferredAssetAddress(asset_code, address);
      if (address == '') {
        continue; // Asset address is not fetched.
      }
      try {
        monitoring.debug(`uphold: Transfering ${amount.toString()} ${asset_code} to ${address}`);
        monitoring.debug(
          `uphold: Transfering ${asset_code} equivalent to ${amount} KAS in current cycle to ${address}.`
        );
        await upholdTransaction(
          treasuryUpholdAddr,
          asset_code,
          network,
          upholdAddr,
          address,
          amount,
          transactionManager!
        );
        eligibleUpholdTransfer++;
      } catch (error) {
        monitoring.error(
          `uphold: upholdPayout - Transfering ${amount.toString()} ${asset_code} to ${address} : ${error}`
        );
      }
      // ⏳ Add a small delay before sending the next transaction
      await new Promise(resolve => setTimeout(resolve, 3000)); // 3s delay
    }
    monitoring.debug(
      `uphold: upholdPayout - Total eligible NACHO transfers: ${eligibleUpholdTransfer}`
    );
  } catch (error) {
    monitoring.error(`uphold: Error during Uphold payout - ${error}`);
  }
}

async function fetchUsersUpholdPreferredAssetAddress(asset_code: string, upholdId: string) {
  const userInfo = await db.getUserDetails(upholdId);
  if (!userInfo || !userInfo.access_token) {
    monitoring.error(`uphold: No refresh token found for user ${upholdId}`);
    return '';
  }
  let access_token = decryptToken(userInfo.refresh_token);
  if (userInfo.access_expiry && userInfo.access_expiry <= Date.now()) {
    const response = await fetch('http://katpool-app:1818/oauth/refresh', {
      method: 'POST',
      headers: {
        'x-internal-secret': process.env.OAUTH_STATE!,
        'Content-Type': 'application/json',
      },
    });
    const data = await response.json();
    access_token = data.access_token;
  }
  const res = await fetchDataForAsset(asset_code, access_token);
  return res.accountId;
}

async function upholdTransaction(
  treasuryUpholdAddr: string,
  asset_code: string,
  network: string,
  upholdAddr: string,
  addressIdentifier: string,
  kasAmount: bigint,
  transactionManager: trxManager
) {
  try {
    const token = getUpholdAccessToken();
    const options = {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: { type: 'account', id: treasuryUpholdAddr },
        destination: { type: 'account', id: addressIdentifier },
        denomination: { asset: 'KAS', amount: kasAmount, target: 'origin' },
      }),
    };
    try {
      const response = await fetch(`${UPHOLD_BASE_URL}/transactions/quote`, options);
      if (!response.ok) {
        const err = await response.text();
        monitoring.error(
          `uphold: upholdTransaction - Quote API failed - ${response.status}: ${err}`
        );
        return;
      }

      const data = await response.json();
      if (!data.id) {
        monitoring.error(`uphold: upholdTransaction - Quote API response missing ID`);
        return;
      }

      const upholdAmount = data.quote.destination.amount;
      try {
        const options = {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ quoteId: data.id }),
        };

        const response = await fetch(`${UPHOLD_BASE_URL}/transactions`, options);
        if (!response.ok) {
          const err = await response.text();
          monitoring.error(
            `uphold: upholdTransaction - Transaction API failed - ${response.status}: ${err}`
          );
          return;
        }
        const txnData = await response.json();
        await resetBalancesByWallet(
          transactionManager.db,
          upholdAddr,
          kasAmount,
          balanceColumnMinersBalance,
          false
        );

        await db.recordUpholdPayment(
          upholdAddr,
          kasAmount,
          upholdAmount,
          txnData.id,
          asset_code,
          network
        );
        monitoring.log(
          `uphold: ✅ Uphold transaction completed successfully for ${upholdAddr} on ${asset_code} address - ${addressIdentifier} for network: ${network}`
        );
      } catch (error) {
        monitoring.error(`uphold: upholdTransaction - Transaction API error - ${error}`);
      }
    } catch (error) {
      monitoring.error(`uphold: upholdTransaction - Quote API error - ${error}`);
    }
  } catch (error) {
    monitoring.error(`uphold: upholdTransaction - ${error}`);
  }
}

export async function fetchDataForAsset(
  asset_code: string,
  accessToken: string
): Promise<{ balance: string; accountId: string }> {
  try {
    let nextUrl: string | null = `${UPHOLD_BASE_URL}/accounts`;
    let kasBalance: string = '-1';

    while (nextUrl) {
      try {
        const response = await fetch(nextUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch accounts. Status: ${response.status}`);
        }

        const data = await response.json();
        const accounts: UpholdAccount[] = data.accounts || data;

        const kasAccount = accounts.find(account => account.asset === asset_code);
        if (kasAccount) {
          kasBalance = kasAccount.balance.available;
          break; // No need to continue if we found the KAS account
        }

        nextUrl = data.pagination?.next || null;
      } catch (error) {
        console.error('❌ Error fetching balances:', error);
        break;
      }
    }

    return { balance: kasBalance ?? '-1', accountId: '' };
  } catch (error) {
    monitoring.error(`uphold: fetchEnterpriseBalancesForKAS - ${error}`);
    return { balance: '-1', accountId: '' };
  }
}

async function depositKASToUphold(address: string, amount: bigint, transactionManager: trxManager) {
  const matureEntries = await transactionManager.fetchMatureUTXOs();
  const outputs = [{ amount, address }];

  const result = await createTransactions({
    entries: matureEntries,
    outputs,
    changeAddress: transactionManager.address,
    priorityFee: 0n,
    networkId: transactionManager.networkId,
  });

  const transactions = result.transactions;

  // Log the lengths to debug any potential mismatch
  monitoring.log(
    `uphold: Created ${transactions.length} transactions for ${outputs.length} outputs.`
  );

  // Process each transaction sequentially with its associated address
  for (const transaction of transactions) {
    transaction.sign([transactionManager.privateKey]);
    monitoring.debug(`uphold: Transaction signed with ID: ${transaction.id}`);

    const hash = await transaction.submit(transactionManager.rpc);
    if (DEBUG) monitoring.debug(`uphold: Waiting for transaction ID: ${transaction.id} to mature`);
    await transactionManager.waitForMatureUtxo(hash);
    if (DEBUG)
      monitoring.debug(
        `uphold: Transaction ID ${hash} has matured. Proceeding with next transaction.`
      );

    // Record KAS deposit with 'uphold_' as prefix for wallet address
    transactionManager.recordPayment(hash, [{ address: 'uphold_' + address, amount }]);
  }
}
