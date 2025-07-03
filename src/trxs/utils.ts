import {
  kaspaToSompi,
  maximumStandardTransactionMass,
  PendingTransaction,
  PrivateKey,
  sompiToKaspaStringWithSuffix,
} from '../../wasm/kaspa/kaspa';
import { DEBUG } from '../index';
import Monitoring from '../monitoring';

const monitoring = new Monitoring();

export function validatePendingTransactions(
  transaction: PendingTransaction,
  privateKey: PrivateKey,
  networkId: string
) {
  if (DEBUG) monitoring.debug(`TrxManager: Signing transaction ID: ${transaction.id}`);
  // Ensure the private key is valid before signing
  if (!privateKey) {
    throw new Error(`Private key is missing or invalid.`);
  }

  // Validate change amount before submission
  monitoring.debug(
    `TrxManager: Change amount for transaction ID: ${transaction.id} - ${sompiToKaspaStringWithSuffix(transaction.changeAmount, networkId)}`
  );
  if (transaction.changeAmount < kaspaToSompi('0.02')!) {
    monitoring.error(
      `Transaction ID ${transaction.id} has change amount less than 0.02 KAS. Skipping transaction.`
    );
  }

  // Validate transaction mass before submission
  const txMass = transaction.transaction.mass;
  if (txMass > maximumStandardTransactionMass()) {
    monitoring.error(`Transaction mass ${txMass} exceeds maximum standard mass`);
  }
}
