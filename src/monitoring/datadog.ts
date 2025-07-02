import axios from 'axios';

const { DATADOG_SECRET, DATADOG_LOG_URL, DATADOG_PAYMENT_SERVICE_NAME } = process.env;
if (!DATADOG_SECRET) {
  throw new Error('Environment variable DATADOG_SECRET is not set.');
}

if (!DATADOG_LOG_URL) {
  throw new Error('Environment variable DATADOG_LOG_URL is not set.');
}

interface LogContext {
  [key: string]: any;
  traceId?: string;
}

const sendLog = async (level: string, message: string, context: LogContext = {}) => {
  const baseLogObject = {
    ddsource: 'nodejs',
    service: DATADOG_PAYMENT_SERVICE_NAME || 'prod-katpool-payment',
    timestamp: new Date().toISOString(),
  };

  await axios.post(
    DATADOG_LOG_URL!,
    {
      ...baseLogObject,
      ...context,
      level,
      message,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DATADOG_SECRET!,
      },
    }
  );
};

const logger = {
  info: (message: string, context?: LogContext) => sendLog('info', message, context),
  error: (message: string, context?: LogContext) => sendLog('error', message, context),
  warn: (message: string, context?: LogContext) => sendLog('warn', message, context),
};

export default logger;
