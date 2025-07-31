function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set.`);
  }
  return value;
}

// Datadog Configuration
export const DATADOG_SECRET = getRequiredEnv('DATADOG_SECRET');
export const DATADOG_LOG_URL = getRequiredEnv('DATADOG_LOG_URL');
export const DATADOG_PAYMENT_SERVICE_NAME =
  process.env.DATADOG_PAYMENT_SERVICE_NAME || 'dev-katpool-payment';

// Debug Configuration
export const DEBUG = process.env.DEBUG === '1' ? 1 : 0;

// Treasury Configuration
export const treasuryPrivateKey = getRequiredEnv('TREASURY_PRIVATE_KEY');

// Database Configuration
export const databaseUrl = getRequiredEnv('DATABASE_URL');
