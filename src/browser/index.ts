import * as fs from 'fs';
import { spawn } from 'child_process';
import { chromium, BrowserContext, Browser } from 'playwright';
import { AppConfig } from '../config/types';
import { BrowserSession, ConnectionMode } from './types';
import { buildPlaywrightProxy } from './proxy';
import {
  isCdpAvailable,
  getChromeExecutablePath,
  confirmProfileCreation,
  handleLaunchError,
  closeBrowser,
  waitForEnter,
  LaunchBrowserOptions
} from './common';

export interface ExtendedLaunchBrowserOptions extends LaunchBrowserOptions {
  connectionMode?: ConnectionMode;
}

/**
 * Khởi chạy Google Chrome hoặc kết nối vào phiên Chrome có sẵn qua CDP theo Profile đã chọn.
 */
export async function launchBrowser(
  config: AppConfig,
  options?: ExtendedLaunchBrowserOptions
): Promise<BrowserSession> {
  const profileFullPath = config.selectedProfile.fullPath;
  const cdpPort = config.selectedProfile.cdpPort || 9222;
  const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  // Xác định chế độ kết nối ban đầu
  const effectiveMode: ConnectionMode =
    options?.connectionMode ||
    config.initialConnectionMode ||
    (config.proxy.enabled ? 'proxy' : 'direct');

  // Khởi chạy chế độ Incognito nếu cấu hình incognito = true
  if (config.incognito) {
    const launchArgs = ['--incognito'];
    if (effectiveMode === 'direct') {
      launchArgs.push('--no-proxy-server');
    }
    const proxyOption = effectiveMode === 'proxy' && config.proxy.server ? buildPlaywrightProxy(config.proxy) : undefined;
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      channel: 'chrome',
      executablePath: chromeExe,
      headless: false,
      args: launchArgs,
      proxy: proxyOption
    };
    let browser: Browser;
    try {
      browser = await chromium.launch(launchOptions);
    } catch (err) {
      throw handleLaunchError(err, config);
    }
    let context: BrowserContext;
    try {
      context = await browser.newContext({ viewport: null, proxy: proxyOption });
    } catch (err) {
      await browser.close().catch(() => {});
      throw handleLaunchError(err, config);
    }
    context.setDefaultTimeout(config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    const page = await context.newPage();
    page.setDefaultTimeout(config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    try {
      await page.goto(config.startUrl, {
        timeout: config.navigationTimeoutMs,
        waitUntil: 'domcontentloaded'
      });
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
    return { browser, context, page, executablePath: chromeExe, isCdp: false, isIncognito: true };
  }

  // 1. Kiểm tra xem cổng CDP đã được mở sẵn hay chưa
  let cdpReady = await isCdpAvailable(cdpPort);

  // 2. Nếu cổng chưa mở, thử khởi chạy Chrome với cờ remote-debugging-port
  if (!cdpReady) {
    // Nếu dùng profile ngoài Chrome mặc định và profile chưa có, hỏi xác nhận
    if (!fs.existsSync(profileFullPath)) {
      const confirmed = await confirmProfileCreation(
        config.selectedProfile.profileName,
        profileFullPath,
        options
      );

      if (!confirmed) {
        throw new Error(
          `[LỖI PROFILE CHƯA TỒN TẠI] Profile "${config.selectedProfile.profileName}" chưa tồn tại tại đường dẫn:\n` +
          `  -> ${profileFullPath}\n` +
          `Hệ thống đã dừng lại vì chưa nhận được xác nhận khởi tạo profile mới từ người dùng.\n` +
          `Hướng dẫn: Vui lòng kiểm tra lại cấu hình "profiles" trong config/config.json.`
        );
      }

      fs.mkdirSync(profileFullPath, { recursive: true });
    }

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--profile-directory=${config.selectedProfile.profileDirectory}`,
      `--user-data-dir=${config.selectedProfile.userDataDir}`
    ];

    if (effectiveMode === 'proxy' && config.proxy.server) {
      args.push(`--proxy-server=${config.proxy.server}`);
      if (config.proxy.bypass) {
        args.push(`--proxy-bypass-list=${config.proxy.bypass}`);
      }
    } else {
      args.push('--no-proxy-server');
    }

    try {
      const child = spawn(chromeExe, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    } catch {
      // Bỏ qua lỗi spawn để kiểm tra tiếp
    }

    // Chờ cổng CDP mở trong tối đa 5 giây
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      if (await isCdpAvailable(cdpPort)) {
        cdpReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // 3. Nếu CDP đã sẵn sàng: kết nối qua CDP (sử dụng trực tiếp phiên Chrome thật của người dùng)
  if (cdpReady) {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch (err) {
      throw handleLaunchError(err, config);
    }

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

    context.setDefaultTimeout(config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    // Mở trang chính
    const page = await context.newPage();
    page.setDefaultTimeout(config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    try {
      await page.goto(config.startUrl, {
        timeout: config.navigationTimeoutMs,
        waitUntil: 'domcontentloaded'
      });
    } catch (err) {
      if (effectiveMode === 'proxy') {
        throw new Error(
          `[LỖI KẾT NỐI PROXY] Không thể tải trang ban đầu (${config.startUrl}) qua proxy (${config.proxy.server}):\n` +
          `  -> ${(err as Error).message}\n` +
          `Hệ thống giữ nguyên cấu hình và KHÔNG tự động chuyển sang kết nối trực tiếp.`
        );
      }
      throw new Error(`[LỖI TẢI TRANG] Không thể mở URL ban đầu (${config.startUrl}): ${(err as Error).message}`);
    }

    return { context, page, browser, executablePath: chromeExe, isCdp: true };
  }

  // 4. Nếu chưa có phiên CDP: Tự động khởi chạy Google Chrome chính thức qua Persistent Context
  const launchArgs = [`--profile-directory=${config.selectedProfile.profileDirectory}`];
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    channel: 'chrome',
    executablePath: chromeExe,
    headless: false,
    viewport: null,
    args: launchArgs
  };

  if (effectiveMode === 'proxy' && config.proxy.server) {
    launchOptions.proxy = buildPlaywrightProxy(config.proxy);
  } else {
    // Chế độ direct: cấu hình kết nối trực tiếp rõ ràng, không bị proxy hệ thống chi phối
    launchArgs.push('--no-proxy-server');
  }

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.selectedProfile.userDataDir, launchOptions);
  } catch (err) {
    throw handleLaunchError(err, config);
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  page.setDefaultTimeout(config.actionTimeoutMs);
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }

  try {
    await page.goto(config.startUrl, {
      timeout: config.navigationTimeoutMs,
      waitUntil: 'domcontentloaded'
    });
  } catch (err) {
    await closeBrowser(context);
    throw err;
  }

  return { context, page, executablePath: chromeExe, isCdp: false };
}

export * from './types';
export * from './proxy';
export * from './common';
export * from './manager';
