# katpool-payment for kaspa WASM mining pool

Check [katpool-app](https://github.com/argonmining/katpool-app) repo for details 

## Download Kaspa WASM
** IMPORTANT **
Before anything, add wasm foolder to the local folder
You can download the latest form here: https://kaspa.aspectron.org/nightly/downloads/ move nodejs to the repo folder as wasm
unzip, rename and move `nodejs` that contains `kaspa` and kaspa-dev` to `wasm` folder locally.

## Create env variables
create .env file
```
TREASURY_PRIVATE_KEY=<private key>
POSTGRES_USER=<db-user>
POSTGRES_PASSWORD=<db-passwd>
POSTGRES_DB=<db-name>
POSTGRES_HOSTNAME='katpool-db' # Configure the hostname.
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOSTNAME}:5432/${POSTGRES_DB}"
PUSHGATEWAY="http://katpool-pushgateway:9091" # Configure the pushgateway url.
DEBUG=1
```

## Config file

Please refer to [Crontab.guru](https://crontab.guru/) to set the cron expression.

* **payoutCronSchedule**: cron schedule expression for payout. If not set or invalid, it will be defaulted to Twice a day (* */12 * * *).

* **thresholdAmount**: Miner rewards will be paid above this minimum amount in sompi.
