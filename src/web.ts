import express from 'express';
import logger from './monitoring/datadog';
import { checkFullFeeRebate } from './trxs/krc20/utils';
import { CONFIG } from './constants';
import Monitoring from './monitoring';

const monitoring = new Monitoring();

export const app = express();
const port = 9301;

// Add basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add request logging middleware
app.use(async (req, res, next) => {
  await logger.info(`${req.method} ${req.url}`);
  next();
});

app.get('/full_rebate/:wallet_address', async (req, res) => {
  const start = Date.now(); // Start time

  try {
    const walletAddress = req.params.wallet_address;
    const status = await checkFullFeeRebate(walletAddress, CONFIG.defaultTicker);

    const durationMs = Date.now() - start; // Duration in milliseconds
    return res.json({ walletAddress, status, durationMs }); // Example: { "status": true }
  } catch (err) {
    const durationMs = Date.now() - start;
    console.error('Error in /full_rebate route:', err);

    return res.status(500).json({
      error: 'Internal Server Error',
      durationMs,
    });
  }
});

// Start the server
export function startServer() {
  const server = app.listen(port, async () => {
    const msg = `API Server running at http://localhost:${port}`;
    monitoring.debug(msg);
    await logger.info(msg);
  });

  return server;
}
