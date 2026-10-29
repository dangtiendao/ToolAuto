import { chromium, Page } from 'playwright';
import { AppConfig } from '../config/types';
import { BrowserSession, ConnectionMode, SwitchModeOptions } from './types';
import { buildPlaywrightProxy } from './proxy';
import {
  closeBrowser,
  getChromeExecutablePath,
  handleLaunchError
} from './common';
import { Logger } from '../utils/logger';
import { sanitizeUrl } from '../utils/sanitize';

/**
 * Trình quản lý trình duyệt và chế độ kết nối (Direct / Proxy).
 * Quản lý vòng đời của BrowserContext, thực hiện đóng và mở lại Persistent Context
 * khi chuyển đổi giữa Direct và Proxy mà không sử dụng framework hay lớp trừu tượng dư thừa.
 */
export class BrowserManager {
  private config: AppConfig;
  private currentMode: ConnectionMode;
  private session: BrowserSession | null = null;
  private isSwitching: boolean = false;
  private logger?: Logger;
  private activePages: Map<string, Page> = new Map();

  constructor(config: AppConfig, initialSession?: BrowserSession, logger?: Logger) {
    this.config = config;
    this.currentMode = config.initialConnectionMode || (config.proxy.enabled ? 'proxy' : 'direct');
    this.session = initialSession || null;
    this.logger = logger;
    if (initialSession && initialSession.page) {
      this.activePages.set('default', initialSession.page);
    }
  }

  /**
   * Lấy chế độ kết nối hiện tại đang hoạt động ('direct' | 'proxy').
   */
  public getConnectionMode(): ConnectionMode {
    return this.currentMode;
  }

  /**
   * Kiểm tra xem hệ thống có đang trong quá trình chuyển chế độ kết nối hay không.
   */
  public isSwitchingMode(): boolean {
    return this.isSwitching;
  }

  /**
   * Lấy phiên BrowserSession hiện tại (nếu có).
   */
  public getSession(): BrowserSession | null {
    return this.session;
  }

  /**
   * Lấy Page hiện tại của phiên Chrome đang hoạt động.
   * Runner sử dụng phương thức này để luôn làm việc với Page hợp lệ sau restart,
   * không giữ cố định tham chiếu của phiên cũ đã đóng.
   */
  public getCurrentPage(): Page {
    if (!this.session || !this.session.page || this.session.page.isClosed()) {
      throw new Error(
        '[LỖI TRÌNH DUYỆT] Trình duyệt chưa được khởi chạy hoặc Page hiện tại đã bị đóng.\n' +
        'Lưu ý: Sau khi khởi động lại Chrome để đổi proxy, các Page cũ không còn khả dụng.'
      );
    }
    return this.session.page;
  }

  /**
   * Mở một tab mới cho giai đoạn nghiệp vụ với tên định danh rõ ràng.
   */
  public async newPage(name?: string): Promise<Page> {
    if (!this.session || !this.session.context) {
      throw new Error('[LỖI TRÌNH DUYỆT] Không thể tạo tab mới vì BrowserContext chưa sẵn sàng.');
    }
    const page = await this.session.context.newPage();
    page.setDefaultTimeout(this.config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

    const tabName = name || `tab_${Date.now()}`;
    this.activePages.set(tabName, page);
    this.session.page = page; // Đặt làm tab tiêu điểm hiện tại

    this.logger?.info(`Đã tạo tab mới: [${tabName}]`, { flow: this.config.flowName });
    return page;
  }

  /**
   * Khởi chạy Google Chrome theo cấu hình đã chọn (Incognito hoặc Persistent Context).
   */
  public async initSession(): Promise<BrowserSession> {
    if (this.session && this.session.page && !this.session.page.isClosed()) {
      return this.session;
    }

    const mode = this.currentMode;
    this.session = await this.launchSession(mode);
    this.activePages.set('default', this.session.page);
    return this.session;
  }

  /**
   * Chuyển đổi chế độ kết nối ("direct" | "proxy").
   * Quy trình tuần tự, an toàn:
   * 1. Kiểm tra an toàn trạng thái.
   * 2. Nếu cùng chế độ: không restart, ghi log "Chế độ kết nối không thay đổi".
   * 3. Kiểm tra cấu hình chế độ đích TRƯỚC khi đóng Chrome.
   * 4. Đóng context hiện tại và chờ giải phóng SingletonLock.
   * 5. Vô hiệu hóa mọi tham chiếu Page/Context cũ.
   * 6. Mở persistent context mới với cùng profile, channel chrome, headless: false.
   * 7. Kiểm tra kết nối từ context Chrome mới (không dùng fetch Node.js).
   * 8. Chỉ đánh dấu thành công khi kiểm tra đạt yêu cầu.
   */
  public async switchConnectionMode(
    targetMode: ConnectionMode,
    options?: SwitchModeOptions
  ): Promise<BrowserSession> {
    // 1. Kiểm tra đang ở ranh giới an toàn, không có tiến trình chuyển khác đang chạy
    if (this.isSwitching) {
      throw new Error(
        '[LỖI CHUYỂN PROXY] Đang có một tiến trình chuyển chế độ kết nối khác đang diễn ra. Không cho phép thao tác đồng thời.'
      );
    }

    // 2. Nếu chế độ yêu cầu đã đang hoạt động: Không restart Chrome
    if (targetMode === this.currentMode && this.session && !this.session.page.isClosed()) {
      const msg = `Chế độ kết nối không thay đổi (hiện tại: "${this.currentMode}"). Bỏ qua thao tác khởi động lại Chrome.`;
      this.logger?.info(msg, { flow: this.config.flowName });
      return this.session;
    }

    // 3. Kiểm tra cấu hình chế độ đích TRƯỚC khi đóng Chrome
    if (targetMode === 'proxy') {
      const server = this.config.proxy?.server?.trim();
      if (!server) {
        throw new Error(
          '[LỖI CẤU HÌNH PROXY] Không thể chuyển sang chế độ proxy vì "proxy.server" chưa được cấu hình.\n' +
          'Phiên trình duyệt hiện tại được giữ nguyên vẹn không đóng.'
        );
      }

      // Kiểm tra tính hợp lệ của giao thức proxy
      try {
        buildPlaywrightProxy(this.config.proxy);
      } catch (validationErr) {
        throw new Error(
          `[LỖI CẤU HÌNH PROXY] Cấu hình proxy không hợp lệ: ${(validationErr as Error).message}\n` +
          'Phiên trình duyệt hiện tại được giữ nguyên vẹn không đóng.'
        );
      }
    }

    const oldMode = this.currentMode;
    this.isSwitching = true;

    this.logger?.info(
      `[CHUYỂN CHẾ ĐỘ KẾT NỐI] Bắt đầu chuyển từ chế độ "${oldMode}" sang "${targetMode}"...`,
      { flow: this.config.flowName }
    );

    // 4 & 5. Đóng context hiện tại và vô hiệu hóa tham chiếu cũ
    this.logger?.info(
      `Đang đóng phiên Chrome hiện tại (chế độ "${oldMode}") để chuẩn bị khởi động lại với profile "${this.config.selectedProfile.profileName}"...`,
      { flow: this.config.flowName }
    );

    if (this.session) {
      try {
        await closeBrowser(this.session);
      } catch (closeErr) {
        this.logger?.warn(
          `Cảnh báo khi đóng phiên Chrome cũ: ${(closeErr as Error).message}`,
          { flow: this.config.flowName }
        );
      }
      this.session = null;
    }

    // Vô hiệu hóa hoàn toàn mọi tham chiếu tab/trang cũ
    this.activePages.clear();

    // Chờ hệ điều hành Windows giải phóng file khóa SingletonLock của Chrome
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 6. Mở session mới (persistent hoặc incognito)
    this.logger?.info(
      this.config.incognito
        ? `Đang mở lại Chrome ở chế độ ẩn danh (incognito) với kết nối "${targetMode}"...`
        : `Đang mở lại Chrome ở chế độ "${targetMode}" cùng thư mục userDataDir và profileDirectory...`,
      { flow: this.config.flowName }
    );

    let newSession: BrowserSession;
    try {
      newSession = await this.launchSession(targetMode);
    } catch (launchErr) {
      this.isSwitching = false;
      // Dừng luồng, KHÔNG tự fallback sang direct, KHÔNG đánh dấu chế độ đích đã sẵn sàng
      throw new Error(
        `[LỖI CHUYỂN CHẾ ĐỘ] Khởi chạy Chrome ở chế độ "${targetMode}" thất bại:\n` +
        `  -> ${(launchErr as Error).message}\n` +
        `Quy tắc an toàn: Dừng luồng ngay lập tức, tuyệt đối KHÔNG tự động fallback sang kết nối trực tiếp.`
      );
    }

    // 7. Kiểm tra kết nối trong context mới bằng chính network stack của Chrome
    const checkUrl = options?.checkUrl || this.config.proxyCheckUrl || this.config.startUrl;
    this.logger?.info(
      `[KIỂM TRA KẾT NỐI] Đang kiểm tra kết nối từ context Chrome mới tới: ${sanitizeUrl(checkUrl)}...`,
      { flow: this.config.flowName }
    );

    try {
      const timeoutMs = options?.timeoutMs || this.config.navigationTimeoutMs;
      // Sử dụng APIRequestContext của chính context Chrome mới để request đi qua proxy/network stack của Chrome
      const response = await newSession.context.request.get(checkUrl, {
        timeout: timeoutMs
      });

      if (!response.ok()) {
        throw new Error(
          `URL kiểm tra phản hồi với mã trạng thái HTTP ${response.status()} ${response.statusText()}`
        );
      }

      // Trích xuất thông tin IP nếu máy chủ kiểm tra trả về dạng JSON hoặc IP văn bản
      let detectedIp: string | undefined;
      try {
        const text = await response.text();
        try {
          const json = JSON.parse(text);
          if (json && typeof json === 'object') {
            detectedIp = json.origin || json.ip || json.query;
          }
        } catch {
          const match = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
          if (match) {
            detectedIp = match[0];
          }
        }
      } catch {
        // Bỏ qua lỗi đọc text phản hồi
      }

      if (detectedIp) {
        this.logger?.info(
          `[KIỂM TRA KẾT NỐI] Địa chỉ IP phản hồi từ ${sanitizeUrl(checkUrl)}: ${detectedIp}`,
          { flow: this.config.flowName }
        );
        if (options?.expectedIp) {
          if (detectedIp === options.expectedIp) {
            this.logger?.info(
              `[ĐỐI CHIẾU IP] IP phát hiện (${detectedIp}) khớp với tiêu chí người dùng (${options.expectedIp}).`,
              { flow: this.config.flowName }
            );
          } else {
            this.logger?.warn(
              `[ĐỐI CHIẾU IP] IP phát hiện (${detectedIp}) khác với tiêu chí người dùng (${options.expectedIp}).`,
              { flow: this.config.flowName }
            );
          }
        }
      } else {
        this.logger?.info(
          `[KIỂM TRA KẾT NỐI] Kết nối tới ${sanitizeUrl(checkUrl)} thành công (HTTP ${response.status()}).\n` +
          `(Lưu ý: Mở trang thành công chỉ chứng minh truy cập được, không tự chứng minh IP đầu ra đúng).`,
          { flow: this.config.flowName }
        );
      }
    } catch (checkErr) {
      // Khi kiểm tra kết nối thất bại: đóng ngay phiên mới để dọn dẹp, không để lại tiến trình treo
      try {
        await closeBrowser(newSession);
      } catch {
        // ignore
      }
      this.session = null;
      this.isSwitching = false;

      // Không tự fallback sang direct, không đánh dấu chế độ đích đã sẵn sàng
      throw new Error(
        `[LỖI KẾT NỐI] Kiểm tra kết nối trong context Chrome mới ở chế độ "${targetMode}" thất bại:\n` +
        `  -> URL kiểm tra: ${sanitizeUrl(checkUrl)}\n` +
        `  -> Chi tiết lỗi: ${(checkErr as Error).message}\n` +
        `Quy tắc an toàn: Dừng luồng ngay lập tức, tuyệt đối KHÔNG tự động fallback sang kết nối trực tiếp.`
      );
    }

    // 8. Đánh dấu chuyển thành công
    this.currentMode = targetMode;
    this.session = newSession;
    this.activePages.set('default', newSession.page);
    this.isSwitching = false;

    this.logger?.info(
      `[CHUYỂN CHẾ ĐỘ THÀNH CÔNG] Chế độ cũ: "${oldMode}" -> Chế độ yêu cầu: "${targetMode}". Kết quả: Sẵn sàng.`,
      { flow: this.config.flowName }
    );

    return this.session;
  }

  /**
   * Wrapper kích hoạt chế độ proxy.
   */
  public async enableProxy(options?: SwitchModeOptions): Promise<BrowserSession> {
    return this.switchConnectionMode('proxy', options);
  }

  /**
   * Wrapper tắt proxy và chuyển về kết nối trực tiếp (direct).
   */
  public async disableProxy(options?: SwitchModeOptions): Promise<BrowserSession> {
    return this.switchConnectionMode('direct', options);
  }

  /**
   * Đóng trình duyệt an toàn.
   */
  public async close(): Promise<void> {
    if (this.session) {
      await closeBrowser(this.session);
      this.session = null;
    }
    this.activePages.clear();
  }

  /**
   * Khởi chạy phiên trình duyệt dựa trên cấu hình: Ẩn danh (Incognito) hoặc Persistent Context.
   */
  private async launchSession(mode: ConnectionMode): Promise<BrowserSession> {
    if (this.config.incognito) {
      return this.launchIncognitoSession(mode);
    }
    return this.launchPersistentSession(mode);
  }

  /**
   * Khởi chạy phiên Chrome ẩn danh (Incognito).
   * Không ghi dữ liệu/cookie lên ổ đĩa, độc lập hoàn toàn, tránh xung đột SingletonLock.
   */
  private async launchIncognitoSession(mode: ConnectionMode): Promise<BrowserSession> {
    const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const launchArgs = ['--incognito'];

    if (mode === 'direct') {
      launchArgs.push('--no-proxy-server');
    }

    const proxyOption = mode === 'proxy' && this.config.proxy?.server ? buildPlaywrightProxy(this.config.proxy) : undefined;

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      channel: 'chrome',
      executablePath: chromeExe,
      headless: false,
      args: launchArgs,
      proxy: proxyOption
    };

    let browser;
    try {
      browser = await chromium.launch(launchOptions);
    } catch (err) {
      throw handleLaunchError(err, this.config);
    }

    let context;
    try {
      context = await browser.newContext({
        viewport: null,
        proxy: proxyOption
      });
    } catch (err) {
      await browser.close().catch(() => {});
      throw handleLaunchError(err, this.config);
    }

    context.setDefaultTimeout(this.config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

    const page = await context.newPage();
    page.setDefaultTimeout(this.config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

    return {
      browser,
      context,
      page,
      executablePath: chromeExe,
      isCdp: false,
      isIncognito: true
    };
  }

  /**
   * Khởi chạy persistent context của Chrome với cấu hình rõ ràng cho từng chế độ.
   */
  private async launchPersistentSession(mode: ConnectionMode): Promise<BrowserSession> {
    const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const profileDirName = this.config.selectedProfile.profileDirectory;
    const userDataDir = this.config.selectedProfile.userDataDir;

    const launchArgs = [`--profile-directory=${profileDirName}`];

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      channel: 'chrome',
      executablePath: chromeExe,
      headless: false,
      viewport: null,
      args: launchArgs
    };

    if (mode === 'proxy') {
      launchOptions.proxy = buildPlaywrightProxy(this.config.proxy);
    } else {
      // Chế độ direct: cấu hình kết nối trực tiếp rõ ràng, không bị proxy hệ thống chi phối
      launchArgs.push('--no-proxy-server');
    }

    let context;
    try {
      context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    } catch (err) {
      throw handleLaunchError(err, this.config);
    }

    context.setDefaultTimeout(this.config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    page.setDefaultTimeout(this.config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

    // Đóng các tab dư thừa nếu có khi khởi chạy
    for (let i = 1; i < pages.length; i++) {
      await pages[i].close().catch(() => {});
    }

    return {
      context,
      page,
      executablePath: chromeExe,
      isCdp: false,
      isIncognito: false
    };
  }
}

/**
 * Các hàm wrapper tiện ích độc lập (Interface theo yêu cầu Mục 3)
 */
export function getConnectionMode(manager: BrowserManager): ConnectionMode {
  return manager.getConnectionMode();
}

export function switchConnectionMode(
  manager: BrowserManager,
  targetMode: ConnectionMode,
  options?: SwitchModeOptions
): Promise<BrowserSession> {
  return manager.switchConnectionMode(targetMode, options);
}

export function enableProxy(
  manager: BrowserManager,
  options?: SwitchModeOptions
): Promise<BrowserSession> {
  return manager.enableProxy(options);
}

export function disableProxy(
  manager: BrowserManager,
  options?: SwitchModeOptions
): Promise<BrowserSession> {
  return manager.disableProxy(options);
}
