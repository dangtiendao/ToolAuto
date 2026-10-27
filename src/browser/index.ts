import * as fs from 'fs';
import * as readline from 'readline';
import { chromium, BrowserContext } from 'playwright';
import { AppConfig } from '../config/types';
import { BrowserSession } from './types';
import { buildPlaywrightProxy } from './proxy';

/**
 * Xử lý và chuyển đổi các lỗi khởi tạo trình duyệt thành thông báo thân thiện, dễ hiểu.
 * Không tự ý tiêu diệt (kill) bất kỳ tiến trình Chrome nào đang chạy.
 */
export function handleLaunchError(error: unknown, config: AppConfig): Error {
  const msg = error instanceof Error ? error.message : String(error);

  if (
    msg.includes('Opening in existing browser session') ||
    msg.includes('profile is already in use') ||
    msg.includes('SingletonLock') ||
    msg.includes('EBUSY')
  ) {
    return new Error(
      `[LỖI PROFILE] Thư mục profile đang được một tiến trình Chrome khác sử dụng hoặc bị khóa:\n` +
      `  -> ${config.profileDir}\n` +
      `Cách xử lý:\n` +
      `  - Vui lòng đóng cửa sổ Chrome đang chạy sử dụng profile này, hoặc\n` +
      `  - Đổi tên thư mục profileDir trong config/config.json sang một tên khác.\n` +
      `Lưu ý: Hệ thống tuân thủ nguyên tắc không tự động kill các tiến trình Chrome khác trên máy.`
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

  if (config.proxy.enabled && (msg.includes('ERR_PROXY_') || msg.includes('ERR_TUNNEL_') || msg.includes('ECONNREFUSED'))) {
    return new Error(
      `[LỖI KẾT NỐI PROXY] Không thể kết nối thông qua máy chủ proxy (${config.proxy.server}):\n` +
      `  -> ${msg}\n` +
      `Lưu ý: Để đảm bảo an toàn, hệ thống tuyệt đối KHÔNG tự động chuyển sang kết nối trực tiếp khi proxy lỗi.`
    );
  }

  return new Error(`[LỖI KHỞI ĐỘNG CHROME] ${msg}`);
}

/**
 * Khởi chạy Google Chrome với profile riêng biệt và cấu hình đã định nghĩa.
 */
export async function launchBrowser(config: AppConfig): Promise<BrowserSession> {
  // 1. Đảm bảo thư mục profile tồn tại
  if (!fs.existsSync(config.profileDir)) {
    fs.mkdirSync(config.profileDir, { recursive: true });
  }

  // 2. Thiết lập cấu hình khởi chạy
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    channel: 'chrome',
    headless: false,
    viewport: null
  };

  // 3. Xử lý proxy theo cấu hình
  if (config.proxy.enabled) {
    launchOptions.proxy = buildPlaywrightProxy(config.proxy);
  }

  // 4. Khởi động persistent context
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, launchOptions);
  } catch (err) {
    throw handleLaunchError(err, config);
  }

  try {
    // 5. Áp dụng timeout cho Context
    context.setDefaultTimeout(config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    // 6. Đảm bảo chỉ dùng duy nhất 1 page chính
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    page.setDefaultTimeout(config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    // Đóng các page phụ khác nếu Chrome tự mở thừa
    for (let i = 1; i < pages.length; i++) {
      await pages[i].close().catch(() => {});
    }

    // 7. Mở startUrl để kiểm tra kết nối ban đầu
    await page.goto(config.startUrl, {
      timeout: config.navigationTimeoutMs,
      waitUntil: 'domcontentloaded'
    });

    return { context, page };
  } catch (err) {
    // Nếu điều hướng ban đầu thất bại, đóng context an toàn và ném lỗi rõ ràng
    await closeBrowser(context);

    if (config.proxy.enabled) {
      throw new Error(
        `[LỖI KẾT NỐI PROXY] Không thể tải trang ban đầu (${config.startUrl}) qua proxy (${config.proxy.server}):\n` +
        `  -> ${(err as Error).message}\n` +
        `Hệ thống giữ nguyên cấu hình và KHÔNG tự động chuyển sang kết nối trực tiếp.`
      );
    }

    throw new Error(
      `[LỖI TẢI TRANG] Không thể mở URL ban đầu (${config.startUrl}): ${(err as Error).message}`
    );
  }
}

/**
 * Đóng BrowserContext an toàn.
 */
export async function closeBrowser(context: BrowserContext | null | undefined): Promise<void> {
  if (context) {
    try {
      await context.close();
    } catch (err) {
      console.error('[CẢNH BÁO] Lỗi khi đóng BrowserContext:', (err as Error).message);
    }
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
    rl.question('\n[INFO] Trình duyệt đang mở. Nhấn phím Enter để đóng trình duyệt...', () => {
      rl.close();
      resolve();
    });
  });
}

export * from './types';
export * from './proxy';
