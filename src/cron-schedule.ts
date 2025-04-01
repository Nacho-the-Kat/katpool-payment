import cron from 'node-cron'; 
import Monitoring from '../src/monitoring'

const monitoring = new Monitoring();

// Validate cron schedule
export function cronValidation(expr: string, alert = false) {
    if (cron.validate(expr)) {
        return expr;
    } else {
        if (!alert) {
            monitoring.error('cron-schedule: Invalid cron expression for payout. Defaulting to Twice a day.');
            return "0 */12 * * *";
        } else {
            monitoring.error('cron-schedule: Invalid cron expression for alerting. Defaulting to Four times a day.');
            return "0 1,7,13,19 * * *";
        }
    }    
}
