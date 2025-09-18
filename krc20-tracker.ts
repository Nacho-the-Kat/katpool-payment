#!/usr/bin/env node

/**
 * KRC20 Transaction Tracker for Kaspa
 *
 * This script listens for Kaspa transactions and specifically detects KRC20 token transfers.
 * It uses the Kaspa RPC to monitor for new transactions and parses them for KRC20 operations.
 */

// Configuration
const CONFIG = {
  network: 'mainnet', // or 'testnet-10'
  rpcUrl: 'http://localhost:17110', // Change this to your Kaspa node RPC endpoint
  debug: true,
  // KRC20 specific settings
  krc20Prefix: 'kasplex',
  supportedTokens: ['NACHO', 'KATCLAIM'], // Add your supported tokens here
};

// Transaction tracking state
let isConnected = false;
let lastBlockHash: string | null = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// Utility functions
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  if (CONFIG.debug) {
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

function error(message: string, error?: any) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`, error || '');
}

// KRC20 parsing functions
function isKRC20Transaction(scriptData: string): boolean {
  try {
    // Look for KRC20 pattern in script data
    if (scriptData.includes(CONFIG.krc20Prefix)) {
      return true;
    }

    // Check for KRC20 operation patterns
    const krc20Patterns = [
      /"p"\s*:\s*"krc-20"/i,
      /"op"\s*:\s*"transfer"/i,
      /"tick"\s*:/i,
      /"amt"\s*:/i,
    ];

    return krc20Patterns.some(pattern => pattern.test(scriptData));
  } catch (e) {
    return false;
  }
}

function parseKRC20Data(scriptData: string): any {
  try {
    // Try to extract KRC20 operation data
    const jsonMatch = scriptData.match(/\{[^}]*"p"\s*:\s*"krc-20"[^}]*\}/);
    if (jsonMatch) {
      const krc20Data = JSON.parse(jsonMatch[0]);
      return {
        protocol: krc20Data.p,
        operation: krc20Data.op,
        ticker: krc20Data.tick,
        amount: krc20Data.amt,
        to: krc20Data.to,
        from: krc20Data.from,
      };
    }
  } catch (e) {
    // If JSON parsing fails, try to extract basic info
    const tickerMatch = scriptData.match(/"tick"\s*:\s*"([^"]+)"/);
    const amountMatch = scriptData.match(/"amt"\s*:\s*"([^"]+)"/);
    const opMatch = scriptData.match(/"op"\s*:\s*"([^"]+)"/);

    if (tickerMatch || amountMatch || opMatch) {
      return {
        ticker: tickerMatch?.[1] || 'Unknown',
        amount: amountMatch?.[1] || 'Unknown',
        operation: opMatch?.[1] || 'Unknown',
        protocol: 'krc-20',
      };
    }
  }

  return null;
}

// Transaction processing
async function processTransaction(transaction: any) {
  try {
    const txId = transaction.transactionId;
    const inputs = transaction.inputs || [];
    const outputs = transaction.outputs || [];

    log(`Processing transaction: ${txId}`);

    // Check outputs for KRC20 data
    for (const output of outputs) {
      if (output.scriptPublicKey && output.scriptPublicKey.script) {
        const scriptData = output.scriptPublicKey.script;

        if (isKRC20Transaction(scriptData)) {
          const krc20Data = parseKRC20Data(scriptData);

          if (krc20Data) {
            log('🎯 KRC20 Transaction Detected!', {
              transactionId: txId,
              ...krc20Data,
              outputIndex: outputs.indexOf(output),
              amount: output.amount,
            });

            // Check if it's a supported token
            if (CONFIG.supportedTokens.includes(krc20Data.ticker?.toUpperCase())) {
              log(`✅ Supported token detected: ${krc20Data.ticker}`);
            }
          }
        }
      }
    }

    // Check inputs for KRC20 spending
    for (const input of inputs) {
      if (input.scriptPublicKey && input.scriptPublicKey.script) {
        const scriptData = input.scriptPublicKey.script;

        if (isKRC20Transaction(scriptData)) {
          const krc20Data = parseKRC20Data(scriptData);

          if (krc20Data) {
            log('💸 KRC20 Spending Detected!', {
              transactionId: txId,
              ...krc20Data,
              inputIndex: inputs.indexOf(input),
            });
          }
        }
      }
    }
  } catch (e) {
    error(`Error processing transaction: ${e}`);
  }
}

// Block processing
async function processBlock(blockHash: string) {
  try {
    if (lastBlockHash === blockHash) {
      return; // Skip if we've already processed this block
    }

    log(`Processing new block: ${blockHash}`);

    const block = await fetchBlock(blockHash);
    if (!block || !block.transactions) {
      return;
    }

    // Process each transaction in the block
    for (const transaction of block.transactions) {
      await processTransaction(transaction);
    }

    lastBlockHash = blockHash;
  } catch (e) {
    error(`Error processing block: ${e}`);
  }
}

// RPC functions using fetch
async function rpcCall(method: string, params: any[] = []): Promise<any> {
  try {
    const response = await fetch(CONFIG.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`RPC error: ${data.error.message}`);
    }

    return data.result;
  } catch (e) {
    throw new Error(`RPC call failed: ${e}`);
  }
}

async function fetchBlock(blockHash: string): Promise<any> {
  return await rpcCall('getBlock', [{ hash: blockHash }]);
}

async function getServerInfo(): Promise<any> {
  return await rpcCall('getServerInfo');
}

async function getBlockDagInfo(): Promise<any> {
  return await rpcCall('getBlockDagInfo');
}

// Polling-based block monitoring
async function startBlockPolling() {
  try {
    log('Starting block polling...');

    // Get current DAG info
    const dagInfo = await getBlockDagInfo();
    if (dagInfo?.tipHashes && dagInfo.tipHashes.length > 0) {
      lastBlockHash = dagInfo.tipHashes[0];
      log(`Starting from block: ${lastBlockHash}`);
    }

    // Poll for new blocks every 2 seconds
    setInterval(async () => {
      try {
        const currentDagInfo = await getBlockDagInfo();
        if (currentDagInfo?.tipHashes && currentDagInfo.tipHashes.length > 0) {
          const currentTip = currentDagInfo.tipHashes[0];

          if (currentTip !== lastBlockHash) {
            await processBlock(currentTip);
          }
        }
      } catch (e) {
        error('Error during block polling', e);
      }
    }, 2000);
  } catch (e) {
    error('Failed to start block polling', e);
  }
}

// Connection management
async function connect() {
  try {
    log('Connecting to Kaspa RPC...');

    const serverInfo = await getServerInfo();
    log('Connected to Kaspa node', {
      isSynced: serverInfo.isSynced,
      hasUtxoIndex: serverInfo.hasUtxoIndex,
      version: serverInfo.version,
    });

    if (!serverInfo.isSynced) {
      error('Warning: Node is not fully synced');
    }

    if (!serverInfo.hasUtxoIndex) {
      error('Warning: Node does not have UTXO index enabled');
    }

    isConnected = true;
    reconnectAttempts = 0;

    // Start block polling
    await startBlockPolling();

    log('Connection established and monitoring started');
  } catch (e) {
    error('Failed to connect to Kaspa RPC', e);
    throw e;
  }
}

async function disconnect() {
  try {
    if (isConnected) {
      log('Disconnecting from Kaspa RPC...');
      isConnected = false;
      log('Disconnected successfully');
    }
  } catch (e) {
    error('Error during disconnect', e);
  }
}

// Reconnection logic
async function reconnect() {
  if (reconnectAttempts >= maxReconnectAttempts) {
    error('Max reconnection attempts reached. Exiting...');
    process.exit(1);
  }

  reconnectAttempts++;
  log(`Attempting to reconnect... (${reconnectAttempts}/${maxReconnectAttempts})`);

  try {
    await disconnect();
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    await connect();
  } catch (e) {
    error('Reconnection failed', e);
    // Try again after 10 seconds
    setTimeout(reconnect, 10000);
  }
}

// Main execution
async function main() {
  try {
    log('Starting KRC20 Transaction Tracker...');
    log(`Network: ${CONFIG.network}`);
    log(`RPC URL: ${CONFIG.rpcUrl}`);

    await connect();

    // Keep the process running
    log('Tracker is running. Press Ctrl+C to stop.');

    // Set up graceful shutdown
    process.on('SIGINT', async () => {
      log('Shutdown signal received...');
      await disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      log('Termination signal received...');
      await disconnect();
      process.exit(0);
    });

    // Handle connection errors
    process.on('uncaughtException', async e => {
      error('Uncaught exception', e);
      if (isConnected) {
        await reconnect();
      }
    });

    process.on('unhandledRejection', async (reason, promise) => {
      error('Unhandled rejection at', { promise, reason });
      if (isConnected) {
        await reconnect();
      }
    });
  } catch (e) {
    error('Fatal error in main function', e);
    if (isConnected) {
      await reconnect();
    } else {
      process.exit(1);
    }
  }
}

// Run the tracker
if (require.main === module) {
  main().catch(e => {
    error('Unhandled error in main', e);
    process.exit(1);
  });
}

export { main, connect, disconnect, processTransaction, processBlock };
