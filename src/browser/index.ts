import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { chromium, BrowserContext, Browser } from 'playwright';
import { AppConfig } from '../config/types';
import { BrowserSession } from './types';
import { buildPlaywrightProxy } from './proxy';

export interface LaunchBrowserOptions {
  autoConfirmNewProfile?: boolean;
  confirmNewProfileHandler?: (profileName: string, profilePath: string) => Promise<boolean>;
  fallbackToPersistentContext?: boolean;
}

/**
 * Kiểm tra xem cổng Chrome Remote Debugging Protocol (CDP) có đang phản hồi hay không.
 */
export function isCdpAvailable(port: number = 9222, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const req = http.get(`http://${host}:${port}/json/version`, (res) => {
      res.resume();
      finish(res.statusCode === 200);
    });
    req.on('error', () => finish(false));
    req.setTimeout(1000, () => {
      req.destroy();
      finish(false);
    });
  });
}

/**
 * Tìm và trả về đường dẫn file thực thi Google Chrome chính thức trên Windows.
 */
export function getChromeExecutablePath(): string | undefined {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : ''
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Xử lý xác nhận của người dùng trước khi khởi tạo thư mục profile mới trên đĩa (khi dùng profile riêng).
 */
export async function confirmProfileCreation(
  profileName: string,
  profileFullPath: string,
  options?: LaunchBrowserOptions
): Promise<boolean> {
  if (options?.autoConfirmNewProfile !== undefined) {
    return options.autoConfirmNewProfile;
  }

  if (options?.confirmNewProfileHandler) {
    return await options.confirmNewProfileHandler(profileName, profileFullPath);
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise<boolean>((resolve) => {
      rl.question(
        `\n[XÁC NHẬN KHỞI TẠO PROFILE]\n` +
        `Profile "${profileName}" chưa tồn tại tại đường dẫn:\n  -> ${profileFullPath}\n` +
        `Bạn có chắc chắn muốn khởi tạo profile mới tại đây không? (y/N): `,
        (answer) => {
          rl.close();
          const normalized = answer.trim().toLowerCase();
          resolve(normalized === 'y' || normalized === 'yes');
        }
      );
    });
  }

  return false;
}

/**
 * Xử lý và chuyển đổi các lỗi khởi tạo trình duyệt thành thông báo thân thiện.
 */
export function handleLaunchError(error: unknown, config: AppConfig): Error {
  const msg = error instanceof Error ? error.message : String(error);

  if (
    msg.includes('Opening in existing browser session') ||
    msg.includes('profile is already in use') ||
    msg.includes('SingletonLock') ||
    msg.includes('EBUSY') ||
    msg.includes('ProcessSingleton')
  ) {
    const profileName = config.selectedProfile?.profileName || 'mặc định';
    const userDataDir = config.selectedProfile?.userDataDir || config.profileDir;
    const profileDirName = config.selectedProfile?.profileDirectory || '';

    return new Error(
      `[LỖI PROFILE] Thư mục profile đang được một tiến trình Chrome khác sử dụng hoặc bị khóa:\n` +
      `  -> Thư mục gốc (userDataDir): ${userDataDir}\n` +
      `  -> Profile: ${profileDirName} (Tên cấu hình profileName: "${profileName}")\n` +
      `Cách xử lý:\n` +
      `  - Vui lòng đóng tất cả cửa sổ Chrome đang chạy sử dụng thư mục dữ liệu này, hoặc\n` +
      `  - Khởi chạy Chrome với cờ: chrome.exe --remote-debugging-port=${config.selectedProfile?.cdpPort || 9222}\n` +
      `Lưu ý: Hệ thống tuân thủ nguyên tắc an toàn: tuyệt đối không tự động kill các tiến trình Chrome khác, không tự xóa file khóa (SingletonLock) và không tự chuyển sang profile tạm.`
    );
  }

  if (
    msg.includes('channel "chrome"') ||
    msg.includes("Executable doesn't exist") ||
    msg.includes('Cannot find Chrome')
  ) {
    return new Error(
      `[LỖI TRÌNH DUYỆT] Không tìm thấy Google Chrome chính thức trên hệ thống.\n` +
      `Vui lòng đảm bảo Google Chrome đã được cài đặt trên máy Windows của bạn.`
    );
  }

  if (
    config.proxy.enabled &&
    (msg.includes('ERR_PROXY_') || msg.includes('ERR_TUNNEL_') || msg.includes('ECONNREFUSED'))
  ) {
    return new Error(
      `[LỖI KẾT NỐI PROXY] Không thể kết nối thông qua máy chủ proxy (${config.proxy.server}):\n` +
      `  -> ${msg}\n` +
      `Lưu ý: Để đảm bảo an toàn, hệ thống tuyệt đối KHÔNG tự động chuyển sang kết nối trực tiếp khi proxy lỗi.`
    );
  }

  return new Error(`[LỖI KHỞI ĐỘNG CHROME] ${msg}`);
}

/**
 * Khởi chạy Google Chrome hoặc kết nối vào phiên Chrome có sẵn qua CDP theo Profile đã chọn.
 */
export async function launchBrowser(
  config: AppConfig,
  options?: LaunchBrowserOptions
): Promise<BrowserSession> {
  const profileFullPath = config.selectedProfile.fullPath;
  const cdpPort = config.selectedProfile.cdpPort || 9222;
  const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

    if (config.proxy.enabled && config.proxy.server) {
      args.push(`--proxy-server=${config.proxy.server}`);
      if (config.proxy.bypass) {
        args.push(`--proxy-bypass-list=${config.proxy.bypass}`);
      }
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
      if (config.proxy.enabled) {
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
  // Đảm bảo mở chính xác C:\Program Files\Google\Chrome\Application\chrome.exe kèm Profile đã chọn
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    channel: 'chrome',
    executablePath: chromeExe,
    headless: false,
    viewport: null,
    args: [`--profile-directory=${config.selectedProfile.profileDirectory}`]
  };

  if (config.proxy.enabled) {
    launchOptions.proxy = buildPlaywrightProxy(config.proxy);
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

/**
 * Đóng Browser / BrowserContext an toàn.
 */
export async function closeBrowser(
  contextOrSession: BrowserContext | BrowserSession | null | undefined
): Promise<void> {
  if (!contextOrSession) return;

  try {
    if ('context' in contextOrSession) {
      if (contextOrSession.page && !contextOrSession.page.isClosed()) {
        await contextOrSession.page.close().catch(() => {});
      }
      if (contextOrSession.isCdp && contextOrSession.browser) {
        await contextOrSession.browser.close().catch(() => {});
      } else if (contextOrSession.context) {
        await contextOrSession.context.close().catch(() => {});
      }
    } else {
      await contextOrSession.close().catch(() => {});
    }
  } catch (err) {
    console.error('[CẢNH BÁO] Lỗi khi đóng BrowserContext:', (err as Error).message);
  }
}

/**
 * Tạm dừng và chờ người dùng nhấn Enter trên terminal trước khi đóng trình duyệt.
 */
export function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise<void>((resolve) => {
    rl.question('\n[INFO] Trình duyệt đang mở. Nhấn phím Enter để đóng kết nối trình duyệt...', () => {
      rl.close();
      resolve();
    });
  });
}

export * from './types';
export * from './proxy';
