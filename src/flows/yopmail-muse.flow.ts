import { Page, Locator } from 'playwright';
import { Flow, FlowContext, CancellationToken } from '../runner/types';
import { isCancelled } from '../runner';
import { Logger } from '../utils/logger';

const LOWERCASE_CHARS = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT_CHARS = '0123456789';
const ALPHANUMERIC_CHARS = LOWERCASE_CHARS + DIGIT_CHARS;

/**
 * Sinh một chuỗi ngẫu nhiên có độ dài từ 10 đến 14 ký tự (tính cả hai đầu),
 * chỉ sử dụng chữ thường a-z và chữ số 0-9, bắt buộc chứa ít nhất một chữ cái và một chữ số.
 */
export function generateMailboxName(minLength = 10, maxLength = 14): string {
  if (minLength < 2) {
    throw new Error('minLength phải >= 2 để chứa ít nhất một chữ cái và một chữ số.');
  }
  const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;

  // Đảm bảo bắt buộc có ít nhất 1 chữ cái thường và 1 chữ số
  const letter = LOWERCASE_CHARS[Math.floor(Math.random() * LOWERCASE_CHARS.length)];
  const digit = DIGIT_CHARS[Math.floor(Math.random() * DIGIT_CHARS.length)];

  const chars: string[] = [letter, digit];
  for (let i = 2; i < length; i++) {
    const randomChar = ALPHANUMERIC_CHARS[Math.floor(Math.random() * ALPHANUMERIC_CHARS.length)];
    chars.push(randomChar);
  }

  // Xáo trộn mảng ký tự bằng thuật toán Fisher-Yates
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

export interface YopmailMuseState {
  mailboxName: string;
  emailAddress: string;
  tabA?: Page;
  tabB?: Page;
  otpCode?: string;
}

/**
 * Lấy hoặc khởi tạo trạng thái dùng chung cho luồng yopmail-muse.
 * Chuỗi mailboxName và emailAddress chỉ sinh đúng một lần duy nhất cho mỗi lần chạy luồng,
 * lưu trong bộ nhớ và không sinh lại khi chuyển bước hoặc chuyển tab.
 */
export function getYopmailMuseState(context: FlowContext): YopmailMuseState {
  if (!context.data) {
    context.data = {};
  }
  const data = context.data as unknown as Partial<YopmailMuseState>;
  if (!data.mailboxName) {
    const mailboxName = generateMailboxName();
    const emailAddress = `${mailboxName}@yopmail.com`;
    data.mailboxName = mailboxName;
    data.emailAddress = emailAddress;
  }
  return data as YopmailMuseState;
}

/**
 * Kiểm tra xem chuỗi có phải mã OTP 6 chữ số hợp lệ hay không.
 * Bảo toàn số 0 ở đầu bằng kiểu string.
 */
export function isValidOtpCode(code: unknown): code is string {
  return typeof code === 'string' && /^[0-9]{6}$/.test(code);
}

/**
 * Kiểm tra xem div có chứa các thuộc tính kiểu dáng đặc trưng của Muse.ai OTP hay không.
 * Không so khớp tuyệt đối thứ tự; kiểm tra các giá trị đặc trưng:
 * - font-size: 24px
 * - letter-spacing: 2px
 * - border-radius: 4px
 * - padding: 16px
 * - background: rgba(241, 244, 247, 1) / #f1f4f7
 * - color: rgba(28, 43, 51, 1) / #1c2b33
 * - font-weight: 400
 */
export function matchesOtpDivStyle(styleAttr: string, compStyle?: {
  fontSize?: string;
  letterSpacing?: string;
  borderRadius?: string;
  padding?: string;
  backgroundColor?: string;
  color?: string;
  fontWeight?: string;
}): boolean {
  const norm = (styleAttr || '').toLowerCase();
  let score = 0;

  if (norm.includes('24px') || compStyle?.fontSize === '24px') score++;
  if (norm.includes('2px') || compStyle?.letterSpacing === '2px') score++;
  if (norm.includes('4px') || compStyle?.borderRadius === '4px') score++;
  if (norm.includes('16px') || compStyle?.padding === '16px') score++;
  if (norm.includes('241') || norm.includes('f1f4f7') || compStyle?.backgroundColor?.includes('241, 244, 247')) score++;
  if (norm.includes('28') || norm.includes('1c2b33') || compStyle?.color?.includes('28, 43, 51')) score++;
  if (norm.includes('400') || compStyle?.fontWeight === '400') score++;

  return score >= 2;
}

/**
 * Kiểm tra xem trang có xuất hiện CAPTCHA hoặc yêu cầu xác minh người dùng hay không.
 * Nếu có, dừng ngay để người dùng xử lý thủ công, không vượt cơ chế bảo vệ.
 */
export async function checkCaptchaOrVerification(page: Page, tabName: string, stepName: string): Promise<void> {
  if (page.isClosed()) return;

  const title = await page.title().catch(() => '');
  if (
    title.includes('Just a moment...') ||
    title.includes('Attention Required! | Cloudflare') ||
    title.includes('Security Verification')
  ) {
    throw new Error(
      `[YÊU CẦU XÁC MINH] ${tabName}: Phát hiện trang kiểm tra bảo mật ("${title}"). ` +
      `Dừng luồng để người dùng xử lý thủ công, không vượt cơ chế bảo vệ. Bước: "${stepName}".`
    );
  }

  const captchaSelectors = [
    'iframe[src*="challenges.cloudflare.com"]',
    '#cf-challenge-running',
    '.cf-turnstile',
    'iframe[src*="recaptcha"]',
    'div.g-recaptcha',
    'iframe[src*="hcaptcha"]',
    '.h-captcha'
  ];

  for (const selector of captchaSelectors) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const isVis = await loc.nth(i).isVisible().catch(() => false);
        if (isVis) {
          throw new Error(
            `[YÊU CẦU XÁC MINH] ${tabName}: Phát hiện CAPTCHA hoặc yêu cầu xác minh bảo vệ (selector "${selector}"). ` +
            `Dừng luồng để người dùng xử lý thủ công, không vượt cơ chế bảo vệ. Bước: "${stepName}".`
          );
        }
      }
    }
  }
}

/**
 * Tự động phát hiện và click nút đóng popup/quảng cáo với selector id="dismiss-button" nếu có.
 * Hỗ trợ tìm kiếm trên trang chính và tất cả các iframe (bao gồm Google Vignette/interstitial).
 * Không ném lỗi nếu không có popup ("nếu có, sau đó thực hiện tiếp").
 */
export async function dismissPopupIfPresent(
  page: Page,
  logger?: Logger,
  contextInfo?: { flow?: string; step?: string }
): Promise<boolean> {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    return false;
  }

  const dismissSelector = '#dismiss-button, [id="dismiss-button"]';
  let dismissed = false;

  try {
    // 1. Kiểm tra trên trang chính
    if (typeof page.locator === 'function') {
      const mainMatches = page.locator(dismissSelector);
      const mainCount = await mainMatches.count().catch(() => 0);
      for (let i = 0; i < mainCount; i++) {
        const item = mainMatches.nth(i);
        const isVis = await item.isVisible().catch(() => false);
        if (isVis) {
          if (logger) {
            logger.info('TabA: Phát hiện phần tử id="dismiss-button" trên trang chính. Đang click để đóng popup...', contextInfo);
          }
          try {
            await item.click({ timeout: 2000 });
          } catch {
            try {
              await item.click({ force: true, timeout: 2000 });
            } catch {
              await item.dispatchEvent('click').catch(() => {});
            }
          }
          try {
            await item.evaluate((el: HTMLElement) => el.click()).catch(() => {});
          } catch {}
          dismissed = true;
          await new Promise((r) => setTimeout(r, 500));
          break;
        }
      }
    }

    // 2. Kiểm tra trên tất cả các iframe (kể cả frame lồng nhau)
    if (!dismissed && typeof page.frames === 'function') {
      const frames = page.frames() || [];
      for (const frame of frames) {
        if (dismissed) break;
        try {
          if (typeof frame.locator !== 'function') continue;
          const frameMatches = frame.locator(dismissSelector);
          const count = await frameMatches.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const item = frameMatches.nth(i);
            const isVis = await item.isVisible().catch(() => false);
            if (isVis) {
              if (logger) {
                const frameId = typeof frame.name === 'function' ? (frame.name() || (typeof frame.url === 'function' ? frame.url() : 'iframe')) : 'iframe';
                logger.info(
                  `TabA: Phát hiện phần tử id="dismiss-button" trong frame "${frameId}". Đang click để đóng popup...`,
                  contextInfo
                );
              }
              try {
                await item.click({ timeout: 2000 });
              } catch {
                try {
                  await item.click({ force: true, timeout: 2000 });
                } catch {
                  await item.dispatchEvent('click').catch(() => {});
                }
              }
              try {
                await item.evaluate((el: HTMLElement) => el.click()).catch(() => {});
              } catch {}
              dismissed = true;
              await new Promise((r) => setTimeout(r, 500));
              break;
            }
          }
        } catch {
          // Frame có thể bị detach hoặc không truy cập được trong lúc kiểm tra
        }
      }
    }
  } catch (err) {
    if (logger) {
      logger.warn(`TabA: Lỗi không nghiêm trọng khi kiểm tra id="dismiss-button": ${(err as Error).message}`, contextInfo);
    }
  }

  return dismissed;
}

export interface WaitForElementOptions {
  page: Page;
  selector: string;
  tabName: 'TabA' | 'TabB';
  stepName: string;
  timeoutMs: number;
  role?: 'input' | 'clickable';
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}

/**
 * Chờ và lấy duy nhất một phần tử hiển thị phù hợp.
 */
export async function waitForSingleMatchingElement(options: WaitForElementOptions): Promise<Locator> {
  const { page, selector, tabName, stepName, timeoutMs, role, cancellationToken } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng. Không tự tạo tab thay thế. Bước: "${stepName}". Selector: "${selector}"`);
  }

  const startTime = Date.now();
  const pollIntervalMs = 200;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại ${tabName}, bước "${stepName}". Selector: "${selector}"`);
    }

    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng trong khi chờ selector "${selector}". Không tự tạo tab thay thế. Bước: "${stepName}".`);
    }

    // Kiểm tra CAPTCHA / thử thách bảo mật
    await checkCaptchaOrVerification(page, tabName, stepName);

    // Kiểm tra và click id="dismiss-button" nếu có khi ở TabA
    if (tabName === 'TabA') {
      await dismissPopupIfPresent(page, options.logger, { flow: 'yopmail-muse', step: stepName });
    }

    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    if (count > 0) {
      const visibleMatches: Locator[] = [];
      for (let i = 0; i < count; i++) {
        const item = locator.nth(i);
        const isVis = await item.isVisible().catch(() => false);
        if (isVis) {
          visibleMatches.push(item);
        }
      }

      if (visibleMatches.length === 1) {
        const target = visibleMatches[0];
        if (role === 'input') {
          const isEditable = await target.isEditable().catch(() => false);
          const isEnabled = await target.isEnabled().catch(() => false);
          if (isEditable && isEnabled) {
            return target;
          }
        } else if (role === 'clickable') {
          const isEnabled = await target.isEnabled().catch(() => false);
          if (isEnabled) {
            return target;
          }
        } else {
          return target;
        }
      } else if (visibleMatches.length > 1) {
        throw new Error(
          `[LỖI SELECTOR] ${tabName}: Selector "${selector}" khớp ${visibleMatches.length} phần tử hiển thị. ` +
          `Không thể xác định duy nhất một phần tử hiển thị phù hợp trong form đang mở. Dừng luồng. Bước: "${stepName}".`
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] ${tabName}: Quá thời gian (${timeoutMs}ms) khi chờ selector "${selector}" hiển thị và có thể thao tác. ` +
    `Bước: "${stepName}".`
  );
}

export interface WaitForMailItemOptions {
  page: Page;
  tabName: 'TabA';
  stepName: string;
  timeoutMs?: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
  maxRetries?: number;
  retryIntervalMs?: number;
  onRetry?: (retryIndex: number) => Promise<void>;
}

/**
 * Chờ và lấy duy nhất một button.lm trong danh sách thư trên TabA phù hợp với yêu cầu đăng nhập Muse.ai.
 * Kiểm tra iframe ifinbox hoặc trang chính. Không dùng .first() tùy tiện khi có nhiều thư.
 * Hỗ trợ mở cơ chế retry làm mới hộp thư (mặc định retry 3 lần, mỗi lần cách nhau 5 giây).
 */
export async function waitForSingleMatchingMailItem(options: WaitForMailItemOptions): Promise<Locator> {
  const { page, tabName, stepName, timeoutMs = 15000, cancellationToken, logger, onRetry } = options;
  const maxRetries = options.maxRetries ?? 0;
  const retryIntervalMs = options.retryIntervalMs ?? 5000;
  const pollIntervalMs = 300;

  const startTime = Date.now();
  let lastRefreshTime = Date.now();
  let retriesDone = 0;

  // Nếu có cấu hình retry, vòng lặp chạy cho đến khi hết số lần retry và khoảng thời gian chờ của lần retry cuối
  const shouldContinue = (): boolean => {
    if (maxRetries > 0) {
      return retriesDone < maxRetries || Date.now() - lastRefreshTime < retryIntervalMs;
    }
    return Date.now() - startTime < timeoutMs;
  };

  while (shouldContinue()) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại ${tabName}, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng. Không tự tạo tab thay thế. Bước: "${stepName}".`);
    }
    await checkCaptchaOrVerification(page, tabName, stepName);

    // Kiểm tra và click id="dismiss-button" nếu có xuất hiện làm che khuất danh sách thư
    await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });

    const lmLocators: Locator[] = [];

    // 1. Kiểm tra trong iframe ifinbox
    const ifinboxFrame = (typeof page.frame === 'function' ? page.frame({ name: 'ifinbox' }) : null) ||
      (typeof page.frames === 'function' ? page.frames().find((f) => typeof f.name === 'function' && f.name() === 'ifinbox') : null);
    if (ifinboxFrame && typeof ifinboxFrame.locator === 'function') {
      const frameLms = ifinboxFrame.locator('button.lm');
      const count = await frameLms.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = frameLms.nth(i);
        if (await item.isVisible().catch(() => false)) {
          lmLocators.push(item);
        }
      }
    }

    // 2. Nếu không có trong frame ifinbox, kiểm tra trên main page
    if (lmLocators.length === 0 && typeof page.locator === 'function') {
      const pageLms = page.locator('button.lm');
      const count = await pageLms.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = pageLms.nth(i);
        if (await item.isVisible().catch(() => false)) {
          lmLocators.push(item);
        }
      }
    }

    if (lmLocators.length > 0) {
      if (lmLocators.length === 1) {
        return lmLocators[0];
      }

      // Khi có nhiều button.lm: Tìm thư khớp với Muse.ai
      const museMatches: Locator[] = [];
      for (const loc of lmLocators) {
        const text = (await loc.innerText().catch(() => '')).toLowerCase();
        if (text.includes('muse') || text.includes('muse.ai')) {
          museMatches.push(loc);
        }
      }

      if (museMatches.length === 1) {
        return museMatches[0];
      } else if (museMatches.length > 1) {
        throw new Error(
          `[LỖI THƯ TRÙNG LẶP] Tìm thấy ${museMatches.length} thư có nội dung liên quan đến Muse.ai. ` +
          `Không tự ý chọn phần tử đầu tiên (.first()) để tránh đọc nhầm thư cũ. Bước: "${stepName}".`
        );
      } else {
        throw new Error(
          `[LỖI KHÔNG TÌM THẤY THƯ PHÙ HỢP] Có ${lmLocators.length} thư trong hộp thư nhưng không có thư nào phù hợp với yêu cầu đăng nhập Muse.ai. ` +
          `Bước: "${stepName}".`
        );
      }
    }

    // Nếu chưa có thư và khoảng thời gian cách nhau giữa các lần làm mới đã hết (mặc định 5s)
    if (maxRetries > 0 && Date.now() - lastRefreshTime >= retryIntervalMs) {
      if (retriesDone < maxRetries) {
        retriesDone++;
        if (logger) {
          logger.info(
            `TabA: Chưa nhận được thư từ Muse.ai sau ${retryIntervalMs / 1000}s. Thực hiện retry lần ${retriesDone}/${maxRetries} làm mới hộp thư...`,
            { flow: 'yopmail-muse', step: stepName }
          );
        }
        if (onRetry) {
          await onRetry(retriesDone);
        } else {
          if (typeof page.locator === 'function') {
            const refreshLoc = page.locator('button#refresh');
            if (await refreshLoc.count().catch(() => 0) > 0) {
              await refreshLoc.first().click({ timeout: 2000 }).catch(async () => {
                await refreshLoc.first().dispatchEvent('click').catch(() => {});
              });
            }
          }
          await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });
        }
        lastRefreshTime = Date.now();
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (maxRetries > 0) {
    throw new Error(
      `[LỖI TIMEOUT] ${tabName}: Quá thời gian khi chờ thư mới xuất hiện (selector "button.lm"). ` +
      `Đã làm mới hộp thư và retry ${maxRetries} lần (mỗi lần cách nhau ${retryIntervalMs / 1000} giây) nhưng không có thư nào đến. ` +
      `Bước: "${stepName}".`
    );
  }

  throw new Error(
    `[LỖI TIMEOUT] ${tabName}: Quá thời gian (${timeoutMs}ms) khi chờ thư mới xuất hiện (selector "button.lm"). ` +
    `Không có thư nào đến trong thời gian cấu hình. Bước: "${stepName}".`
  );
}

/**
 * Trích xuất mã OTP 6 chữ số từ div có kiểu dáng đặc trưng trong nội dung thư.
 * Kiểm tra iframe ifmail hoặc main page. Tuyệt đối không log mã OTP.
 */
export async function extractOtpFromMailContent(options: {
  page: Page;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<string> {
  const { page, timeoutMs, cancellationToken, logger } = options;
  const startTime = Date.now();
  const pollIntervalMs = 300;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error('[HỦY BỎ] Luồng nhận tín hiệu dừng trong khi trích xuất mã OTP.');
    }
    if (page.isClosed()) {
      throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng khi đang chờ nội dung thư.');
    }
    await checkCaptchaOrVerification(page, 'TabA', 'extract-otp');
    await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: 'extract-otp' });

    let candidates: string[] = [];

    // Tìm trong frame ifmail
    const mailFrame = page.frame({ name: 'ifmail' }) || page.frames().find((f) => f.name() === 'ifmail');
    if (mailFrame) {
      candidates = await mailFrame
        .evaluate(() => {
          const divs = Array.from(document.querySelectorAll('div'));
          const matches: string[] = [];

          for (const div of divs) {
            const text = (div.textContent || '').trim();
            if (!/^[0-9]{6}$/.test(text)) continue;

            const style = (div.getAttribute('style') || '').toLowerCase();
            const comp = window.getComputedStyle(div);

            let score = 0;
            if (style.includes('24px') || comp.fontSize === '24px') score++;
            if (style.includes('2px') || comp.letterSpacing === '2px') score++;
            if (style.includes('4px') || comp.borderRadius === '4px') score++;
            if (style.includes('16px') || comp.padding === '16px') score++;
            if (style.includes('241') || style.includes('f1f4f7') || comp.backgroundColor.includes('241, 244, 247')) score++;
            if (style.includes('28') || style.includes('1c2b33') || comp.color.includes('28, 43, 51')) score++;
            if (style.includes('400') || comp.fontWeight === '400') score++;

            if (score >= 2) {
              matches.push(text);
            }
          }
          return matches;
        })
        .catch(() => []);
    }

    // Nếu không có trong frame ifmail, thử quét trên page chính
    if (candidates.length === 0) {
      candidates = await page
        .evaluate(() => {
          const divs = Array.from(document.querySelectorAll('div'));
          const matches: string[] = [];
          for (const div of divs) {
            const text = (div.textContent || '').trim();
            if (!/^[0-9]{6}$/.test(text)) continue;

            const style = (div.getAttribute('style') || '').toLowerCase();
            const comp = window.getComputedStyle(div);

            let score = 0;
            if (style.includes('24px') || comp.fontSize === '24px') score++;
            if (style.includes('2px') || comp.letterSpacing === '2px') score++;
            if (style.includes('4px') || comp.borderRadius === '4px') score++;
            if (style.includes('16px') || comp.padding === '16px') score++;
            if (style.includes('241') || style.includes('f1f4f7') || comp.backgroundColor.includes('241, 244, 247')) score++;
            if (style.includes('28') || style.includes('1c2b33') || comp.color.includes('28, 43, 51')) score++;
            if (style.includes('400') || comp.fontWeight === '400') score++;

            if (score >= 2) {
              matches.push(text);
            }
          }
          return matches;
        })
        .catch(() => []);
    }

    if (candidates.length === 1) {
      const code = candidates[0];
      if (/^[0-9]{6}$/.test(code)) {
        return code;
      }
    } else if (candidates.length > 1) {
      throw new Error(
        `[LỖI TRÍCH XUẤT OTP] Tìm thấy ${candidates.length} ứng viên mã OTP khác nhau trong div phù hợp kiểu dáng. ` +
        `Dừng luồng để tránh lấy sai mã.`
      );
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] Quá thời gian (${timeoutMs}ms) khi chờ trích xuất mã OTP từ nội dung thư. ` +
    `Không tìm thấy div thỏa mãn định dạng 6 chữ số và kiểu dáng đặc trưng.`
  );
}

/**
 * Nhập mã OTP vào TabB theo cấu trúc DOM thực tế:
 * 1. Một input nhận toàn bộ mã.
 * 2. Sáu input riêng nhận từng chữ số.
 * 3. [data-slot="pin-digit"] là phần tử hiển thị (div/span), xác định input thực sự thuộc cùng nhóm.
 */
export async function enterOtpIntoTabB(options: {
  page: Page;
  otpCode: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
}): Promise<void> {
  const { page, otpCode, timeoutMs, cancellationToken } = options;

  if (page.isClosed()) {
    throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập OTP.');
  }

  // Đưa TabB lên tiêu điểm màn hình UI nếu chưa ở tiêu điểm
  if (typeof page.bringToFront === 'function') {
    await page.bringToFront().catch(() => {});
  }
  if (typeof page.evaluate === 'function') {
    await page.evaluate(() => window.focus()).catch(() => {});
  }

  // b. Chờ phần tử có selector [data-slot="pin-digit"] hiển thị
  const pinDigitLocator = page.locator('[data-slot="pin-digit"]');
  const startTime = Date.now();
  let foundVisible = false;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error('[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabB.');
    }
    if (page.isClosed()) {
      throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trong khi chờ ô nhập OTP.');
    }
    await checkCaptchaOrVerification(page, 'TabB', 'enter-otp');

    const count = await pinDigitLocator.count().catch(() => 0);
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        if (await pinDigitLocator.nth(i).isVisible().catch(() => false)) {
          foundVisible = true;
          break;
        }
      }
      if (foundVisible) break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!foundVisible) {
    throw new Error(
      `[LỖI TIMEOUT] TabB: Quá thời gian (${timeoutMs}ms) khi chờ phần tử selector "[data-slot=\\"pin-digit\\"]" hiển thị.`
    );
  }

  // c. Kiểm tra DOM để xác định cách nhập OTP thực tế
  const totalDigits = await pinDigitLocator.count();
  const firstTag = await pinDigitLocator.first().evaluate((e) => e.tagName.toLowerCase());

  let actualValue = '';

  if (firstTag === 'input') {
    if (totalDigits === 1) {
      // Trường hợp 1: Có một input nhận toàn bộ mã
      const singleInput = pinDigitLocator.first();
      await singleInput.fill(otpCode);
      actualValue = await singleInput.inputValue();
    } else if (totalDigits === 6) {
      // Trường hợp 2: Có sáu input riêng, mỗi input nhận một chữ số
      let combined = '';
      for (let i = 0; i < 6; i++) {
        const dInput = pinDigitLocator.nth(i);
        await dInput.fill(otpCode[i]);
        combined += await dInput.inputValue();
      }
      actualValue = combined;
    } else {
      throw new Error(
        `[LỖI CẤU TRÚC Ô NHẬP] Tìm thấy ${totalDigits} input[data-slot="pin-digit"], không khớp cấu trúc 1 hoặc 6 ô nhập.`
      );
    }
  } else {
    // Trường hợp 3: pin-digit là phần tử hiển thị (div/span), không phải input.
    // Xác định input thực sự thuộc cùng nhóm OTP rồi nhập vào đó.
    // Không gọi fill() lên div/span và không tự đoán input ngoài nhóm.
    const groupAncestor = pinDigitLocator.first().locator('xpath=ancestor::div[.//input][1]');
    const groupInputs = groupAncestor.locator('input');
    const inputCount = await groupInputs.count();

    if (inputCount === 1) {
      // Input duy nhất trong nhóm OTP
      const realInput = groupInputs.first();
      await realInput.fill(otpCode);
      actualValue = await realInput.inputValue();
    } else if (inputCount === 6) {
      // Sáu input trong nhóm OTP
      let combined = '';
      for (let i = 0; i < 6; i++) {
        const dInput = groupInputs.nth(i);
        await dInput.fill(otpCode[i]);
        combined += await dInput.inputValue();
      }
      actualValue = combined;
    } else {
      // Thử tìm input có autocomplete="one-time-code" trong cùng form
      const formOtpInput = page.locator('form input[autocomplete="one-time-code"]');
      if ((await formOtpInput.count()) === 1) {
        const realInput = formOtpInput.first();
        await realInput.fill(otpCode);
        actualValue = await realInput.inputValue();
      } else {
        throw new Error(
          `[LỖI CẤU TRÚC Ô NHẬP] pin-digit là ${firstTag}, nhưng không xác định được duy nhất input thực sự thuộc cùng nhóm OTP.`
        );
      }
    }
  }

  // Sau khi nhập: Kiểm tra giá trị của một input hoặc ghép giá trị sáu input
  if (actualValue !== otpCode) {
    throw new Error(
      `[LỖI KIỂM TRA MÃ NHẬP] Giá trị trong ô nhập sau khi điền không khớp với mã OTP đã trích xuất. ` +
      `Dừng và không bấm xác nhận.`
    );
  }
}

/**
 * Luồng thao tác tuần tự trên hai tab:
 * TabA mở YOPmail tạo hộp thư;
 * TabB mở Muse.ai nhập email và bấm tiếp tục;
 * Quay lại TabA, làm mới hộp thư, mở thư, lấy mã OTP 6 số,
 * nhập mã vào TabB và bấm xác nhận đúng một lần.
 */
export const yopmailMuseFlow: Flow = {
  name: 'yopmail-muse',
  description: 'Luồng tuần tự hai tab: TabA mở YOPmail tạo hộp thư, TabB mở Muse.ai gửi email, TabA lấy OTP, TabB nhập OTP và xác nhận',
  steps: [
    {
      id: 'generate-mailbox',
      name: 'Tạo và ghi nhớ tên hộp thư',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        context.logger.info(
          `Đã sinh và ghi nhớ tên hộp thư: mailboxName = "${state.mailboxName}", emailAddress = "${state.emailAddress}"`,
          { flow: 'yopmail-muse', step: 'generate-mailbox' }
        );
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        const validLength = state.mailboxName.length >= 10 && state.mailboxName.length <= 14;
        const validChars = /^[a-z0-9]+$/.test(state.mailboxName);
        const hasLetter = /[a-z]/.test(state.mailboxName);
        const hasDigit = /[0-9]/.test(state.mailboxName);
        const validEmail = state.emailAddress === `${state.mailboxName}@yopmail.com`;
        return validLength && validChars && hasLetter && hasDigit && validEmail;
      }
    },
    {
      id: 'tabA-yopmail',
      name: 'Thao tác trên TabA: Mở YOPmail và tạo hộp thư',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        const browserContext = context.page.context();

        // a. Tạo TabA
        context.logger.info('TabA: Bắt đầu tạo TabA trong browser context hiện có...', { flow: 'yopmail-muse', step: 'tabA-yopmail' });
        const tabA = await browserContext.newPage();
        state.tabA = tabA;
        context.page = tabA;
        tabA.setDefaultTimeout(context.config.actionTimeoutMs);
        tabA.setDefaultNavigationTimeout(context.config.navigationTimeoutMs);
        context.logger.info('TabA: Đã tạo tab mới thành công.', { flow: 'yopmail-muse', step: 'tabA-yopmail' });

        // b. Truy cập https://yopmail.com/
        context.logger.info('TabA: Đang truy cập https://yopmail.com/ ...', { flow: 'yopmail-muse', step: 'tabA-yopmail' });
        if (tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trước khi truy cập URL. Không tự tạo tab thay thế. Bước: "tabA-yopmail".');
        }
        await tabA.goto('https://yopmail.com/', {
          waitUntil: 'domcontentloaded',
          timeout: context.config.navigationTimeoutMs
        });
        if (tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng sau khi tải trang. Không tự tạo tab thay thế. Bước: "tabA-yopmail".');
        }
        context.logger.info('TabA: Đã tải xong trang YOPmail.', { flow: 'yopmail-muse', step: 'tabA-yopmail' });

        // c. Chờ input có selector: input.ycptinput hiển thị và có thể nhập
        context.logger.info('TabA: Chờ input có selector "input.ycptinput" hiển thị và có thể nhập...', { flow: 'yopmail-muse', step: 'tabA-yopmail' });
        const inputA = await waitForSingleMatchingElement({
          page: tabA,
          selector: 'input.ycptinput',
          tabName: 'TabA',
          stepName: 'tabA-yopmail',
          timeoutMs: context.config.actionTimeoutMs,
          role: 'input',
          cancellationToken: context.cancellationToken
        });

        // d. Dùng fill() nhập mailboxName vào input
        context.logger.info(`TabA: Đang dùng fill() nhập mailboxName "${state.mailboxName}" vào input.ycptinput...`, { flow: 'yopmail-muse', step: 'tabA-yopmail' });
        await inputA.fill(state.mailboxName);

        // e. Kiểm tra giá trị input đúng bằng mailboxName
        const actualVal = await inputA.inputValue();
        if (actualVal !== state.mailboxName) {
          throw new Error(
            `[TabA] Giá trị input không khớp với mailboxName: mong muốn "${state.mailboxName}", thực tế "${actualVal}". ` +
            `Bước: "tabA-yopmail", Selector: "input.ycptinput"`
          );
        }
        context.logger.info(`TabA: Đã kiểm tra giá trị input khớp chính xác với mailboxName ("${actualVal}").`, { flow: 'yopmail-muse', step: 'tabA-yopmail' });

        // f. Nhấn Enter trên chính input đó
        context.logger.info('TabA: Đang nhấn phím Enter trên input.ycptinput...', { flow: 'yopmail-muse', step: 'tabA-yopmail' });
        await inputA.press('Enter');
        context.logger.info('TabA: Đã nhấn Enter trên input.ycptinput thành công.', { flow: 'yopmail-muse', step: 'tabA-yopmail' });

        // g. Giữ TabA mở, không đóng hoặc điều hướng sang trang khác.
        context.logger.info('TabA: Giữ TabA mở, không đóng hoặc điều hướng, không thao tác thêm trong hộp thư.', { flow: 'yopmail-muse', step: 'tabA-yopmail' });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabA && !state.tabA.isClosed());
      }
    },
    {
      id: 'tabB-muse',
      name: 'Thao tác trên TabB: Mở Muse.ai, nhập email và bấm tiếp tục',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        const browserContext = context.page.context();

        // Kiểm tra TabA đã nhấn Enter thành công và vẫn còn mở
        if (!state.tabA || state.tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA không tồn tại hoặc đã bị đóng trước khi chuyển sang TabB. Không tự tạo tab thay thế. Bước: "tabB-muse".');
        }

        // a. Tạo TabB
        context.logger.info('TabB: Bắt đầu tạo TabB trong cùng browser context hiện có...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        const tabB = await browserContext.newPage();
        state.tabB = tabB;
        context.page = tabB;
        tabB.setDefaultTimeout(context.config.actionTimeoutMs);
        tabB.setDefaultNavigationTimeout(context.config.navigationTimeoutMs);
        context.logger.info('TabB: Đã tạo tab mới thành công.', { flow: 'yopmail-muse', step: 'tabB-muse' });

        // b. Truy cập https://muse.ai/
        context.logger.info('TabB: Đang truy cập https://muse.ai/ ...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        if (tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi tải URL. Không tự tạo tab thay thế. Bước: "tabB-muse".');
        }
        await tabB.goto('https://muse.ai/', {
          waitUntil: 'domcontentloaded',
          timeout: context.config.navigationTimeoutMs
        });
        if (tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng sau khi tải URL. Không tự tạo tab thay thế. Bước: "tabB-muse".');
        }
        context.logger.info('TabB: Đã tải xong trang Muse.ai.', { flow: 'yopmail-muse', step: 'tabB-muse' });

        // c. Chờ phần tử có selector: [data-pel-click="login_use_contact_click"] (nếu cần chuyển đổi) hoặc input[data-slot="input"] sẵn sàng
        context.logger.info('TabB: Chờ điều kiện sẵn sàng: nút [data-pel-click="login_use_contact_click"] hoặc input[data-slot="input"]...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        const contactBtnLocator = tabB.locator('[data-pel-click="login_use_contact_click"]');
        const inputLocator = tabB.locator('input[data-slot="input"]');

        const startTime = Date.now();
        const timeoutMs = context.config.actionTimeoutMs;
        while (Date.now() - startTime < timeoutMs) {
          if (isCancelled(context.cancellationToken)) {
            throw new Error('[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabB, bước "tabB-muse".');
          }
          if (tabB.isClosed()) {
            throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng. Không tự tạo tab thay thế. Bước: "tabB-muse".');
          }
          await checkCaptchaOrVerification(tabB, 'TabB', 'tabB-muse');

          const hasContactBtn = (await contactBtnLocator.count().catch(() => 0)) > 0 &&
            (await contactBtnLocator.first().isVisible().catch(() => false));

          if (hasContactBtn) {
            context.logger.info('TabB: Đã tìm thấy [data-pel-click="login_use_contact_click"]. Đang click...', { flow: 'yopmail-muse', step: 'tabB-muse' });
            // d. Click phần tử đó
            await contactBtnLocator.first().click();
            context.logger.info('TabB: Đã click [data-pel-click="login_use_contact_click"] thành công.', { flow: 'yopmail-muse', step: 'tabB-muse' });
            break;
          }

          const hasInput = (await inputLocator.count().catch(() => 0)) > 0 &&
            (await inputLocator.first().isVisible().catch(() => false));

          if (hasInput) {
            context.logger.info('TabB: Form đã hiển thị sẵn input[data-slot="input"], sẵn sàng để nhập email.', { flow: 'yopmail-muse', step: 'tabB-muse' });
            break;
          }

          await new Promise((r) => setTimeout(r, 200));
        }

        // e. Chờ input có selector: input[data-slot="input"] hiển thị và có thể nhập
        context.logger.info('TabB: Chờ input selector "input[data-slot=\\"input\\"]" hiển thị và có thể nhập...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        const emailInput = await waitForSingleMatchingElement({
          page: tabB,
          selector: 'input[data-slot="input"]',
          tabName: 'TabB',
          stepName: 'tabB-muse',
          timeoutMs: context.config.actionTimeoutMs,
          role: 'input',
          cancellationToken: context.cancellationToken
        });

        // f. Dùng fill() nhập emailAddress đã tạo trước đó
        context.logger.info(`TabB: Đang dùng fill() nhập emailAddress "${state.emailAddress}" vào input[data-slot="input"]...`, { flow: 'yopmail-muse', step: 'tabB-muse' });
        await emailInput.fill(state.emailAddress);

        // g. Kiểm tra giá trị input đúng bằng emailAddress
        const actualEmail = await emailInput.inputValue();
        if (actualEmail !== state.emailAddress) {
          throw new Error(
            `[TabB] Giá trị input không khớp với emailAddress: mong muốn "${state.emailAddress}", thực tế "${actualEmail}". ` +
            `Bước: "tabB-muse", Selector: "input[data-slot=\\"input\\"]"`
          );
        }
        context.logger.info(`TabB: Đã kiểm tra giá trị input khớp chính xác với emailAddress ("${actualEmail}").`, { flow: 'yopmail-muse', step: 'tabB-muse' });

        // h. Chờ phần tử có selector: [data-pel-click="login_contact_continue_click"] hiển thị và có thể click
        context.logger.info('TabB: Chờ phần tử selector "[data-pel-click=\\"login_contact_continue_click\\"]" hiển thị và có thể click...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        const continueBtn = await waitForSingleMatchingElement({
          page: tabB,
          selector: '[data-pel-click="login_contact_continue_click"]',
          tabName: 'TabB',
          stepName: 'tabB-muse',
          timeoutMs: context.config.actionTimeoutMs,
          role: 'clickable',
          cancellationToken: context.cancellationToken
        });

        // i. Click đúng một lần
        context.logger.info('TabB: Đang click phần tử [data-pel-click="login_contact_continue_click"] đúng một lần...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        await continueBtn.click();
        context.logger.info('TabB: Đã click nút tiếp tục một lần.', { flow: 'yopmail-muse', step: 'tabB-muse' });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabB && !state.tabB.isClosed());
      }
    },
    {
      id: 'tabA-extract-otp',
      name: 'Quay lại TabA: Làm mới hộp thư, mở thư và trích xuất mã OTP',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);

        // a. Kiểm tra TabA còn mở
        if (!state.tabA || state.tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trước khi làm mới hộp thư. Không tự tạo tab thay thế. Bước: "tabA-extract-otp".');
        }

        const tabA = state.tabA;
        context.page = tabA;
        await tabA.bringToFront().catch(() => {});

        // Bảo mật: Tắt chụp ảnh màn hình lỗi cho bước đọc thư/trích xuất mã OTP để tuyệt đối không rò rỉ mã
        const originalScreenshotOnError = context.config.screenshotOnError;
        context.config.screenshotOnError = false;

        try {
          context.logger.info('TabA: Quay lại TabA để làm mới hộp thư và lấy mã OTP...', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

          // Khi quay lại TabA: Kiểm tra và click id="dismiss-button" nếu có
          await dismissPopupIfPresent(tabA, context.logger, { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

          // b. Tìm button có selector: button#refresh
          // c. Chờ nút hiển thị và có thể thao tác, rồi click một lần
          context.logger.info('TabA: Chờ button#refresh hiển thị và có thể thao tác...', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
          const refreshBtn = await waitForSingleMatchingElement({
            page: tabA,
            selector: 'button#refresh',
            tabName: 'TabA',
            stepName: 'tabA-extract-otp',
            timeoutMs: context.config.actionTimeoutMs,
            role: 'clickable',
            cancellationToken: context.cancellationToken,
            logger: context.logger
          });

          await refreshBtn.click();
          context.logger.info('TabA: Đã click button#refresh một lần để làm mới hộp thư.', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

          // Sau khi click refresh: Kiểm tra và click id="dismiss-button" nếu có xuất hiện
          await dismissPopupIfPresent(tabA, context.logger, { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

          // d. Chờ danh sách thư sẵn sàng bằng điều kiện DOM (retry 3 lần, mỗi lần cách nhau 5 giây)
          // e. Tìm button có selector: button.lm
          // f. Chờ nút hiển thị và có thể thao tác, rồi click
          context.logger.info(
            'TabA: Chờ danh sách thư xuất hiện button.lm phù hợp với Muse.ai (retry tối đa 3 lần, mỗi lần cách nhau 5 giây)...',
            { flow: 'yopmail-muse', step: 'tabA-extract-otp' }
          );
          const mailItem = await waitForSingleMatchingMailItem({
            page: tabA,
            tabName: 'TabA',
            stepName: 'tabA-extract-otp',
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken,
            logger: context.logger,
            maxRetries: 3,
            retryIntervalMs: 5000,
            onRetry: async (retryIndex: number) => {
              context.logger.info(
                `TabA: Chưa nhận được thư từ Muse.ai sau 5 giây. Đang thực hiện retry lần ${retryIndex}/3: click button#refresh làm mới hộp thư...`,
                { flow: 'yopmail-muse', step: 'tabA-extract-otp' }
              );
              const currentRefreshBtn = await waitForSingleMatchingElement({
                page: tabA,
                selector: 'button#refresh',
                tabName: 'TabA',
                stepName: 'tabA-extract-otp',
                timeoutMs: Math.min(context.config.actionTimeoutMs, 5000),
                role: 'clickable',
                cancellationToken: context.cancellationToken,
                logger: context.logger
              });
              await currentRefreshBtn.click();
              context.logger.info(
                `TabA: Đã click button#refresh lần retry ${retryIndex}/3 để làm mới hộp thư.`,
                { flow: 'yopmail-muse', step: 'tabA-extract-otp' }
              );
              await dismissPopupIfPresent(tabA, context.logger, { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
            }
          });

          context.logger.info('TabA: Đang click button.lm mở thư...', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
          await mailItem.click();
          context.logger.info('TabA: Đã click mở thư thành công.', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

          // g. Chờ nội dung thư hiển thị và trích xuất mã OTP
          context.logger.info('TabA: Chờ nội dung thư hiển thị và trích xuất mã OTP...', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
          const otpCode = await extractOtpFromMailContent({
            page: tabA,
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken,
            logger: context.logger
          });

          // Lưu mã vào biến otpCode chỉ trong bộ nhớ của lần chạy
          state.otpCode = otpCode;
          context.logger.info('TabA: Đã trích xuất thành công mã OTP gồm 6 chữ số hợp lệ từ nội dung thư.', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

          // Chuyển sang TabB ngay sau khi lấy mã OTP thành công để người dùng thấy rõ trên UI
          if (state.tabB && !state.tabB.isClosed()) {
            context.logger.info('TabA -> TabB: Đang chuyển tiêu điểm sang TabB trên giao diện UI...', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
            if (typeof state.tabB.bringToFront === 'function') {
              await state.tabB.bringToFront().catch(() => {});
            }
            if (typeof state.tabB.evaluate === 'function') {
              await state.tabB.evaluate(() => window.focus()).catch(() => {});
            }
            context.page = state.tabB;
            context.logger.info('TabA -> TabB: Đã chuyển sang TabB trên UI thành công.', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
          }
        } finally {
          context.config.screenshotOnError = originalScreenshotOnError;
        }
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.otpCode && isValidOtpCode(state.otpCode));
      }
    },
    {
      id: 'tabB-submit-otp',
      name: 'Quay lại TabB: Nhập mã OTP và bấm xác nhận',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);

        // a. Kiểm tra TabB còn mở
        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập OTP. Không tự tạo tab thay thế. Bước: "tabB-submit-otp".');
        }

        if (!state.otpCode || !isValidOtpCode(state.otpCode)) {
          throw new Error('[LỖI OTP] Mã OTP trong bộ nhớ không hợp lệ hoặc chưa được trích xuất. Bước: "tabB-submit-otp".');
        }

        const tabB = state.tabB;
        context.page = tabB;

        // Đảm bảo TabB được đưa lên hàng đầu trên màn hình UI
        if (typeof tabB.bringToFront === 'function') {
          await tabB.bringToFront().catch(() => {});
        }
        if (typeof tabB.evaluate === 'function') {
          await tabB.evaluate(() => window.focus()).catch(() => {});
        }
        context.logger.info('TabB: Đã kích hoạt và đưa TabB lên tiêu điểm chính (UI foreground).', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });

        // Bảo mật: Tắt chụp ảnh màn hình lỗi cho bước nhập OTP
        const originalScreenshotOnError = context.config.screenshotOnError;
        context.config.screenshotOnError = false;

        try {
          context.logger.info('TabB: Quay lại TabB để nhập mã OTP...', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });

          // b. Chờ phần tử có selector [data-slot="pin-digit"] hiển thị
          // c. Kiểm tra DOM để xác định cách nhập OTP thực tế và nhập
          await enterOtpIntoTabB({
            page: tabB,
            otpCode: state.otpCode,
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken
          });

          context.logger.info('TabB: Đã nhập và kiểm tra giá trị khớp chính xác với mã OTP 6 số.', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });

          // 5. BẤM XÁC NHẬN
          // Chờ phần tử: [data-pel-click="login_otp_confirm_click"] hiển thị và có thể click
          context.logger.info('TabB: Chờ phần tử [data-pel-click="login_otp_confirm_click"] hiển thị và có thể click...', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });
          const confirmBtn = await waitForSingleMatchingElement({
            page: tabB,
            selector: '[data-pel-click="login_otp_confirm_click"]',
            tabName: 'TabB',
            stepName: 'tabB-submit-otp',
            timeoutMs: context.config.actionTimeoutMs,
            role: 'clickable',
            cancellationToken: context.cancellationToken
          });

          // Click đúng một lần, không retry
          context.logger.info('TabB: Đang click phần tử [data-pel-click="login_otp_confirm_click"] đúng một lần...', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });
          await confirmBtn.click();

          // Báo thông điệp chính xác theo yêu cầu
          const completionMsg = 'Đã nhập mã 6 số và bấm xác nhận.';
          context.logger.info(completionMsg, { flow: 'yopmail-muse', step: 'tabB-submit-otp' });
          console.log(completionMsg);
        } finally {
          context.config.screenshotOnError = originalScreenshotOnError;
        }
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabB && !state.tabB.isClosed());
      }
    }
  ]
};
