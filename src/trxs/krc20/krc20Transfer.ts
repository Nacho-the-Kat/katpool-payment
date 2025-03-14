import { RpcClient, Encoding, Resolver, ScriptBuilder, Opcodes, PrivateKey, addressFromScriptPublicKey, createTransactions, kaspaToSompi } from "../../../wasm/kaspa";
import config from "../../../config/config.json";
import Monitoring from "../../monitoring";
import { DEBUG } from "../../index.ts";
import trxManager from "../index.ts";
import { fetchKASBalance } from "../../utils.ts";

let ticker = config.defaultTicker;
let dest = '';
let amount = '1';
let rpc: RpcClient;

const network = config.network || 'mainnet';
const FIXED_FEE = '0.0001'; // Fixed minimal fee
const feeInSompi = kaspaToSompi(FIXED_FEE)!;
const timeout = 180000; // 3 minutes timeout
const monitoring = new Monitoring();

// UTXO selection thresholds in sompi (1 KAS = 100_000_000 sompi)
const PREFERRED_MIN_UTXO = 5_00_000_000n; // 5 KAS
const ABSOLUTE_MIN_UTXO = 1_00_000_000n;  // 1 KAS

// Helper function to find suitable UTXO
function findSuitableUtxo(entries: any[]): any {
  if (!entries.length) return null;
  
  // First try to find a UTXO ≥ 5 KAS
  let utxo = entries.find(entry => BigInt(entry.entry.amount) >= PREFERRED_MIN_UTXO);
  
  // If not found, try to find a UTXO ≥ 1 KAS
  if (!utxo) {
    utxo = entries.find(entry => BigInt(entry.entry.amount) >= ABSOLUTE_MIN_UTXO);
  }
  
  return utxo;
}

export async function transferKRC20(pRPC: RpcClient, pTicker: string, pDest: string, pAmount: string, transactionManager: trxManager) {
  ticker = pTicker;
  dest = pDest;
  amount = pAmount;
  rpc = pRPC;

  let addedEventTrxId : any;
  let SubmittedtrxId: any;
  
  const address = transactionManager.address;
  const privateKey = transactionManager.privateKey;
  
  // New UTXO subscription setup (ADD this):
  monitoring.debug(`KRC20Transfer: Subscribing to UTXO changes for address: ${address.toString()}`);
  await rpc.subscribeUtxosChanged([address.toString()]);
  rpc.addEventListener('utxos-changed', async (event: any) => {
    monitoring.debug(`KRC20Transfer: UTXO changes detected for address: ${address.toString()}`);
    
    // Check for UTXOs removed for the specific address
    const removedEntry = event.data.removed.find((entry: any) => 
      entry.address.payload === address.toString().split(':')[1]
    );
    const addedEntry = event.data.added.find((entry: any) => 
      entry.address.payload === address.toString().split(':')[1]
    );    
    if (removedEntry && addedEntry) {
      // Use custom replacer function in JSON.stringify to handle BigInt
      monitoring.debug(`KRC20Transfer: Added UTXO found for address: ${address.toString()} with UTXO: ${JSON.stringify(addedEntry, (key, value) =>
        typeof value === 'bigint' ? value.toString() + 'n' : value)}`);        
      monitoring.debug(`KRC20Transfer: Removed UTXO found for address: ${address.toString()} with UTXO: ${JSON.stringify(removedEntry, (key, value) =>
        typeof value === 'bigint' ? value.toString() + 'n' : value)}`);
        addedEventTrxId = addedEntry.outpoint.transactionId;
      monitoring.debug(`KRC20Transfer: Added UTXO TransactionId: ${addedEventTrxId}`);
      if (addedEventTrxId == SubmittedtrxId){
        eventReceived = true;
        control.stopPolling = true; // 🛑 Stop polling here
      }
    } else {
      monitoring.debug(`KRC20Transfer: No removed UTXO found for address: ${address.toString()} in this UTXO change event`);
    }
  });

  const data = { "p": "krc-20", "op": "transfer", "tick": ticker, "amt": amount.toString(), "to": dest  };
  
  monitoring.debug(`KRC20Transfer: Data to use for ScriptBuilder: ${JSON.stringify(data)}`);
  const script = new ScriptBuilder()
    .addData(privateKey.toPublicKey().toXOnlyPublicKey().toString())
    .addOp(Opcodes.OpCheckSig)
    .addOp(Opcodes.OpFalse)
    .addOp(Opcodes.OpIf)
    .addData(Buffer.from("kasplex"))
    .addI64(0n)
    .addData(Buffer.from(JSON.stringify(data, null, 0)))
    .addOp(Opcodes.OpEndIf);
  
  const P2SHAddress = addressFromScriptPublicKey(script.createPayToScriptHashScript(), network)!;
  let eventReceived = false;
  let control = { stopPolling: false }; // Track polling status

  if (DEBUG) {
    monitoring.debug(`KRC20Transfer: Constructed Script: ${script.toString()}`);
    monitoring.debug(`KRC20Transfer: P2SH Address: ${P2SHAddress.toString()}`);
  }

  try {
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [address.toString()] });
    
    // Find a suitable UTXO
    const selectedUtxo = findSuitableUtxo(entries);
    if (!selectedUtxo) {
      throw new Error('KRC20Transfer: No suitable UTXO found (requires at least 1 KAS)');
    }

    let utxoAmount = BigInt(selectedUtxo.entry.amount);
    monitoring.debug(`KRC20Transfer: Selected UTXO with amount: ${utxoAmount.toString()} sompi`);

    // First transaction: Send the UTXO to P2SH address
    if (entries.length === 1)
      utxoAmount = utxoAmount - (3n * BigInt(feeInSompi)!);
    const { transactions } = await createTransactions({
      priorityEntries: [selectedUtxo],
      entries: entries.filter(e => e !== selectedUtxo),
      outputs: [{
        address: P2SHAddress.toString(),
        amount: PREFERRED_MIN_UTXO // Send PREFERRED_MIN_UTXO
      }],
      changeAddress: address.toString(),
      priorityFee: feeInSompi,
      networkId: network
    });

    for (const transaction of transactions) {
      transaction.sign([privateKey]);
      monitoring.debug(`KRC20Transfer: Transaction signed with ID: ${transaction.id}`);
      const hash = await transaction.submit(rpc);
      monitoring.log(`KRC20Transfer: submitted P2SH commit sequence transaction on: ${hash}`);
      SubmittedtrxId = hash;
      let finalStatus;
      try {
        monitoring.log(`KRC20Transfer: Polling balance for P2SH address: ${P2SHAddress.toString()}`);
        finalStatus = await pollStatus(P2SHAddress.toString(), utxoAmount, control);
      } catch (error) {
        monitoring.error(`KRC20Transfer: ❌ Operation failed:", ${error}`);
      }
      if (finalStatus === true) {
        monitoring.log(`KRC20Transfer: Maturity event is not received. Balance is received. So submitting reveal transaction.`);
        eventReceived = true;
      }
    }
    
    // Set a timeout to handle failure cases
    const commitTimeout = setTimeout(() => {
      if (!eventReceived) {
        monitoring.error('KRC20Transfer: Timeout - Commit transaction did not mature within 3 minutes');
      }
    }, timeout);

    // Wait until the maturity event has been received
    while (!eventReceived) {
      await new Promise(resolve => setTimeout(resolve, 500)); // wait and check every 500ms
    }
    clearTimeout(commitTimeout);  // Clear the reveal timeout if the event is received      
  } catch (initialError) {
    monitoring.error(`KRC20Transfer: Initial transaction error: ${initialError}`);
  }

  if (eventReceived) {
    eventReceived = false;
    monitoring.debug(`KRC20Transfer: creating UTXO entries from ${address.toString()}`);
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [address.toString()] });
    monitoring.debug(`KRC20Transfer: creating revealUTXOs from P2SHAddress`);
    const revealUTXOs = await rpc.getUtxosByAddresses({ addresses: [P2SHAddress.toString()] });
    monitoring.debug(`KRC20Transfer: Creating Transaction with revealUTX0s entries: ${revealUTXOs.entries[0]}`);

    // Second transaction: Return everything except the fixed fee
    const revealUtxoAmount = BigInt(revealUTXOs.entries[0].entry.amount);

    const { transactions } = await createTransactions({
      priorityEntries: [revealUTXOs.entries[0]],
      entries: entries,
      outputs: [{
        address: address.toString(), // Return to sender
        amount: revealUtxoAmount // Return everything
      }],
      changeAddress: address.toString(),
      priorityFee: feeInSompi,
      networkId: network
    });
  
    let revealHash: any;
    for (const transaction of transactions) {
      transaction.sign([privateKey], false);
      monitoring.debug(`KRC20Transfer: Transaction with revealUTX0s signed with ID: ${transaction.id}`);
      const ourOutput = transaction.transaction.inputs.findIndex((input) => input.signatureScript === '');
      if (ourOutput !== -1) {
      const signature = await transaction.createInputSignature(ourOutput, privateKey);
      transaction.fillInput(ourOutput, script.encodePayToScriptHashSignatureScript(signature));
      }
      revealHash = await transaction.submit(rpc);
      monitoring.log(`KRC20Transfer: submitted reveal tx sequence transaction: ${revealHash}`);
      SubmittedtrxId = revealHash;
    }

    const revealTimeout = setTimeout(() => {
      if (!eventReceived) {
        monitoring.error('KRC20Transfer: Timeout - Reveal transaction did not mature within 2 minutes');
        return {error: 'KRC20Transfer: Timeout - Reveal transaction did not mature within 2 minutes', revealHash: ''};
      }
    }, timeout);

    // Wait until the maturity event has been received
    while (!eventReceived) {
      await new Promise(resolve => setTimeout(resolve, 500)); // wait and check every 500ms
    }
    
    clearTimeout(revealTimeout);  // Clear the reveal timeout if the event is received          
    
    try {
      // Fetch the updated UTXOs
      const updatedUTXOs = await rpc.getUtxosByAddresses({ addresses: [address.toString()] });
  
      // Check if the reveal transaction is accepted
      const revealAccepted = updatedUTXOs.entries.some(entry => {
        const transactionId = entry.entry.outpoint ? entry.entry.outpoint.transactionId : undefined;
        return transactionId === revealHash;
      });
  
      // If reveal transaction is accepted
      if (revealAccepted) {
        monitoring.log(`KRC20Transfer: Reveal transaction has been accepted: ${revealHash}`);
        return {error: null, revealHash};
      } else if (!eventReceived) { // Check eventReceived here
        monitoring.log('KRC20Transfer: Reveal transaction has not been accepted yet.');
        return {error: 'KRC20Transfer: Reveal transaction has not been accepted yet', revealHash: ''};
      }
    } catch (error) {
      monitoring.error(`KRC20Transfer: Error checking reveal transaction status: ${error}`);
      return {error, revealHash: ''};
    }
      
  } else {
    monitoring.error('KRC20Transfer: No UTXOs available for reveal');
    return {error: 'KRC20Transfer: No UTXOs available for reveal', revealHash: ''};
  }
}

async function pollStatus(P2SHAddress: string, utxoAmount: bigint, control: { stopPolling: boolean }, interval = 60000, maxAttempts = 30): Promise<boolean> {
  let attempts = 0;

  return new Promise((resolve, reject) => {
    const checkStatus = async () => {
      if (!control.stopPolling) {
        monitoring.log(`KRC20Transfer: ⏹ Polling stopped manually.`);
        resolve(false);
        return;
      }

      attempts++;

      try {
        const p2shKASBalance = BigInt(await fetchKASBalance(P2SHAddress));
        monitoring.log(`KRC20Transfer: Polling attempt ${attempts}: ${p2shKASBalance} sompi`);

        if (p2shKASBalance > 0 || p2shKASBalance >= utxoAmount) {
          monitoring.log("KRC20Transfer: ✅ Operation completed successfully!");
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
        monitoring.error(`KRC20Transfer: Error polling API: ${error}`);
        reject(error);
      }
    };

    checkStatus();
  });
}