import config from "../../config/config.json";
import Monitoring from '../monitoring';
import trxManager from '../trxs';
import { fetchKASBalance, sompiToKAS } from '../utils';
import { krc20Token } from '../trxs/krc20/krc20Api';
import swapToKrc20 from '../trxs/krc20/swapToKrc20';
import { sendTelegramAlert } from './bot';

const explorerUrl = `https://kas.fyi/address/{address}`;

const monitoring = new Monitoring();

const kasAlertThreshold = Number(config.kasAlertThreshold) || 25000000000; // 250 KAS if not set
const nachoAlertThreshold = Number(config.nachoAlertThreshold) || 100000000000; // 1000 NACHO if not set

export class TelegramBotAlert {
    async checkTreasuryWalletForAlert(transactionManager: trxManager) {
        const url = explorerUrl
        .replace("{address}", encodeURIComponent(transactionManager!.address));

        const msg = await this.checkAllBalForAlert(transactionManager, url);
        monitoring.debug(`TelegramBotAlert: Msg: ${msg}`);
        if (msg.search('Balance') !== -1) {
            monitoring.debug(`TelegramBotAlert: Sending alert ...`);
            sendTelegramAlert(msg);
        }
        else {
            monitoring.debug(`TelegramBotAlert: No alert.`);
        }
    }

    private async checkAllBalForAlert(transactionManager: trxManager, url: string) {
        monitoring.debug(`Main: Running scheduled balance check for alerting.`);
      
        let treasuryKASBalance = 0;
        let treasuryNACHOBalance = 0;
        let totalOutstandingAmount = 0n;
        let totalKASWorthNACHO = 0n;
        let poolBalances = await transactionManager!.db.getPoolBalance();
        let poolBalance = 0n;
  
        try {
            // Fetch KAS balance
            treasuryKASBalance  = await fetchKASBalance(transactionManager!.address);
            monitoring.debug(`TelegramBotAlert: KAS balance at alert schedule: ${sompiToKAS(Number(treasuryKASBalance))} KAS`);
        } catch (error) {
            monitoring.error(`TelegramBotAlert: Can not fetch treasury KAS balance: ${error}.`);
        }
  
        try {
            // Fetch NACHO balance
            const result = await krc20Token(transactionManager!.address, config.defaultTicker);
            treasuryNACHOBalance = Number(result?.amount ?? 0);
            monitoring.debug(`TelegramBotAlert: ${config.defaultTicker} balance at alert schedule: ${sompiToKAS(Number(treasuryNACHOBalance))} ${config.defaultTicker}`);
        } catch (error) {
            monitoring.error(`TelegramBotAlert: Can not fetch treasury NACHO balance: ${error}.`);
        }
  
        try {
            // Fetch outstanding KAS
            totalOutstandingAmount = await transactionManager!.db.getAllPendingBalanceAboveThreshold(Number(config.thresholdAmount));
        } catch (error) {
            monitoring.error(`TelegramBotAlert: Can not fetch total outstanding KAS value: ${error}.`);
        }
  
        try {
            // Fetch pool balance
            poolBalance = 0n;
            if (poolBalances.length > 0) {
                poolBalance = BigInt(poolBalances[0].balance);
            } else {
                monitoring.error("TelegramBotAlert: Could not fetch Pool balance from Database.");
            }
            
            // Fetch outstanding NACHO
            const swapToKrc20Obj = new swapToKrc20();
            totalKASWorthNACHO = await swapToKrc20Obj!.swapKaspaToKRC(poolBalance);
            monitoring.debug(`TelegramBotAlert: Amount of ${config.defaultTicker} tokens to be used for NACHO rebate: ${sompiToKAS(Number(totalKASWorthNACHO))} ${config.defaultTicker}`); 
        } catch (error) {
            monitoring.error(`TelegramBotAlert: Can not determine tokens to be used for NACHO rebate: ${error}.`);
        }
  
        let msg = `<b>Wallet Address:</b> <a href="${url}">View pool treasury</a>\n`;
        if (treasuryKASBalance <= kasAlertThreshold) {
            msg += `\n<b>KAS Balance</b>\n--------------------------\n`;
            msg += `<b>Current:</b> <code>${sompiToKAS(treasuryKASBalance)} KAS</code>.\n`;
            msg += `<b>Threshold:</b> <code>${sompiToKAS(kasAlertThreshold)} KAS</code>.\n`;
        }
        if (treasuryKASBalance <= totalOutstandingAmount) {
            if (msg.search('KAS Balance') === -1) {
                msg += `\n<b>KAS Balance</b>\n--------------------------\n`;
                msg += `<b>Current:</b> <code>${sompiToKAS(treasuryKASBalance)} KAS</code>.\n`;
            }
            msg += `<b>Total outstanding:</b> <code>${sompiToKAS(Number(totalOutstandingAmount))} KAS</code>.\n`;
        }
  
        if (treasuryNACHOBalance <= nachoAlertThreshold) {
            msg += `\n<b>NACHO Balance</b>\n--------------------------\n`;
            msg += `<b>Current:</b> <code>${sompiToKAS(treasuryNACHOBalance)} NACHO</code>.\n`;
            msg += `<b>Threshold:</b> <code>${sompiToKAS(nachoAlertThreshold)} NACHO</code>.\n`;
        }
        if (treasuryNACHOBalance <= totalKASWorthNACHO) {
            if (msg.search('NACHO Balance') === -1) {
                msg += `\n<b>NACHO Balance</b>\n--------------------------\n`;
                msg += `<b>Current:</b> <code>${sompiToKAS(treasuryNACHOBalance)} NACHO</code>.\n`;
            }
            msg += `<b>Total outstanding KAS worth NACHO</b> <code>${sompiToKAS(Number(totalKASWorthNACHO))} NACHO</code>.\n`;
        }
      
        return msg;
    }
}
  