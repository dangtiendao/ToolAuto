import { Page, Response, APIRequestContext, APIResponse } from 'playwright';
import { sanitizeUrl, sanitizeLogText } from '../utils/sanitize';
import { isCancelled } from '../runner';
import { CancellationToken } from '../runner/types';

/**
 * Số lần thử lại tối đa mặc định khi tải trang (load trang) bị lỗi do mạng hoặc proxy không ổn định.
 */
export const DEFAULT_PAGE_LOAD_MAX_RETRIES = 3;

/**
 * Khoảng thời gian chờ mặc định (3 giây = 3000ms) giữa các lần thử lại khi tải trang bị lỗi.
 */
export const DEFAULT_PAGE_LOAD_RETRY_DELAY_MS = 3000;

export interface SafeNavigationOptions {
  /**
   * Số lần thử lại tối đa nếu gặp lỗi tải trang. Mặc định là 3.
   */
  maxRetries?: number;

  /**
   * Thời gian chờ giữa các lần thử lại (mili-giây). Mặc định là 3000ms (3 giây).
   */
  retryDelayMs?: number;

  /**
   * Thời gian timeout tối đa cho mỗi lần tải trang (mili-giây).
   */
  timeout?: number;

  /**
   * Trạng thái hoàn tất tải trang mong muốn. Mặc định là 'domcontentloaded'.
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

  /**
   * Referer header nếu cần.
   */
  referer?: string;

  /**
   * Logger để ghi log thông tin và cảnh báo.
   */
  logger?: {
    info?: (msg: string, meta?: any) => void;
    warn?: (msg: string, meta?: any) => void;
    error?: (msg: string, meta?: any) => void;
  };

  /**
   * Tín hiệu hủy để dừng ngay lập tức nếu người dùng bấm hủy.
   */
  cancellationToken?: AbortSignal | CancellationToken;

  /**
   * Tên luồng để gắn vào metadata log.
   */
  flowName?: string;

  /**
   * Tên bước để gắn vào metadata log.
   */
  stepName?: string;
}

/**
 * Chờ một khoảng thời gian xác định (ms) có hỗ trợ ngắt ngay lập tức khi nhận tín hiệu hủy.
 */
export async function delayWithCancellation(
  ms: number,
  token?: AbortSignal | CancellationToken
): Promise<void> {
  if (ms <= 0) return;
  const interval = 100;
  const startTime = Date.now();

  while (Date.now() - startTime < ms) {
    if (isCancelled(token)) {
      throw new Error('[HỦY BỎ] Luồng nhận tín hiệu dừng trong thời gian chờ thử lại tải trang.');
    }
    const remaining = ms - (Date.now() - startTime);
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
  }
}

/**
 * Điều hướng tới một URL với cơ chế tự động thử lại tối đa 3 lần, mỗi lần cách nhau 3 giây khi gặp lỗi mạng/proxy.
 *
 * @param page Đối tượng Page của Playwright
 * @param url URL đích cần điều hướng tới
 * @param options Tùy chọn điều hướng và retry
 * @returns Response của trang hoặc null
 */
export async function safeGoto(
  page: Page,
  url: string,
  options?: SafeNavigationOptions
): Promise<Response | null> {
  const maxRetries = options?.maxRetries ?? DEFAULT_PAGE_LOAD_MAX_RETRIES;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_PAGE_LOAD_RETRY_DELAY_MS;
  const safeUrl = sanitizeLogText(sanitizeUrl(url));
  const flowMeta = { flow: options?.flowName, step: options?.stepName };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 1. Kiểm tra nếu luồng đã nhận lệnh hủy trước khi tải
    if (isCancelled(options?.cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng trước khi tải trang "${safeUrl}".`);
    }

    // 2. Kiểm tra nếu tab/trang đã bị đóng
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] Tab đã bị đóng trước khi tải trang "${safeUrl}". Không tự tạo tab thay thế.`);
    }

    try {
      if (attempt > 0) {
        options?.logger?.info?.(
          `[RETRY TẢI TRANG] Đang thử lại lần ${attempt}/${maxRetries} tải URL: ${safeUrl}...`,
          flowMeta
        );
      }

      const response = await page.goto(url, {
        timeout: options?.timeout,
        waitUntil: options?.waitUntil ?? 'domcontentloaded',
        referer: options?.referer
      });

      if (attempt > 0) {
        options?.logger?.info?.(
          `[RETRY THÀNH CÔNG] Đã tải thành công URL: ${safeUrl} ở lần thử lại thứ ${attempt}.`,
          flowMeta
        );
      }

      return response;
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);

      // Nếu tab đã bị đóng trong khi tải thì dừng ngay không retry vô ích
      if (typeof page.isClosed === 'function' && page.isClosed()) {
        throw new Error(`[LỖI TAB ĐÃ ĐÓNG] Tab đã bị đóng trong khi tải trang "${safeUrl}": ${errMsg}`);
      }

      // Nếu luồng bị hủy thì dừng ngay
      if (isCancelled(options?.cancellationToken)) {
        throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng trong khi tải trang "${safeUrl}".`);
      }

      // Nếu còn lượt retry: log cảnh báo và chờ 3 giây
      if (attempt < maxRetries) {
        const retryNum = attempt + 1;
        options?.logger?.warn?.(
          `[TẢI TRANG LỖI] Tải trang "${safeUrl}" thất bại: ${errMsg}. Do tính ổn định của proxy, sẽ thử lại lần ${retryNum}/${maxRetries} sau ${retryDelayMs / 1000} giây...`,
          flowMeta
        );

        await delayWithCancellation(retryDelayMs, options?.cancellationToken);
      }
    }
  }

  // Đã hết 3 lần retry mà vẫn lỗi
  const finalErrMsg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `[LỖI TẢI TRANG] Tải trang "${safeUrl}" thất bại sau khi đã thử lại tối đa ${maxRetries} lần (khoảng cách ${retryDelayMs / 1000}s/lần):\n` +
    `  -> Chi tiết lỗi: ${finalErrMsg}`
  );
}

/**
 * Tải lại (reload) một Page với cơ chế tự động thử lại tối đa 3 lần, mỗi lần cách nhau 3 giây khi gặp lỗi mạng/proxy.
 *
 * @param page Đối tượng Page của Playwright
 * @param options Tùy chọn reload và retry
 * @returns Response của trang hoặc null
 */
export async function safeReload(
  page: Page,
  options?: SafeNavigationOptions
): Promise<Response | null> {
  const maxRetries = options?.maxRetries ?? DEFAULT_PAGE_LOAD_MAX_RETRIES;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_PAGE_LOAD_RETRY_DELAY_MS;
  const curUrl = typeof page.url === 'function' ? page.url() : 'trang hiện tại';
  const safeUrl = sanitizeLogText(sanitizeUrl(curUrl));
  const flowMeta = { flow: options?.flowName, step: options?.stepName };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 1. Kiểm tra nếu luồng đã nhận lệnh hủy trước khi reload
    if (isCancelled(options?.cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng trước khi tải lại trang "${safeUrl}".`);
    }

    // 2. Kiểm tra nếu tab/trang đã bị đóng
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] Tab đã bị đóng trước khi tải lại trang "${safeUrl}". Không tự tạo tab thay thế.`);
    }

    try {
      if (attempt > 0) {
        options?.logger?.info?.(
          `[RETRY RELOAD] Đang thử lại lần ${attempt}/${maxRetries} tải lại (reload) trang: ${safeUrl}...`,
          flowMeta
        );
      }

      const response = await page.reload({
        timeout: options?.timeout,
        waitUntil: options?.waitUntil ?? 'domcontentloaded'
      });

      if (attempt > 0) {
        options?.logger?.info?.(
          `[RETRY THÀNH CÔNG] Đã tải lại (reload) thành công trang: ${safeUrl} ở lần thử lại thứ ${attempt}.`,
          flowMeta
        );
      }

      return response;
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);

      if (typeof page.isClosed === 'function' && page.isClosed()) {
        throw new Error(`[LỖI TAB ĐÃ ĐÓNG] Tab đã bị đóng trong khi tải lại trang "${safeUrl}": ${errMsg}`);
      }

      if (isCancelled(options?.cancellationToken)) {
        throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng trong khi tải lại trang "${safeUrl}".`);
      }

      if (attempt < maxRetries) {
        const retryNum = attempt + 1;
        options?.logger?.warn?.(
          `[TẢI LẠI TRANG LỖI] Tải lại trang "${safeUrl}" thất bại: ${errMsg}. Do tính ổn định của proxy, sẽ thử lại lần ${retryNum}/${maxRetries} sau ${retryDelayMs / 1000} giây...`,
          flowMeta
        );

        await delayWithCancellation(retryDelayMs, options?.cancellationToken);
      }
    }
  }

  const finalErrMsg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `[LỖI TẢI LẠI TRANG] Tải lại trang "${safeUrl}" thất bại sau khi đã thử lại tối đa ${maxRetries} lần (khoảng cách ${retryDelayMs / 1000}s/lần):\n` +
    `  -> Chi tiết lỗi: ${finalErrMsg}`
  );
}

/**
 * Gửi HTTP GET request qua APIRequestContext với cơ chế retry tối đa 3 lần, mỗi lần cách nhau 3 giây.
 * Hữu ích cho việc kiểm tra IP proxy khi proxy chập chờn.
 */
export async function safeRequestGet(
  request: APIRequestContext,
  url: string,
  options?: {
    timeout?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    logger?: { warn?: (msg: string) => void };
  }
): Promise<APIResponse> {
  const maxRetries = options?.maxRetries ?? DEFAULT_PAGE_LOAD_MAX_RETRIES;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_PAGE_LOAD_RETRY_DELAY_MS;
  const safeUrl = sanitizeLogText(sanitizeUrl(url));

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await request.get(url, { timeout: options?.timeout });
      if (res.ok()) {
        return res;
      }
      throw new Error(`HTTP ${res.status()} ${res.statusText()}`);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        options?.logger?.warn?.(
          `[REQUEST LỖI] Kết nối tới "${safeUrl}" thất bại: ${(err as Error).message}. Thử lại lần ${attempt + 1}/${maxRetries} sau ${retryDelayMs / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
