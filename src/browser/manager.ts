import { chromium, Page } from 'playwright';
import { AppConfig, ProxyConfig } from '../config/types';
import { BrowserSession, ConnectionMode, SwitchModeOptions } from './types';
import { buildPlaywrightProxy } from './proxy';
import {
  closeBrowser,
  getChromeExecutablePath,
  handleLaunchError,
  buildWindowArgs
} from './common';
import { Logger } from '../utils/logger';
import { sanitizeUrl } from '../utils/sanitize';
import { safeRequestGet } from './navigation';

/**
 * Trình quản lý trình duyệt và chế độ kết nối (Direct / Proxy).
 * Quản lý vòng đời của BrowserContext, thực hiện đóng và mở lại Persistent Context
 * khi chuyển đổi giữa Direct và Proxy mà không sử dụng framework hay lớp trừu tượng dư thừa.
 */
export class BrowserManager {
  private config: AppConfig;
  private currentMode: ConnectionMode;
  private currentProxyConfig?: ProxyConfig;
  private session: BrowserSession | null = null;
  private isSwitching: boolean = false;
  private logger?: Logger;
  private activePages: Map<string, Page> = new Map();

  constructor(config: AppConfig, initialSession?: BrowserSession, logger?: Logger) {
    this.config = config;
    this.currentMode = config.initialConnectionMode || (config.proxy.enabled ? 'proxy' : 'direct');
    this.currentProxyConfig = this.currentMode === 'proxy' ? config.proxy : undefined;
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
   * Lấy cấu hình proxy hiện tại đang hoạt động (nếu có).
   */
  public getProxyConfig(): ProxyConfig | undefined {
    return this.currentProxyConfig;
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
   * Đăng ký một Page cụ thể vào bộ quản lý tab với tên định danh.
   */
  public registerPage(name: string, page: Page): void {
    this.activePages.set(name, page);
    if (this.session) {
      this.session.page = page;
    }
    this.logger?.info(`Đã đăng ký tab [${name}] vào bộ quản lý tab.`, { flow: this.config.flowName });
  }

  /**
   * Lấy Page theo tên định danh từ bộ quản lý tab (nếu còn mở).
   */
  public getPage(name: string): Page | undefined {
    const page = this.activePages.get(name);
    if (page && typeof page.isClosed === 'function' && page.isClosed()) {
      this.activePages.delete(name);
      return undefined;
    }
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
    const initialProxy = mode === 'proxy' ? this.config.proxy : undefined;
    this.session = await this.launchSession(mode, initialProxy);
    this.currentProxyConfig = initialProxy;
    this.activePages.set('default', this.session.page);

    // Xác minh kết nối proxy ban đầu nếu đang ở chế độ proxy
    if (mode === 'proxy' && initialProxy?.server) {
      const checkUrl = this.config.proxyCheckUrl || 'https://httpbin.org/ip';
      let outboundIp = '';
      try {
        const timeoutMs = Math.min(this.config.navigationTimeoutMs, 15000);
        const res = await safeRequestGet(this.session.context.request, checkUrl, {
          timeout: timeoutMs,
          maxRetries: this.config.pageLoadMaxRetries,
          retryDelayMs: this.config.pageLoadRetryDelayMs,
          logger: this.logger
        });
        if (res.ok()) {
          const body = await res.json().catch(() => null);
          if (body && typeof body.origin === 'string') {
            outboundIp = body.origin;
          }
        }
      } catch (checkErr) {
        // Nếu proxy chết, dừng ngay theo quy tắc an toàn, tuyệt đối không tự fallback sang direct
        await this.close();
        throw new Error(
          `[LỖI KẾT NỐI PROXY BAN ĐẦU] Không thể kết nối qua proxy mặc định (Loại 1: ${sanitizeUrl(initialProxy.server)}).\n` +
          `  -> URL kiểm tra: ${sanitizeUrl(checkUrl)}\n` +
          `  -> Chi tiết lỗi: ${(checkErr as Error).message}\n` +
          `Quy tắc an toàn: Dừng luồng ngay lập tức, tuyệt đối KHÔNG tự động fallback sang kết nối trực tiếp (IP máy).`
        );
      }

      const ipLogNotice = outboundIp ? ` [IP đầu ra thực tế: ${outboundIp}]` : '';
      this.logger?.info(
        `[XÁC MINH PROXY BAN ĐẦU] Chrome đã kết nối qua Proxy Loại 1 (${sanitizeUrl(initialProxy.server)})${ipLogNotice}.`,
        { flow: this.config.flowName }
      );
      console.log(`\n===============================================================`);
      console.log(`[XÁC MINH PROXY BAN ĐẦU - PROXY MẶC ĐỊNH (LOẠI 1)]`);
      console.log(`-> Proxy server: ${sanitizeUrl(initialProxy.server)}`);
      if (outboundIp) {
        console.log(`-> IP đầu ra thực tế của Chrome: ${outboundIp}`);
      }
      console.log(`-> Trạng thái: ĐÃ KẾT NỐI QUA PROXY THÀNH CÔNG (Không dùng IP máy)`);
      console.log(`===============================================================\n`);
    }

    return this.session;
  }

  /**
   * Chuyển đổi chế độ kết nối ("direct" | "proxy").
   * Quy trình tuần tự, an toàn:
   * 1. Kiểm tra an toàn trạng thái.
   * 2. Nếu cùng chế độ và cùng cấu hình proxy: không restart, ghi log "Chế độ kết nối không thay đổi".
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

    // Xác định cấu hình proxy đích (nếu chuyển sang proxy)
    const targetProxy =
      options?.proxyConfig ||
      (targetMode === 'proxy' ? this.config.proxy : undefined);

    const isSameMode = targetMode === this.currentMode;
    const isSameProxy = targetMode === 'proxy'
      ? (this.currentProxyConfig?.server === targetProxy?.server &&
         this.currentProxyConfig?.username === targetProxy?.username &&
         this.currentProxyConfig?.password === targetProxy?.password)
      : true;

    // 2. Nếu chế độ yêu cầu và cấu hình proxy đã đang hoạt động: Không restart Chrome (no-op)
    if (isSameMode && isSameProxy && !options?.forceRestart) {
      const msg = `Chế độ kết nối không thay đổi (hiện tại: "${this.currentMode}"). Bỏ qua thao tác khởi động lại Chrome.`;
      this.logger?.info(msg, { flow: this.config.flowName });
      return this.session!;
    }

    // 2.1. Kiểm tra cấu hình chế độ đích TRƯỚC khi thực hiện
    if (targetMode === 'proxy') {
      const server = targetProxy?.server?.trim();
      if (!server) {
        throw new Error(
          '[LỖI CẤU HÌNH PROXY] Không thể chuyển sang chế độ proxy vì "proxy.server" chưa được cấu hình.\n' +
          'Phiên trình duyệt hiện tại được giữ nguyên vẹn không đóng.'
        );
      }

      // Kiểm tra tính hợp lệ của giao thức proxy
      try {
        buildPlaywrightProxy(targetProxy!);
      } catch (validationErr) {
        throw new Error(
          `[LỖI CẤU HÌNH PROXY] Cấu hình proxy không hợp lệ: ${(validationErr as Error).message}\n` +
          'Phiên trình duyệt hiện tại được giữ nguyên vẹn không đóng.'
        );
      }
    }

    // 2.2. Xử lý chuyển đổi proxy cho phiên ẩn danh (Incognito) - Giải pháp 2:
    // Giữ nguyên cửa sổ trình duyệt Chrome, tạo BrowserContext mới với proxy và đồng bộ cookie phiên làm việc
    const isIncognitoMode = Boolean(this.config.incognito || this.session?.isIncognito);
    if (isIncognitoMode) {
      if (this.session?.browser && this.session.browser.isConnected()) {
        this.isSwitching = true;
        this.logger?.info(
          `[CHUYỂN PROXY ẨN DANH] Giữ nguyên cửa sổ Chrome, tạo context mới với kết nối "${targetMode}" (${targetProxy?.server || 'direct'}) và đồng bộ cookie phiên làm việc...`,
          { flow: this.config.flowName }
        );

        const oldContext = this.session.context;
        let storageState: any = undefined;
        try {
          storageState = await oldContext.storageState();
        } catch {
          // bỏ qua nếu không trích xuất được storageState
        }

        let oldCookies: any[] = [];
        if (!storageState) {
          try {
            oldCookies = await oldContext.cookies();
          } catch {
            // bỏ qua nếu không đọc được cookie
          }
        }

        const proxyOption =
          targetMode === 'proxy' && targetProxy?.server
            ? buildPlaywrightProxy(targetProxy)
            : undefined;

        let newContext;
        try {
          const contextOptions: any = {
            viewport: null,
            proxy: proxyOption
          };
          if (storageState) {
            contextOptions.storageState = storageState;
          }

          newContext = await this.session.browser.newContext(contextOptions);
          newContext.setDefaultTimeout(this.config.actionTimeoutMs);
          newContext.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

          if (!storageState && oldCookies && oldCookies.length > 0) {
            await newContext.addCookies(oldCookies).catch(() => {});
          }
        } catch (err) {
          this.isSwitching = false;
          throw new Error(
            `[LỖI CHUYỂN CHẾ ĐỘ ẨN DANH] Không thể tạo context mới với proxy: ${(err as Error).message}`
          );
        }

        const newPage = await newContext.newPage();
        newPage.setDefaultTimeout(this.config.actionTimeoutMs);
        newPage.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

        // Đóng context cũ sau khi context mới đã sẵn sàng
        try {
          await oldContext.close();
        } catch {
          // bỏ qua
        }

        this.activePages.clear();
        this.activePages.set('default', newPage);
        this.activePages.set('TabB', newPage);

        const newSession: BrowserSession = {
          browser: this.session.browser,
          context: newContext,
          page: newPage,
          executablePath: this.session.executablePath,
          isCdp: false,
          isIncognito: true
        };

        // Kiểm tra kết nối từ context mới nếu được cấu hình
        const checkUrl = options?.checkUrl || this.config.proxyCheckUrl || this.config.startUrl || 'https://www.google.com';
        this.logger?.info(
          `[KIỂM TRA KẾT NỐI] Đang kiểm tra kết nối từ context Chrome mới tới: ${sanitizeUrl(checkUrl)}...`,
          { flow: this.config.flowName }
        );

        let outboundIp = '';
        try {
          const timeoutMs = options?.timeoutMs || this.config.navigationTimeoutMs;
          const response = await safeRequestGet(newSession.context.request, checkUrl, {
            timeout: timeoutMs,
            maxRetries: this.config.pageLoadMaxRetries,
            retryDelayMs: this.config.pageLoadRetryDelayMs,
            logger: this.logger
          });

          if (!response.ok()) {
            throw new Error(
              `URL kiểm tra phản hồi với mã trạng thái HTTP ${response.status()} ${response.statusText()}`
            );
          }

          try {
            const body = await response.json();
            if (body && typeof body.origin === 'string') {
              outboundIp = body.origin;
            }
          } catch {
            // bỏ qua nếu response không phải JSON
          }
        } catch (checkErr) {
          // Đóng context mới nếu kết nối thất bại
          await newContext.close().catch(() => {});
          this.isSwitching = false;
          throw new Error(
            `[LỖI KẾT NỐI] Kiểm tra kết nối trong context Chrome mới ở chế độ "${targetMode}" thất bại:\n` +
            `  -> URL kiểm tra: ${sanitizeUrl(checkUrl)}\n` +
            `  -> Chi tiết lỗi: ${(checkErr as Error).message}\n` +
            `Quy tắc an toàn: Dừng luồng ngay lập tức, tuyệt đối KHÔNG tự động fallback sang kết nối trực tiếp.`
          );
        }

        this.currentMode = targetMode;
        this.currentProxyConfig = targetMode === 'proxy' ? targetProxy : undefined;
        this.session = newSession;
        this.isSwitching = false;

        const ipNotice = outboundIp ? ` [IP đầu ra: ${outboundIp}]` : '';
        this.logger?.info(
          `[CHUYỂN CHẾ ĐỘ THÀNH CÔNG] Đã chuyển sang chế độ "${targetMode}" (${targetProxy?.server || 'direct'})${ipNotice} trong phiên ẩn danh (giữ nguyên cửa sổ Chrome, cookies và localStorage).`,
          { flow: this.config.flowName }
        );

        return this.session;
      }

      throw new Error(
        '[CHẶN ĐỔI CHẾ ĐỘ] Chưa hỗ trợ đổi proxy giữa phiên ẩn danh; đóng phiên có thể làm mất đăng nhập và trạng thái tab.\n' +
        'Để dùng proxy ở phiên ẩn danh, vui lòng khởi động ngay từ đầu với cấu hình proxy.enabled: true.'
      );
    }

    // 3. Kiểm tra cấu hình chế độ đích TRƯỚC khi đóng Chrome (cho Persistent Context)
    if (targetMode === 'proxy') {
      const server = targetProxy?.server?.trim();
      if (!server) {
        throw new Error(
          '[LỖI CẤU HÌNH PROXY] Không thể chuyển sang chế độ proxy vì "proxy.server" chưa được cấu hình.\n' +
          'Phiên trình duyệt hiện tại được giữ nguyên vẹn không đóng.'
        );
      }

      // Kiểm tra tính hợp lệ của giao thức proxy
      try {
        buildPlaywrightProxy(targetProxy!);
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
      `[CHUYỂN CHẾ ĐỘ KẾT NỐI] Bắt đầu chuyển từ chế độ "${oldMode}" sang "${targetMode}" (${targetProxy?.server || 'direct'})...`,
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
      newSession = await this.launchSession(targetMode, targetProxy);
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
    const checkUrl = options?.checkUrl || this.config.proxyCheckUrl || this.config.startUrl || 'https://www.google.com';
    this.logger?.info(
      `[KIỂM TRA KẾT NỐI] Đang kiểm tra kết nối từ context Chrome mới tới: ${sanitizeUrl(checkUrl)}...`,
      { flow: this.config.flowName }
    );

    try {
      const timeoutMs = options?.timeoutMs || this.config.navigationTimeoutMs;
      // Sử dụng APIRequestContext của chính context Chrome mới để request đi qua proxy/network stack của Chrome
      const response = await safeRequestGet(newSession.context.request, checkUrl, {
        timeout: timeoutMs,
        maxRetries: this.config.pageLoadMaxRetries,
        retryDelayMs: this.config.pageLoadRetryDelayMs,
        logger: this.logger
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
    this.currentProxyConfig = targetMode === 'proxy' ? targetProxy : undefined;
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
  private async launchSession(mode: ConnectionMode, targetProxy?: ProxyConfig): Promise<BrowserSession> {
    if (this.config.incognito) {
      return this.launchIncognitoSession(mode, targetProxy);
    }
    return this.launchPersistentSession(mode, targetProxy);
  }

  /**
   * Khởi chạy phiên Chrome ẩn danh (Incognito).
   * Không ghi dữ liệu/cookie lên ổ đĩa, độc lập hoàn toàn, tránh xung đột SingletonLock.
   */
  private async launchIncognitoSession(mode: ConnectionMode, targetProxy?: ProxyConfig): Promise<BrowserSession> {
    const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const launchArgs = [
      '--incognito',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ...buildWindowArgs(this.config.windowSize, this.config.windowPosition)
    ];

    if (mode === 'direct') {
      launchArgs.push('--no-proxy-server');
    }

    const activeProxy = targetProxy || (mode === 'proxy' ? this.config.proxy : undefined);
    const proxyOption = mode === 'proxy' && activeProxy?.server ? buildPlaywrightProxy(activeProxy) : undefined;

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
  private async launchPersistentSession(mode: ConnectionMode, targetProxy?: ProxyConfig): Promise<BrowserSession> {
    const chromeExe = getChromeExecutablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const profileDirName = this.config.selectedProfile.profileDirectory;
    const userDataDir = this.config.selectedProfile.userDataDir;

    const launchArgs = [
      `--profile-directory=${profileDirName}`,
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ...buildWindowArgs(this.config.windowSize, this.config.windowPosition)
    ];

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      channel: 'chrome',
      executablePath: chromeExe,
      headless: false,
      viewport: null,
      args: launchArgs
    };

    const activeProxy = targetProxy || (mode === 'proxy' ? this.config.proxy : undefined);
    if (mode === 'proxy' && activeProxy?.server) {
      launchOptions.proxy = buildPlaywrightProxy(activeProxy);
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

export function getProxyConfig(manager: BrowserManager): ProxyConfig | undefined {
  return manager.getProxyConfig();
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

export function registerPage(
  manager: BrowserManager,
  name: string,
  page: Page
): void {
  manager.registerPage(name, page);
}

export function getPage(
  manager: BrowserManager,
  name: string
): Page | undefined {
  return manager.getPage(name);
}
