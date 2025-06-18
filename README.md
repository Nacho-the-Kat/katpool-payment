# katpool-payment for kaspa WASM mining pool

Check [katpool-app](https://github.com/argonmining/katpool-app) repo for details

## Download Kaspa WASM

** IMPORTANT **
Before anything, add wasm foolder to the local folder
You can download the latest form here: https://kaspa.aspectron.org/nightly/downloads/ move nodejs to the repo folder as wasm
unzip, rename and move `nodejs` that contains `kaspa` and kaspa-dev`to`wasm` folder locally.

## Create env variables

create .env file

```
TREASURY_PRIVATE_KEY=<private key>
POSTGRES_USER=<db-user>
POSTGRES_PASSWORD=<db-passwd>
POSTGRES_DB=<db-name>
POSTGRES_HOSTNAME='katpool-db' # Configure the hostname.
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOSTNAME}:5432/${POSTGRES_DB}"
DEBUG=1
TELEGRAM_BOT_TOKEN=''
UPHOLD_CLIENT_ID=''
UPHOLD_CLIENT_SECRET=''
OAUTH_STATE=''
```

## Config file

Please refer to [Crontab.guru](https://crontab.guru/) to set the cron expression.

# Configuration Parameters

- **payoutCronSchedule**  
  Cron schedule expression for payouts. If not set or invalid, it defaults to **twice a day** (`0 */12 * * *`).

- **payoutAlertCronSchedule**
  Cron schedule expression for payout alerts. If not set or invalid, it defaults to **four times a day** (`0 */6 * * *`).

- **thresholdAmount**
  Minimum miner rewards (in **sompi**) required for a payout.  
  _1 KAS = 100,000,000 sompi_.

- **nachoThresholdAmount**
  Minimum miner rewards (in **NACHO units**, including decimals) required for a payout.  
  _1 NACHO = 100,000,000 (including decimals)._  
  Example: `100000000` represents `1 NACHO`.

- **kasAlertThreshold**
  Threshold for KAS balance (in **sompi**) to trigger a Telegram alert.  
  _Alert is triggered when the balance is less than or equal to this value_.

- **nachoAlertThreshold**  
  Threshold for NACHO balance (in **NACHO units**, including decimals) to trigger a Telegram alert.  
  _Alert is triggered when the balance is less than or equal to this value_.

## Developer Tips

> 💡 **Tip:** To avoid seeing formatting commits (such as Prettier changes) in `git blame`, run:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```
