import http from 'http';
import { chromium } from 'playwright';
import { getChromeExecutablePath } from '../src/browser/common';

async function testChromeWithProxy(server: string, username: string, password: string) {
  console.log(`\nTesting Chrome with proxy: ${server} (user: ${username})...`);
  const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  try {
    const browser = await chromium.launch({
      executablePath: chromeExe,
      headless: true,
      proxy: {
        server,
        username,
        password
      }
    });
    const context = await browser.newContext({
      proxy: {
        server,
        username,
        password
      }
    });
    const page = await context.newPage();
    const res = await page.goto('https://httpbin.org/ip', { timeout: 15000 });
    const text = await res?.text();
    console.log(`[CHROME PROXY SUCCESS] ${server} response:`, text);
    await browser.close();
  } catch (err: any) {
    console.log(`[CHROME PROXY ERROR] ${server} ->`, err.message);
  }
}

async function main() {
  await testChromeWithProxy('http://103.82.194.227:17833', 'z53l', 'z53l');
  await testChromeWithProxy('http://103.82.25.199:14553', 'j8v0', 'j8v0');
}

main();
