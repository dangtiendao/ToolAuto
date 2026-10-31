import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as readline from 'readline';
import { BrowserSession } from './types';
import { BrowserContext } from 'playwright';
import { AppConfig, WindowSizeConfig, WindowPositionConfig } from '../config/types';

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
    (config.proxy.enabled || config.proxy.server) &&
    (msg.includes('ERR_PROXY_') || msg.includes('ERR_TUNNEL_') || msg.includes('ECONNREFUSED'))
  ) {
    return new Error(
      `[LỖI KẾT NỐI PROXY] Không thể kết nối thông qua máy chủ proxy (${config.proxy.server || 'chưa xác định'}):\n` +
      `  -> ${msg}\n` +
      `Lưu ý: Để đảm bảo an toàn, hệ thống tuyệt đối KHÔNG tự động chuyển sang kết nối trực tiếp khi proxy lỗi.`
    );
  }

  return new Error(`[LỖI KHỞI ĐỘNG CHROME] ${msg}`);
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
      if (contextOrSession.browser) {
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

/**
 * Xây dựng danh sách tham số dòng lệnh Chrome để điều chỉnh kích thước và vị trí cửa sổ.
 */
export function buildWindowArgs(
  windowSize?: WindowSizeConfig,
  windowPosition?: WindowPositionConfig
): string[] {
  const args: string[] = [];
  if (windowSize) {
    if (windowSize === 'maximized') {
      args.push('--start-maximized');
    } else {
      args.push(`--window-size=${windowSize.width},${windowSize.height}`);
    }
  }
  if (windowPosition) {
    args.push(`--window-position=${windowPosition.x},${windowPosition.y}`);
  }
  return args;
}
