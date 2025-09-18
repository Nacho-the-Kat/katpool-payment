# katpool-payment for kaspa WASM mining pool

Check [katpool-app](https://github.com/argonmining/katpool-app) repo for details

## Download Kaspa WASM SDK

**Note:** This setup is intended for **local development only**.

### Steps:

1. Download the latest Kaspa WASM SDK from the official Rusty-Kaspa GitHub releases:
   [rusty-kaspa/releases](https://github.com/kaspanet/rusty-kaspa/releases)

2. Locate and download the file named:
   kaspa-wasm32-sdk-<LATEST_VERSION>.zip

Example: `kaspa-wasm32-sdk-v1.0.0.zip`

3. Extract the archive and locate the `nodejs` directory inside it.

4. Rename the extracted `nodejs` folder to `wasm` and place it inside your project repository.

The folder should contain:

- `kaspa`
- `kaspa-dev`

5. Ensure that the import paths in your code correctly reference the local `wasm` folder.

## Config file

Please refer to [Crontab.guru](https://crontab.guru/) to set the cron expression.

# Configuration Parameters

- **payoutCronSchedule**  
  Cron schedule expression for payouts. If not set or invalid, it defaults to **twice a day** (`*/15 * * * *`).

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
