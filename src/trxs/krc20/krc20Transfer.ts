import { RpcClient, Encoding, Resolver, ScriptBuilder, Opcodes, PrivateKey, addressFromScriptPublicKey, createTransactions, kaspaToSompi } from "../../../wasm/kaspa";
import config from "../../../config/config.json";
import Monitoring from "../../monitoring";
import { DEBUG } from "../../index.ts";
import trxManager from "../index.ts";

let ticker = config.defaultTicker;
let dest = '';
let amount = '1';
let rpc: RpcClient;

const network = config.network || 'mainnet';
const priorityFeeValue = '1.5';
const timeout = 120000; // 2 minutes timeout
const monitoring = new Monitoring();

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
  monitoring.debug(`Subscribing to UTXO changes for address: ${address.toString()}`);
  await rpc.subscribeUtxosChanged([address.toString()]);
  rpc.addEventListener('utxos-changed', async (event: any) => {
    monitoring.debug(`UTXO changes detected for address: ${address.toString()}`);
    
    // Check for UTXOs removed for the specific address
    const removedEntry = event.data.removed.find((entry: any) => 
      entry.address.payload === address.toString().split(':')[1]
    );
    const addedEntry = event.data.added.find((entry: any) => 
      entry.address.payload === address.toString().split(':')[1]
    );    
    if (removedEntry) {
      // Use custom replacer function in JSON.stringify to handle BigInt
      monitoring.debug(`Added UTXO found for address: ${address.toString()} with UTXO: ${JSON.stringify(addedEntry, (key, value) =>
        typeof value === 'bigint' ? value.toString() + 'n' : value)}`);        
      monitoring.debug(`Removed UTXO found for address: ${address.toString()} with UTXO: ${JSON.stringify(removedEntry, (key, value) =>
        typeof value === 'bigint' ? value.toString() + 'n' : value)}`);
        addedEventTrxId = addedEntry.outpoint.transactionId;
      monitoring.debug(`Added UTXO TransactionId: ${addedEventTrxId}`);
      if (addedEventTrxId == SubmittedtrxId){
        eventReceived = true;
      }
    } else {
      monitoring.debug(`No removed UTXO found for address: ${address.toString()} in this UTXO change event`);
    }
  });

  const gasFee = 0.3
  const data = { "p": "krc-20", "op": "transfer", "tick": ticker, "amt": amount.toString(), "to": dest  };
  
  monitoring.debug(`transferKRC20: Data to use for ScriptBuilder: ${JSON.stringify(data)}`);
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

  if (DEBUG) {
    monitoring.debug(`Constructed Script: ${script.toString()}`);
    monitoring.debug(`P2SH Address: ${P2SHAddress.toString()}`);
  }

  try {
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [address.toString()] });
    const { transactions } = await createTransactions({
      priorityEntries: [],
      entries,
      outputs: [{
      address: P2SHAddress.toString(),
      amount: kaspaToSompi("0.3")!
      }],
      changeAddress: address.toString(),
      priorityFee: kaspaToSompi(priorityFeeValue.toString())!,
      networkId: network
    });
    for (const transaction of transactions) {
      transaction.sign([privateKey]);
      monitoring.debug(`transferKRC20: Transaction signed with ID: ${transaction.id}`);
      const hash = await transaction.submit(rpc);
      monitoring.log(`submitted P2SH commit sequence transaction on: ${hash}`);
      SubmittedtrxId = hash;
    }
    
    // Set a timeout to handle failure cases
    const commitTimeout = setTimeout(() => {
      if (!eventReceived) {
        monitoring.error('KRC20Transfer: Timeout - Commit transaction did not mature within 2 minutes');
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
    const { transactions } = await createTransactions({
      priorityEntries: [revealUTXOs.entries[0]],
      entries: entries,
      outputs: [],
      changeAddress: address.toString(),
      priorityFee: kaspaToSompi(gasFee.toString())!,
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