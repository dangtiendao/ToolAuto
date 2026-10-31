import { BrowserContext, Page } from 'playwright';
import { WorkerLogger } from '../utils/worker-logger';
import { safeGoto } from '../browser/navigation';

export interface TabManagerOptions {
  workerId: string;
  context: BrowserContext;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  logger?: WorkerLogger;
}

/**
 * Quản lý tab riêng biệt cho từng worker:
 * - Tên tab (TabA, TabB, TabC,...) chỉ có ý nghĩa trong worker tương ứng.
 * - Tuyệt đối không tìm tab bằng vị trí index trong context.pages().
 * - Báo lỗi rõ ràng khi tab không tồn tại hoặc đã đóng.
 * - Không tự tạo tab thay thế khi gặp lỗi để che giấu lỗi.
 * - Chỉ đưa tab lên trước (bringToFront) khi cần tương tác thủ công.
 */
export class TabManager {
  private readonly workerId: string;
  private readonly context: BrowserContext;
  private readonly tabs: Map<string, Page> = new Map();
  private readonly actionTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly logger?: WorkerLogger;

  constructor(options: TabManagerOptions) {
    this.workerId = options.workerId;
    this.context = options.context;
    this.actionTimeoutMs = options.actionTimeoutMs || 15000;
    this.navigationTimeoutMs = options.navigationTimeoutMs || 30000;
    this.logger = options.logger;
  }

  /**
   * Tạo tab mới trong context của worker.
   */
  public async createTab(name: string, url?: string): Promise<Page> {
    if (!name || !name.trim()) {
      throw new Error(`[TabManager - ${this.workerId}] Tên tab không được để trống.`);
    }

    const trimmedName = name.trim();
    const existing = this.tabs.get(trimmedName);
    if (existing && !existing.isClosed()) {
      throw new Error(
        `[TabManager - ${this.workerId}] Tab "${trimmedName}" đã tồn tại và đang mở. Không thể tạo trùng tên.`
      );
    }

    const page = await this.context.newPage();
    page.setDefaultTimeout(this.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    this.tabs.set(trimmedName, page);

    this.logger?.info(`Đã tạo tab [${trimmedName}] trong context của worker ${this.workerId}.`);

    if (url) {
      await safeGoto(page, url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
        logger: this.logger
      });
      this.logger?.info(`Tab [${trimmedName}] đã mở URL: ${url}`);
    }

    return page;
  }

  /**
   * Lấy Page theo tên tab. Ném lỗi rõ ràng nếu không tồn tại hoặc đã bị đóng.
   */
  public getTab(name: string): Page {
    if (!name || !name.trim()) {
      throw new Error(`[TabManager - ${this.workerId}] Tên tab truy vấn không được để trống.`);
    }

    const trimmedName = name.trim();
    const page = this.tabs.get(trimmedName);

    if (!page) {
      const existingNames = Array.from(this.tabs.keys()).join(', ');
      throw new Error(
        `[TabManager - ${this.workerId}] Không tìm thấy tab "${trimmedName}". ` +
        `Các tab hiện có trong worker này: [${existingNames || 'chưa có tab nào'}].`
      );
    }

    if (page.isClosed()) {
      throw new Error(
        `[TabManager - ${this.workerId}] Tab "${trimmedName}" đã bị đóng và không còn khả dụng.`
      );
    }

    return page;
  }

  /**
   * Đóng tab theo tên và loại bỏ khỏi danh sách quản lý.
   */
  public async closeTab(name: string): Promise<void> {
    if (!name || !name.trim()) {
      throw new Error(`[TabManager - ${this.workerId}] Tên tab cần đóng không được để trống.`);
    }

    const trimmedName = name.trim();
    const page = this.tabs.get(trimmedName);

    if (!page) {
      throw new Error(
        `[TabManager - ${this.workerId}] Không thể đóng tab vì không tìm thấy tab "${trimmedName}".`
      );
    }

    if (!page.isClosed()) {
      await page.close().catch(() => {});
    }

    this.tabs.delete(trimmedName);
    this.logger?.info(`Đã đóng tab [${trimmedName}] của worker ${this.workerId}.`);
  }

  /**
   * Kiểm tra xem tab có tồn tại và đang mở hay không.
   */
  public hasTab(name: string): boolean {
    const page = this.tabs.get(name.trim());
    return !!page && !page.isClosed();
  }

  /**
   * Đưa tab chỉ định lên tiêu điểm hiển thị khi người dùng cần quan sát hoặc xử lý thủ công.
   */
  public async bringToFront(name: string): Promise<void> {
    const page = this.getTab(name);
    await page.bringToFront();
  }

  /**
   * Lấy danh sách tên tất cả các tab đang mở.
   */
  public getOpenTabNames(): string[] {
    const openNames: string[] = [];
    for (const [name, page] of this.tabs.entries()) {
      if (!page.isClosed()) {
        openNames.push(name);
      }
    }
    return openNames;
  }

  /**
   * Đóng toàn bộ các tab do worker này quản lý.
   */
  public async closeAllTabs(): Promise<void> {
    for (const [name, page] of this.tabs.entries()) {
      if (!page.isClosed()) {
        await page.close().catch(() => {});
      }
    }
    this.tabs.clear();
  }
}
