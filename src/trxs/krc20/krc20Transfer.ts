import {
  RpcClient,
  ScriptBuilder,
  Opcodes,
  addressFromScriptPublicKey,
  createTransactions,
  kaspaToSompi,
  PendingTransaction,
} from '../../../wasm/kaspa';
import { CONFIG, FIXED_FEE } from '../../constants';
import Monitoring from '../../monitoring';
import { DEBUG, db } from '../../index.ts';
import trxManager from '../index.ts';
import { pendingKRC20TransferField, status } from '../../database/index.ts';
import { recordPayment, resetBalancesByWallet } from './transferKrc20Tokens.ts';
import { validatePendingTransactions } from '../utils.ts';
import { findSuitableUtxo, pollStatus, PREFERRED_MIN_UTXO } from './utils.ts';

let ticker = CONFIG.defaultTicker;
let dest = '';
let amount = '1';
let rpc: RpcClient;

const network = CONFIG.network;
const feeInSompi = kaspaToSompi(FIXED_FEE)!;
const timeout = 180000; // 3 minutes timeout
const monitoring = new Monitoring();

/**
 * Handles transferring KRC20 tokens to the destination address.
 * - Logs entry in the Pending KRC20 Transfer table (helps in debugging stuck P2SH transactions).
 * - Resets the user's KRC20 balance in the database.
 * - Records the payment in the payment history.
 */
export async function transferAndRecordKRC20Payment(
  pRPC: RpcClient,
  pTicker: string,
  pDest: string,
  pAmount: string,
  kasAmount: bigint,
  transactionManager: trxManager,
  fullRebate: boolean
) {
  ticker = pTicker;
  dest = pDest;
  amount = pAmount;
  rpc = pRPC;

  let addedEventTrxId: any;
  let SubmittedtrxId: any;

  const treasuryAddr = transactionManager.address;
  const privateKey = transactionManager.privateKey;

  const utxosChangedStartHandler = async (event: any) => {
    monitoring.debug(
      `KRC20Transfer: UTXO changes detected for address: ${treasuryAddr.toString()}`
    );

    // Check for UTXOs removed for the specific address
    const removedEntry = event.data.removed.find(
      (entry: any) => entry.address.payload === treasuryAddr.toString().split(':')[1]
    );
    const addedEntry = event.data.added.find(
      (entry: any) => entry.address.payload === treasuryAddr.toString().split(':')[1]
    );
    if (removedEntry && addedEntry) {
      // Use custom replacer function in JSON.stringify to handle BigInt
      monitoring.debug(`KRC20Transfer: Added UTXO found for address: ${treasuryAddr.toString()}`);
      monitoring.debug(`KRC20Transfer: Removed UTXO found for address: ${treasuryAddr.toString()}`);
      addedEventTrxId = addedEntry.outpoint.transactionId;
      monitoring.debug(`KRC20Transfer: Added UTXO TransactionId: ${addedEventTrxId}`);
      if (addedEventTrxId == SubmittedtrxId) {
        eventReceived = true;
        control.stopPolling = true; // 🛑 Stop polling here
      }
    } else {
      monitoring.debug(
        `KRC20Transfer: No removed UTXO found for address: ${treasuryAddr.toString()} in this UTXO change event`
      );
    }
  };

  try {
    rpc.removeEventListener('utxos-changed', utxosChangedStartHandler);
  } catch (error) {
    monitoring.error(`KRC20Transfer: Removing event listener for 'utxos-changed': `, error);
  }

  rpc.addEventListener('utxos-changed', utxosChangedStartHandler);

  const data = { p: 'krc-20', op: 'transfer', tick: ticker, amt: amount.toString(), to: dest };

  monitoring.debug(`KRC20Transfer: Data to use for ScriptBuilder: ${JSON.stringify(data)}`);
  const script = new ScriptBuilder()
    .addData(privateKey.toPublicKey().toXOnlyPublicKey().toString())
    .addOp(Opcodes.OpCheckSig)
    .addOp(Opcodes.OpFalse)
    .addOp(Opcodes.OpIf)
    .addData(Buffer.from('kasplex'))
    .addI64(0n)
    .addData(Buffer.from(JSON.stringify(data, null, 0)))
    .addOp(Opcodes.OpEndIf);

  const P2SHAddress = addressFromScriptPublicKey(script.createPayToScriptHashScript(), network);
  if (!P2SHAddress) {
    monitoring.error(
      `KRC20Transfer: P2SHAddress is undefined for transferring NACHO to ${dest}, amount: ${amount.toString()} NACHO (with decimal).`
    );
    return;
  }
  let eventReceived = false;
  let control = { stopPolling: false }; // Track polling status

  if (DEBUG) {
    monitoring.debug(`KRC20Transfer: Constructed Script: ${script.toString()}`);
    monitoring.debug(`KRC20Transfer: P2SH Address: ${P2SHAddress.toString()}`);
  }

  try {
    const entries = await transactionManager.fetchMatureUTXOs();
    // Find a suitable UTXO
    const selectedUtxo = findSuitableUtxo(entries);
    if (!selectedUtxo) {
      throw new Error('KRC20Transfer: No suitable UTXO found (requires at least 1 KAS)');
    }

    let utxoAmount = BigInt(selectedUtxo.entry.amount);
    monitoring.debug(`KRC20Transfer: Selected UTXO with amount: ${utxoAmount.toString()} sompi`);

    // First transaction: Send the UTXO to P2SH address
    if (entries.length === 1) utxoAmount = utxoAmount - 3n * BigInt(feeInSompi)!;

    let transactions: PendingTransaction[];
    try {
      const result = await createTransactions({
        priorityEntries: [selectedUtxo],
        entries: entries.filter(e => e !== selectedUtxo),
        outputs: [
          {
            address: P2SHAddress.toString(),
            amount: PREFERRED_MIN_UTXO, // Send PREFERRED_MIN_UTXO
          },
        ],
        changeAddress: treasuryAddr.toString(),
        priorityFee: feeInSompi,
        networkId: network,
      });
      transactions = result.transactions;
    } catch (error) {
      monitoring.error(`KRC20Transfer: Failed to create transactions: `, error);
      return;
    }

    for (const transaction of transactions) {
      validatePendingTransactions(transaction, privateKey, transactionManager.networkId);
      try {
        transaction.sign([privateKey]);
        monitoring.debug(`KRC20Transfer: Transaction signed with ID: ${transaction.id}`);
      } catch (error) {
        monitoring.error(`KRC20Transfer: Failed to sign transaction: `, error);
        return;
      }

      try {
        const hash = await transaction.submit(rpc);
        monitoring.log(`KRC20Transfer: submitted P2SH commit sequence transaction on: ${hash}`);
        SubmittedtrxId = hash;
      } catch (error) {
        monitoring.error(`KRC20Transfer: Failed to submit transaction: `, error);
        return;
      }

      try {
        let actualKASAmount = kasAmount;
        if (fullRebate) {
          monitoring.debug(`KRC20Transfer: Full rebate to address: ${pDest}`);
          actualKASAmount = actualKASAmount * 3n;
        }
        await db.recordPendingKRC20Transfer(
          SubmittedtrxId,
          actualKASAmount,
          BigInt(amount),
          pDest,
          P2SHAddress.toString(),
          status.PENDING,
          status.PENDING
        );
      } catch (error) {
        monitoring.error(`KRC20Transfer: Failed to record pending KRC20 transfer: `, error);
      }

      try {
        await resetBalancesByWallet(db, pDest, kasAmount, 'nacho_rebate_kas', fullRebate);
      } catch (error) {
        monitoring.error(
          `KRC20Transfer: Failed to reset balances for nacho_rebate_kas of ${amount} sompi for ${pDest}: `,
          error
        );
      }

      try {
        // Deduct full amount from POOL balance entry, despite non-eligibility for full rebate.
        await resetBalancesByWallet(db, treasuryAddr, kasAmount * 3n, 'balance', false);
      } catch (error) {
        monitoring.error(
          `KRC20Transfer: Failed to reset balances for pool balance with needed reduction of ${kasAmount * 3n} sompi for ${pDest} : `,
          error
        );
      }

      let finalStatus;
      try {
        monitoring.log(
          `KRC20Transfer: Polling balance for P2SH address: ${P2SHAddress.toString()} for submit transaction.`
        );
        finalStatus = await pollStatus(P2SHAddress.toString(), utxoAmount, control, false);
      } catch (error) {
        monitoring.error(`KRC20Transfer: ❌ Operation failed:", `, error);
      }
      if (finalStatus === true) {
        monitoring.log(
          `KRC20Transfer: Maturity event is not received. Balance is received. So submitting reveal transaction.`
        );
        eventReceived = true;
      }
    }

    // Set a timeout to handle failure cases
    const commitTimeout = setTimeout(() => {
      if (!eventReceived) {
        monitoring.error(
          'KRC20Transfer: Timeout - Commit transaction did not mature within 3 minutes'
        );
      }
    }, timeout);

    // Wait until the maturity event has been received
    while (!eventReceived) {
      await new Promise(resolve => setTimeout(resolve, 500)); // wait and check every 500ms
    }
    clearTimeout(commitTimeout); // Clear the reveal timeout if the event is received
  } catch (initialError) {
    monitoring.error(`KRC20Transfer: Initial transaction error: `, initialError);
  }

  if (eventReceived) {
    eventReceived = false;
    monitoring.debug(`KRC20Transfer: creating UTXO entries from ${treasuryAddr.toString()}`);
    const entries = await transactionManager.fetchMatureUTXOs();
    monitoring.debug(`KRC20Transfer: creating revealUTXOs from P2SHAddress`);
    const revealUTXOs = await rpc.getUtxosByAddresses({ addresses: [P2SHAddress.toString()] });
    monitoring.debug(`KRC20Transfer: Creating Transaction with revealUTX0s entries.`);

    // Second transaction: Return everything except the fixed fee
    const revealUtxoAmount = BigInt(revealUTXOs.entries[0].entry.amount);

    let transactions: PendingTransaction[];
    try {
      const result = await createTransactions({
        priorityEntries: [revealUTXOs.entries[0]],
        entries: entries,
        outputs: [
          {
            address: treasuryAddr.toString(), // Return to sender
            amount: revealUtxoAmount, // Return everything
          },
        ],
        changeAddress: treasuryAddr.toString(),
        priorityFee: feeInSompi,
        networkId: network,
      });
      transactions = result.transactions;
    } catch (error) {
      monitoring.error(`KRC20Transfer: Failed to create reveal transactions: `, error);
      return;
    }

    let revealHash: any;
    for (const transaction of transactions) {
      validatePendingTransactions(transaction, privateKey, transactionManager.networkId);
      try {
        transaction.sign([privateKey], false);
        monitoring.debug(
          `KRC20Transfer: Transaction with revealUTX0s signed with ID: ${transaction.id}`
        );
      } catch (error) {
        monitoring.error(`KRC20Transfer: Failed to sign reveal transaction: `, error);
        return;
      }

      const ourOutput = transaction.transaction.inputs.findIndex(
        input => input.signatureScript === ''
      );
      if (ourOutput !== -1) {
        const signature = await transaction.createInputSignature(ourOutput, privateKey);
        transaction.fillInput(ourOutput, script.encodePayToScriptHashSignatureScript(signature));
      }

      try {
        revealHash = await transaction.submit(rpc);
        monitoring.log(`KRC20Transfer: submitted reveal tx sequence transaction: ${revealHash}`);
        SubmittedtrxId = revealHash;
      } catch (error) {
        monitoring.error(`KRC20Transfer: Failed to submit reveal transaction: `, error);
        return;
      }
    }

    const revealTimeout = setTimeout(() => {
      if (!eventReceived) {
        monitoring.error(
          'KRC20Transfer: Timeout - Reveal transaction did not mature within 3 minutes'
        );
      }
    }, timeout);

    // Add Polling for Reveal Transaction
    let revealFinalStatus;
    control = { stopPolling: false }; // Control for polling the reveal transaction

    try {
      monitoring.log(
        `KRC20Transfer: Polling balance for reveal transaction at P2SH address: ${P2SHAddress.toString()}`
      );
      revealFinalStatus = await pollStatus(P2SHAddress.toString(), revealUtxoAmount, control, true);
    } catch (error) {
      monitoring.error(`KRC20Transfer: ❌ Reveal transaction polling failed: `, error);
      return;
    }

    if (revealFinalStatus === true) {
      monitoring.log(`KRC20Transfer: Reveal transaction matured successfully.`);
      eventReceived = true;
    }

    // Wait until the maturity event has been received
    while (!eventReceived) {
      await new Promise(resolve => setTimeout(resolve, 500)); // wait and check every 500ms
    }

    clearTimeout(revealTimeout); // Clear the reveal timeout if the event is received

    try {
      // Fetch the updated UTXOs
      const updatedUTXOs = await rpc.getUtxosByAddresses({ addresses: [treasuryAddr.toString()] });

      // Check if the reveal transaction is accepted
      const revealAccepted = updatedUTXOs.entries.some(entry => {
        const transactionId = entry.entry.outpoint ? entry.entry.outpoint.transactionId : undefined;
        return transactionId === revealHash;
      });

      // If reveal transaction is accepted
      if (revealAccepted) {
        monitoring.log(`KRC20Transfer: Reveal transaction has been accepted: ${revealHash}`);
        try {
          monitoring.log(`KRC20Transfer: Entering recordPayment - ${revealHash}`);
          await recordPayment(pDest, BigInt(pAmount), revealHash, P2SHAddress.toString(), db);
          monitoring.log(`KRC20Transfer: Recorded payment - ${revealHash}`);
        } catch (error) {
          monitoring.error(
            `KRC20Transfer: Recording payment for ${pDest} of ${pAmount} NACHO with P2SH - ${P2SHAddress.toString()} for reveal hash: ${revealHash} - `,
            error
          );
          try {
            monitoring.log(
              `KRC20Transfer: Entering updatePendingKRC20TransferStatus - ${revealHash}`
            );
            await db.updatePendingKRC20TransferStatus(
              P2SHAddress.toString(),
              pendingKRC20TransferField.nachoTransferStatus,
              status.COMPLETED
            );
            monitoring.log(
              `KRC20Transfer: Completed updatePendingKRC20TransferStatus - ${revealHash}`
            );
          } catch (error) {
            monitoring.error(
              `KRC20Transfer: Updating Pending KRC20 transfer status for ${P2SHAddress.toString()} for reveal hash: ${revealHash} - error: `,
              error
            );
          }
        }
      } else if (!eventReceived) {
        // Check eventReceived here
        monitoring.log('KRC20Transfer: Reveal transaction has not been accepted yet.');
      }
    } catch (error) {
      monitoring.error(`KRC20Transfer: Error checking reveal transaction status: `, error);
    }
  } else {
    monitoring.error('KRC20Transfer: No UTXOs available for reveal');
    return;
  }
}
