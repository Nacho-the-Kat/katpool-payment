import Monitoring from '../../monitoring/index.ts';
import puppeteer from 'puppeteer';

const quoteURL = 'https://api.kaspa.com/api/floor-price?ticker=NACHO';

const monitoring = new Monitoring();

export default class swapToKrc20 {
  /**
   * Calculates the equivalent amount of NACHO that can be obtained for a given KAS balance based on market rates.
   * This determines the amount of NACHO to be distributed in the current payment cycle.
   *
   * @param balance - The amount of KAS (in bigint) to be swapped for NACHO.
   * @returns The equivalent amount of NACHO
   */
  async swapKaspaToKRC(balance: bigint) {
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage();

    // Set realistic headers to avoid bot detection
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
    );
    await page.setExtraHTTPHeaders({
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://kaspa.com/',
    });

    await page.goto(quoteURL, { waitUntil: 'networkidle0' });

    const response = {
      data: await page.evaluate(() => {
        const bodyText = document.body.innerText.trim();
        try {
          return JSON.parse(bodyText);
        } catch (e) {
          monitoring.error(`swapKaspaToKRC: Page content: ${bodyText}`);
          throw new Error('Not JSON response');
        }
      }),
    };

    await browser.close();

    const floorPrice = Number(response.data[0]?.floor_price);
    monitoring.log(`swapKaspaToKRC: floor price ${floorPrice}`);

    return BigInt(Math.floor(Number(balance) / floorPrice));
  }
}
