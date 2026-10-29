import { Page, Locator } from 'playwright';
import * as readline from 'readline';
import { Flow, FlowContext, CancellationToken } from '../runner/types';
import { isCancelled } from '../runner';
import { Logger } from '../utils/logger';
import {
  readPhoneNumbersFromFile,
  selectRandomPhone,
  maskPhoneNumber,
  isPhoneEquivalent
} from '../utils/phone';

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
  firstName?: string;
  lastName?: string;
  birthYear?: string;
  tabC?: Page;
  selectedPhone?: string;
  twoFactorDialogClosed?: boolean;
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
  container?: Page | Locator;
  selector: string;
  tabName: 'TabA' | 'TabB' | 'TabC';
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
  const { page, container, selector, tabName, stepName, timeoutMs, role, cancellationToken } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng. Không tự tạo tab thay thế. Bước: "${stepName}". Selector: "${selector}"`);
  }

  const startTime = Date.now();
  const pollIntervalMs = 200;
  const root = container || page;

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

    const locator = root.locator(selector);
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
 * Chờ form thông tin cá nhân trên TabB sẵn sàng bằng điều kiện DOM:
 * Kiểm tra TabB còn mở, chờ ô input[aria-label="First name"] hiển thị và có thể nhập.
 * Không dùng sleep cố định, không yêu cầu networkidle.
 * Nếu quá timeout cấu hình, dừng và báo lỗi tại bước chờ form thông tin.
 * Tuyệt đối không tự bấm lại nút xác nhận OTP.
 */
export async function waitForProfileFormReady(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<Locator> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi form thông tin sẵn sàng. Không tự tạo tab thay thế. Bước: "${stepName}".`);
  }

  const selector = 'input[aria-label="First name"]';
  logger?.info(`TabB: Đang chờ form thông tin sẵn sàng (selector "${selector}") bằng điều kiện DOM...`, {
    flow: 'yopmail-muse',
    step: stepName
  });

  try {
    const inputLoc = await waitForSingleMatchingElement({
      page,
      selector,
      tabName: 'TabB',
      stepName,
      timeoutMs,
      role: 'input',
      cancellationToken,
      logger
    });

    logger?.info(`TabB: Form thông tin cá nhân đã sẵn sàng (${selector} hiển thị và có thể nhập).`, {
      flow: 'yopmail-muse',
      step: stepName
    });
    return inputLoc;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('[LỖI TIMEOUT]') || msg.includes('Quá thời gian')) {
      throw new Error(
        `[LỖI CHỜ FORM THÔNG TIN] TabB: Form thông tin cá nhân không xuất hiện sau khi xác nhận OTP trong thời gian ${timeoutMs}ms (quá thời gian chờ selector "${selector}").\n` +
        `Quy tắc an toàn: Dừng luồng ngay tại bước chờ form thông tin, tuyệt đối KHÔNG tự động bấm lại nút xác nhận OTP. Bước: "${stepName}".`
      );
    }
    throw err;
  }
}

/**
 * Nhập First name trên TabB:
 * Tìm đúng input[aria-label="First name"], chờ hiển thị và có thể thao tác,
 * click vào ô rồi dùng fill("Dang").
 * Kiểm tra giá trị input đúng bằng "Dang", nếu không khớp thì dừng; không chuyển bước.
 */
export async function inputFirstName(options: {
  page: Page;
  stepName: string;
  firstName?: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const valueToFill = options.firstName ?? 'Dang';
  const selector = 'input[aria-label="First name"]';

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập First name. Bước: "${stepName}".`);
  }

  logger?.info(`TabB: Đang tìm phần tử "${selector}" để nhập First name...`, { flow: 'yopmail-muse', step: stepName });

  const inputLoc = await waitForSingleMatchingElement({
    page,
    selector,
    tabName: 'TabB',
    stepName,
    timeoutMs,
    role: 'input',
    cancellationToken,
    logger
  });

  // Click vào ô rồi fill
  await inputLoc.click();
  await inputLoc.fill(valueToFill);

  // Kiểm tra giá trị input đúng bằng valueToFill
  const actualValue = await inputLoc.inputValue();
  if (actualValue !== valueToFill) {
    throw new Error(
      `[LỖI GIÁ TRỊ FIRST NAME] TabB: Giá trị nhập vào ô "${selector}" là "${actualValue}", không khớp với giá trị yêu cầu "${valueToFill}".\n` +
      `Dừng luồng ngay lập tức, không chuyển sang bước tiếp theo. Bước: "${stepName}".`
    );
  }

  logger?.info(`TabB: Đã nhập First name "${valueToFill}" và xác minh giá trị khớp 100%.`, {
    flow: 'yopmail-muse',
    step: stepName
  });
}

/**
 * Nhập Last name trên TabB:
 * Tìm đúng input[aria-label="Last name"], chờ hiển thị và có thể thao tác,
 * click vào ô rồi dùng fill("Dao").
 * Kiểm tra giá trị input đúng bằng "Dao", nếu không khớp thì dừng; không chuyển bước.
 */
export async function inputLastName(options: {
  page: Page;
  stepName: string;
  lastName?: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const valueToFill = options.lastName ?? 'Dao';
  const selector = 'input[aria-label="Last name"]';

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập Last name. Bước: "${stepName}".`);
  }

  logger?.info(`TabB: Đang tìm phần tử "${selector}" để nhập Last name...`, { flow: 'yopmail-muse', step: stepName });

  const inputLoc = await waitForSingleMatchingElement({
    page,
    selector,
    tabName: 'TabB',
    stepName,
    timeoutMs,
    role: 'input',
    cancellationToken,
    logger
  });

  // Click vào ô rồi fill
  await inputLoc.click();
  await inputLoc.fill(valueToFill);

  // Kiểm tra giá trị input đúng bằng valueToFill
  const actualValue = await inputLoc.inputValue();
  if (actualValue !== valueToFill) {
    throw new Error(
      `[LỖI GIÁ TRỊ LAST NAME] TabB: Giá trị nhập vào ô "${selector}" là "${actualValue}", không khớp với giá trị yêu cầu "${valueToFill}".\n` +
      `Dừng luồng ngay lập tức, không chuyển sang bước tiếp theo. Bước: "${stepName}".`
    );
  }

  logger?.info(`TabB: Đã nhập Last name "${valueToFill}" và xác minh giá trị khớp 100%.`, {
    flow: 'yopmail-muse',
    step: stepName
  });
}

/**
 * Chọn năm sinh trên TabB:
 * Tìm selectbox: select[aria-label="Year"], chờ hiển thị và được bật.
 * Kiểm tra select có option: option[value="2000"] với nội dung hiển thị "2000".
 * Với select HTML gốc, dùng: selectOption({ value: "2000" }). Không click trực tiếp option hoặc dùng tọa độ.
 * Kiểm tra giá trị select sau khi chọn đúng bằng "2000".
 * Nếu phần tử aria-label="Year" không phải select HTML gốc: kiểm tra DOM thực tế, nếu không xác định được cấu trúc thì dừng và báo rõ.
 */
export async function selectBirthYear(options: {
  page: Page;
  stepName: string;
  yearValue?: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const yearToSelect = options.yearValue ?? '2000';
  const primarySelector = 'select[aria-label="Year"]';
  const fallbackGenericSelector = '[aria-label="Year"]';

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi chọn Year. Bước: "${stepName}".`);
  }

  logger?.info(`TabB: Đang tìm phần tử Year với selector "${primarySelector}"...`, { flow: 'yopmail-muse', step: stepName });

  // 1. Thử tìm thẻ select[aria-label="Year"] trước
  let elementLoc: Locator | undefined;
  let isSelectTag = false;

  const selectCount = await page.locator(primarySelector).count().catch(() => 0);
  if (selectCount > 0) {
    elementLoc = await waitForSingleMatchingElement({
      page,
      selector: primarySelector,
      tabName: 'TabB',
      stepName,
      timeoutMs,
      cancellationToken,
      logger
    });
    isSelectTag = true;
  } else {
    // 2. Nếu không có select[aria-label="Year"], kiểm tra [aria-label="Year"] tổng quát
    const genericCount = await page.locator(fallbackGenericSelector).count().catch(() => 0);
    if (genericCount > 0) {
      elementLoc = await waitForSingleMatchingElement({
        page,
        selector: fallbackGenericSelector,
        tabName: 'TabB',
        stepName,
        timeoutMs,
        cancellationToken,
        logger
      });
      const tagName = await elementLoc.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => '');
      isSelectTag = tagName === 'select';
    } else {
      // Chờ selector chính bằng waitForSingleMatchingElement để tận dụng cơ chế polling và timeout chuẩn
      elementLoc = await waitForSingleMatchingElement({
        page,
        selector: primarySelector,
        tabName: 'TabB',
        stepName,
        timeoutMs,
        cancellationToken,
        logger
      });
      isSelectTag = true;
    }
  }

  // 3. Xử lý khi phần tử là thẻ <select> HTML gốc
  if (isSelectTag) {
    // Chờ hiển thị và được bật
    const isEnabled = await elementLoc.isEnabled().catch(() => false);
    if (!isEnabled) {
      throw new Error(`[LỖI SELECT YEAR] TabB: Phần tử "${primarySelector}" đang bị vô hiệu hóa (disabled). Bước: "${stepName}".`);
    }

    // Kiểm tra select có option[value="2000"] với nội dung hiển thị "2000"
    const optionSelector = `option[value="${yearToSelect}"]`;
    const optionLoc = elementLoc.locator(optionSelector);
    const optionCount = await optionLoc.count().catch(() => 0);
    if (optionCount === 0) {
      throw new Error(
        `[LỖI OPTION YEAR] TabB: Selectbox "${primarySelector}" không có option "${optionSelector}". ` +
        `Không tìm thấy năm sinh yêu cầu. Bước: "${stepName}".`
      );
    }

    const optionText = (await optionLoc.first().innerText().catch(() => '')).trim();
    if (optionText !== yearToSelect) {
      throw new Error(
        `[LỖI OPTION YEAR] TabB: Option "${optionSelector}" có nội dung hiển thị là "${optionText}", không khớp với "${yearToSelect}". Bước: "${stepName}".`
      );
    }

    // Dùng selectOption({ value: "2000" }). Không click trực tiếp option hoặc dùng tọa độ màn hình
    logger?.info(`TabB: Đang chọn năm sinh "${yearToSelect}" bằng selectOption...`, { flow: 'yopmail-muse', step: stepName });
    await elementLoc.selectOption({ value: yearToSelect });

    // Kiểm tra giá trị select sau khi chọn đúng bằng "2000"
    const selectedValue = await elementLoc.inputValue();
    if (selectedValue !== yearToSelect) {
      throw new Error(
        `[LỖI GIÁ TRỊ YEAR] TabB: Giá trị của select[aria-label="Year"] sau khi chọn là "${selectedValue}", không đúng bằng "${yearToSelect}". Bước: "${stepName}".`
      );
    }

    logger?.info(`TabB: Đã chọn năm sinh "${yearToSelect}" thành công và xác minh giá trị khớp 100%.`, {
      flow: 'yopmail-muse',
      step: stepName
    });
    return;
  }

  // 4. Nếu phần tử aria-label="Year" không phải select HTML gốc
  const nonSelectTagName = await elementLoc.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => 'unknown');
  logger?.warn(
    `TabB: Phần tử aria-label="Year" không phải thẻ <select> HTML gốc (thực tế là <${nonSelectTagName}>). Đang kiểm tra DOM thực tế...`,
    { flow: 'yopmail-muse', step: stepName }
  );

  // Kiểm tra DOM thực tế để xác định cấu trúc điều khiển
  const role = await elementLoc.getAttribute('role').catch(() => null);
  const ariaHasPopup = await elementLoc.getAttribute('aria-haspopup').catch(() => null);

  // Nếu là custom combobox / dropdown (role="combobox" hoặc có popup listbox)
  if (role === 'combobox' || ariaHasPopup === 'listbox' || ariaHasPopup === 'true') {
    await elementLoc.click();
    await new Promise((r) => setTimeout(r, 300));

    const optionItem = page.locator(`[role="option"]:has-text("${yearToSelect}"), [role="listbox"] >> text="${yearToSelect}"`);
    const count = await optionItem.count().catch(() => 0);
    if (count === 1) {
      await optionItem.first().click();
      logger?.info(`TabB: Đã chọn năm "${yearToSelect}" qua custom combobox.`, { flow: 'yopmail-muse', step: stepName });
      return;
    }
  }

  // Nếu không xác định được cấu trúc chắc chắn: Dừng và báo rõ
  throw new Error(
    `[LỖI CẤU TRÚC ĐIỀU KHIỂN YEAR] TabB: Phần tử aria-label="Year" là thẻ <${nonSelectTagName}> (role="${role}"), ` +
    `không phải thẻ <select> HTML gốc và không xác định được cấu trúc điều khiển chắc chắn để chọn năm "${yearToSelect}".\n` +
    `Quy tắc an toàn: Không gọi selectOption() lên div/button, không tự đoán selector thay thế và dừng luồng. Bước: "${stepName}".`
  );
}

/**
 * Xác minh 3 trường thông tin và click nút tiếp tục trên TabB:
 * Chỉ thực hiện khi: First name = "Dang", Last name = "Dao", Year = "2000".
 * Chờ phần tử [data-pel-click="login_birthday_continue_click"] hiển thị và được bật.
 * Click đúng một lần (không dùng force: true, không retry).
 * Báo thông điệp: "Đã nhập Dang, Dao, chọn năm 2000 và bấm tiếp tục."
 */
export async function submitProfileBirthday(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const continueSelector = '[data-pel-click="login_birthday_continue_click"]';

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi bấm tiếp tục. Bước: "${stepName}".`);
  }

  // 1. Chỉ thực hiện khi đã kiểm tra: First name = "Dang", Last name = "Dao", Year = "2000"
  logger?.info('TabB: Đang kiểm tra lại giá trị các trường trước khi bấm tiếp tục...', { flow: 'yopmail-muse', step: stepName });

  const firstNameLoc = page.locator('input[aria-label="First name"]');
  const actualFirstName = await firstNameLoc.inputValue().catch(() => '');
  if (actualFirstName !== 'Dang') {
    throw new Error(
      `[LỖI XÁC MINH TRƯỚC BẤM TIẾP TỤC] TabB: First name hiện tại là "${actualFirstName}", không đúng bằng "Dang". Dừng luồng. Bước: "${stepName}".`
    );
  }

  const lastNameLoc = page.locator('input[aria-label="Last name"]');
  const actualLastName = await lastNameLoc.inputValue().catch(() => '');
  if (actualLastName !== 'Dao') {
    throw new Error(
      `[LỖI XÁC MINH TRƯỚC BẤM TIẾP TỤC] TabB: Last name hiện tại là "${actualLastName}", không đúng bằng "Dao". Dừng luồng. Bước: "${stepName}".`
    );
  }

  const yearLoc = page.locator('select[aria-label="Year"], [aria-label="Year"]');
  const actualYear = await yearLoc.inputValue().catch(() => '');
  if (actualYear !== '2000') {
    throw new Error(
      `[LỖI XÁC MINH TRƯỚC BẤM TIẾP TỤC] TabB: Year hiện tại là "${actualYear}", không đúng bằng "2000". Dừng luồng. Bước: "${stepName}".`
    );
  }

  logger?.info('TabB: Xác minh cả 3 trường (First name = "Dang", Last name = "Dao", Year = "2000") đạt yêu cầu.', {
    flow: 'yopmail-muse',
    step: stepName
  });

  // 2. Chờ phần tử [data-pel-click="login_birthday_continue_click"] hiển thị
  logger?.info(`TabB: Đang chờ nút "${continueSelector}" hiển thị...`, { flow: 'yopmail-muse', step: stepName });

  const continueBtn = await waitForSingleMatchingElement({
    page,
    selector: continueSelector,
    tabName: 'TabB',
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

  // Kiểm tra nút có bị vô hiệu hóa không, tuyệt đối không dùng force: true
  const isEnabled = await continueBtn.isEnabled().catch(() => false);
  if (!isEnabled) {
    // Kiểm tra xem form có trường nào khác đang yêu cầu không
    const missingFields: string[] = [];
    if (await page.locator('select[aria-label="Month"], [aria-label="Month"]').count().catch(() => 0) > 0) {
      missingFields.push('Month');
    }
    if (await page.locator('select[aria-label="Day"], [aria-label="Day"]').count().catch(() => 0) > 0) {
      missingFields.push('Day');
    }
    const fieldNotice = missingFields.length > 0 ? ` Form yêu cầu thêm trường bắt buộc: [${missingFields.join(', ')}].` : '';
    throw new Error(
      `[LỖI NÚT TIẾP TỤC BỊ VÔ HIỆU HÓA] TabB: Nút "${continueSelector}" đang bị vô hiệu hóa (disabled).${fieldNotice}\n` +
      `Quy tắc an toàn: Không dùng force: true để bấm nút bị vô hiệu hóa, không tự tạo dữ liệu và dừng luồng. Bước: "${stepName}".`
    );
  }

  // 3. Click đúng một lần, không retry
  logger?.info(`TabB: Đang click nút "${continueSelector}" đúng một lần...`, { flow: 'yopmail-muse', step: stepName });
  await continueBtn.click();

  // 4. Kết thúc phần nghiệp vụ tại đây và báo thông điệp chính xác
  const completionMsg = 'Đã nhập Dang, Dao, chọn năm 2000 và bấm tiếp tục.';
  logger?.info(completionMsg, { flow: 'yopmail-muse', step: stepName });
  console.log(completionMsg);
}

/**
 * Hiển thị lời nhắc yêu cầu người dùng xác nhận thủ công trong terminal khi chạy chế độ LIVE.
 * Chỉ hiển thị số điện thoại đã được che bớt (masked).
 */
export async function promptLiveModeConfirmation(
  maskedPhone: string,
  timeoutMs = 60000
): Promise<boolean> {
  // Nếu môi trường không hỗ trợ tương tác terminal (không phải TTY)
  if (!process.stdin.isTTY) {
    return false;
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const timer = setTimeout(() => {
      rl.close();
      console.log('\n[HẾT THỜI GIAN] Quá thời gian chờ xác nhận thủ công trong terminal.');
      resolve(false);
    }, timeoutMs);

    console.log(`\n===============================================================`);
    console.log(`[XÁC NHẬN BẢO MẬT LIVE MODE]`);
    console.log(`Chuẩn bị gửi yêu cầu mã xác thực hai yếu tố đến số: ${maskedPhone}`);
    console.log(`Vui lòng xác nhận bạn có quyền sử dụng tài khoản Meta này và số điện thoại trên.`);
    console.log(`Nhập "yes" hoặc "y" để xác nhận, hoặc bất kỳ phím nào khác để hủy: `);
    console.log(`===============================================================`);

    rl.question('> ', (answer) => {
      clearTimeout(timer);
      rl.close();
      const trimmed = (answer || '').trim().toLowerCase();
      resolve(trimmed === 'yes' || trimmed === 'y');
    });
  });
}

/**
 * Chờ giao diện bảo mật Meta (Password and Security) sẵn sàng bằng điều kiện DOM.
 * Nếu phát hiện trang yêu cầu đăng nhập, chọn tài khoản hoặc nhập mật khẩu:
 * Tạm dừng và ghi log hướng dẫn người dùng xử lý thủ công, không tự ý chọn tài khoản.
 */
export async function waitForMetaSecurityPageReady(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const startTime = Date.now();
  const pollIntervalMs = 500;
  let hasLoggedNotice = false;

  logger?.info('TabC: Đang chờ giao diện bảo mật Meta sẵn sàng theo DOM...', { flow: 'yopmail-muse', step: stepName });

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ trang bảo mật Meta sẵn sàng. Bước: "${stepName}".`);
    }

    // 1. Kiểm tra phần tử mục tiêu đã sẵn sàng chưa: [aria-label="Xác thực 2 yếu tố"]
    const twoFactorLoc = page.locator('[aria-label="Xác thực 2 yếu tố"]');
    const twoFactorCount = await twoFactorLoc.count().catch(() => 0);
    if (twoFactorCount > 0) {
      const item = typeof twoFactorLoc.first === 'function' ? twoFactorLoc.first() : twoFactorLoc.nth(0);
      const isVis = await item.isVisible().catch(() => false);
      if (isVis) {
        logger?.info('TabC: Giao diện bảo mật Meta đã sẵn sàng (phần tử [aria-label="Xác thực 2 yếu tố"] hiển thị).', { flow: 'yopmail-muse', step: stepName });
        return;
      }
    }

    // 2. Kiểm tra nếu trang yêu cầu đăng nhập, chọn tài khoản hoặc nhập mật khẩu
    const isLoginOrAuth =
      (await page.locator('input[type="password"], input[name="email"], input[name="pass"]').count().catch(() => 0)) > 0 ||
      (await page.locator('[aria-label="Chọn tài khoản của bạn"], [role="button"]:has-text("Đăng nhập")').count().catch(() => 0)) > 0 ||
      (await page.locator(':text("Đăng nhập"), :text("Chọn tài khoản"), :text("Nhập mật khẩu")').count().catch(() => 0)) > 0;

    if (isLoginOrAuth && !hasLoggedNotice) {
      hasLoggedNotice = true;
      const warnMsg =
        '[CHỜ NGƯỜI DÙNG XỬ LÝ THỦ CÔNG] TabC: Trang bảo mật Meta yêu cầu đăng nhập, chọn tài khoản hoặc nhập mật khẩu.\n' +
        '  -> Hệ thống không tự ý chọn tài khoản hoặc điền mật khẩu.\n' +
        '  -> Vui lòng hoàn tất đăng nhập/chọn tài khoản trên cửa sổ Chrome để tiếp tục...';
      logger?.warn(warnMsg, { flow: 'yopmail-muse', step: stepName });
      console.warn(`\n${warnMsg}\n`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] TabC: Quá thời gian (${timeoutMs}ms) khi chờ giao diện bảo mật Meta sẵn sàng (không thấy [aria-label="Xác thực 2 yếu tố"]). Bước: "${stepName}".`
  );
}

/**
 * Tìm phần tử nút tương tác chứa thẻ span có nội dung chính xác "Bắt đầu", "Tiếp tục", hoặc "Tiếp".
 * Phân biệt chính xác giữa "Tiếp" và "Tiếp tục" bằng regex so khớp toàn bộ chuỗi (^...$).
 * Kiểm tra tính duy nhất: chỉ chấp nhận khi có đúng duy nhất một phần tử hiển thị.
 */
export async function findInteractiveButtonWithSpanText(options: {
  page: Page;
  container?: Page | Locator;
  targetText: 'Tiếp' | 'Tiếp tục' | 'Bắt đầu';
  tabName: 'TabC';
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<Locator> {
  const { page, container, targetText, tabName, stepName, timeoutMs, cancellationToken } = options;
  const startTime = Date.now();
  const pollIntervalMs = 200;
  const root = container || page;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại ${tabName}, bước "${stepName}". Nút: "${targetText}"`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng trong khi chờ nút "${targetText}". Bước: "${stepName}".`);
    }

    // 1. Ưu tiên button có accessible name chính xác
    if (typeof root.getByRole === 'function') {
      const btnByName = root.getByRole('button', { name: targetText, exact: true });
      const btnCount = await btnByName.count().catch(() => 0);
      const visibleButtonsByName: Locator[] = [];
      for (let i = 0; i < btnCount; i++) {
        const b = btnByName.nth(i);
        if (await b.isVisible().catch(() => false)) {
          visibleButtonsByName.push(b);
        }
      }

      if (visibleButtonsByName.length === 1) {
        return visibleButtonsByName[0];
      } else if (visibleButtonsByName.length > 1) {
        throw new Error(
          `[LỖI SELECTOR] ${tabName}: Tìm thấy ${visibleButtonsByName.length} nút có tên chính xác "${targetText}". ` +
          `Không thể xác định duy nhất một phần tử hiển thị trong dialog/form. Bước: "${stepName}".`
        );
      }
    }

    // 2. Tìm span có text chính xác targetText (dùng regex chặn ^...$ để phân biệt "Tiếp" và "Tiếp tục")
    const exactRegex = new RegExp(`^${targetText}$`);
    const spans = root.locator('span').filter({ hasText: exactRegex });
    const spanCount = await spans.count().catch(() => 0);
    const matchingSpans: Locator[] = [];

    for (let i = 0; i < spanCount; i++) {
      const sp = spans.nth(i);
      const isVis = await sp.isVisible().catch(() => false);
      if (!isVis) continue;
      const text = (await sp.innerText().catch(() => '')) || (await sp.textContent().catch(() => '')) || '';
      if (text.trim() === targetText) {
        matchingSpans.push(sp);
      }
    }

    if (matchingSpans.length > 0) {
      const interactiveElements: Locator[] = [];

      for (const sp of matchingSpans) {
        // Tìm button hoặc role="button" cha
        const parentLoc = sp.locator('xpath=ancestor-or-self::*[@role="button" or self::button]');
        const hasParent = (await parentLoc.count().catch(() => 0)) > 0;
        const targetElement = hasParent
          ? (typeof parentLoc.first === 'function' ? parentLoc.first() : parentLoc.nth(0))
          : sp;
        const isVis = await targetElement.isVisible().catch(() => false);
        if (isVis) {
          interactiveElements.push(targetElement);
        }
      }

      if (interactiveElements.length === 1) {
        return interactiveElements[0];
      } else if (interactiveElements.length > 1) {
        throw new Error(
          `[LỖI SELECTOR] ${tabName}: Tìm thấy ${interactiveElements.length} phần tử tương tác chứa span "${targetText}". ` +
          `Không thể xác định duy nhất một phần tử hiển thị. Dừng luồng. Bước: "${stepName}".`
        );
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] ${tabName}: Quá thời gian (${timeoutMs}ms) khi tìm nút tương tác chứa span có nội dung chính xác "${targetText}". Bước: "${stepName}".`
  );
}

/**
 * Chọn phương thức xác thực SMS hoặc WhatsApp trên TabC.
 * Kiểm tra trạng thái đã được chọn thực tế (checked hoặc aria-checked/aria-selected="true").
 */
export async function selectSmsOrWhatsAppOption(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const selector = '[aria-label="SMS hoặc WhatsApp"]';

  logger?.info(`TabC: Đang chờ phần tử "${selector}" hiển thị...`, { flow: 'yopmail-muse', step: stepName });

  const option = await waitForSingleMatchingElement({
    page,
    selector,
    tabName: 'TabC',
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

  const tagName = await option.evaluate((el: HTMLElement) => el.tagName.toLowerCase()).catch(() => '');
  const inputType = await option.getAttribute('type').catch(() => null);

  if (tagName === 'input' && (inputType === 'radio' || inputType === 'checkbox')) {
    await option.check().catch(async () => {
      await option.click();
    });
    const isChecked = await option.isChecked().catch(() => false);
    if (!isChecked) {
      throw new Error(
        `[LỖI CHỌN PHƯƠNG THỨC] TabC: Thẻ input[type="${inputType}"] "${selector}" chưa ở trạng thái được chọn sau khi thao tác. Bước: "${stepName}".`
      );
    }
  } else {
    // Phần tử custom (div/button/label)
    await option.click();

    // Xác minh trạng thái được chọn
    const ariaChecked = await option.getAttribute('aria-checked').catch(() => null);
    const ariaSelected = await option.getAttribute('aria-selected').catch(() => null);
    const innerInput = option.locator('input[type="radio"], input[type="checkbox"]');
    const innerCount = await innerInput.count().catch(() => 0);
    const innerChecked = innerCount > 0 ? await innerInput.first().isChecked().catch(() => false) : false;

    let isSelected = ariaChecked === 'true' || ariaSelected === 'true' || innerChecked;

    if (!isSelected) {
      // Chờ thêm một khoảng ngắn xem DOM có cập nhật trạng thái không
      await new Promise((r) => setTimeout(r, 400));
      const reAriaChecked = await option.getAttribute('aria-checked').catch(() => null);
      const reAriaSelected = await option.getAttribute('aria-selected').catch(() => null);
      const reInnerChecked = innerCount > 0 ? await innerInput.first().isChecked().catch(() => false) : false;
      isSelected = reAriaChecked === 'true' || reAriaSelected === 'true' || reInnerChecked;
    }

    if (!isSelected) {
      throw new Error(
        `[LỖI CHỌN PHƯƠNG THỨC] TabC: Phần tử "${selector}" chưa được chọn (aria-checked/aria-selected !== "true" và input con chưa checked). Bước: "${stepName}".`
      );
    }
  }

  logger?.info(`TabC: Đã chọn phương thức xác thực SMS hoặc WhatsApp và xác minh trạng thái được chọn thành công.`, { flow: 'yopmail-muse', step: stepName });
}

/**
 * Nhập số điện thoại vào ô input[type="tel"] trên TabC.
 * Xác minh giá trị sau khi nhập và bảo vệ dữ liệu nhạy cảm.
 */
export async function inputPhoneNumberOnTabC(options: {
  page: Page;
  stepName: string;
  phone: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, phone, timeoutMs, cancellationToken, logger } = options;
  const telSelector = 'input[type="tel"]';

  logger?.info(`TabC: Đang chờ ô nhập số điện thoại "${telSelector}" hiển thị...`, { flow: 'yopmail-muse', step: stepName });

  const telInput = await waitForSingleMatchingElement({
    page,
    selector: telSelector,
    tabName: 'TabC',
    stepName,
    timeoutMs,
    role: 'input',
    cancellationToken,
    logger
  });

  // Kiểm tra nếu form yêu cầu chọn mã quốc gia riêng nhưng chưa được cấu hình
  const countryDropdown = page.locator('select[aria-label*="quốc gia" i], select[aria-label*="country" i], [role="combobox"][aria-label*="quốc gia" i]');
  const countryCount = await countryDropdown.count().catch(() => 0);
  if (countryCount > 0 && !phone.startsWith('+')) {
    throw new Error(
      `[YÊU CẦU CẤU HÌNH QUỐC GIA] TabC: Form yêu cầu chọn quốc gia riêng biệt nhưng số điện thoại "${maskPhoneNumber(phone)}" không bắt đầu bằng mã quốc gia "+" và hệ thống chưa có cấu hình quốc gia. Dừng luồng để tránh chọn sai quốc gia. Bước: "${stepName}".`
    );
  }

  // Nhập bằng fill()
  await telInput.click();
  await telInput.fill(phone);

  // Kiểm tra giá trị đã nhập
  const actualVal = (await telInput.inputValue().catch(() => '')).trim();
  if (!isPhoneEquivalent(actualVal, phone)) {
    throw new Error(
      `[LỖI GIÁ TRỊ SỐ ĐIỆN THOẠI] TabC: Giá trị trong ô nhập "${maskPhoneNumber(actualVal)}" không khớp hoặc không tương đương với số đã chọn "${maskPhoneNumber(phone)}". Bước: "${stepName}".`
    );
  }

  logger?.info(`TabC: Đã nhập số điện thoại "${maskPhoneNumber(phone)}" và xác minh giá trị thành công.`, { flow: 'yopmail-muse', step: stepName });
}

/**
 * Xác nhận quyền gửi mã (với LIVE mode) và bấm nút Tiếp (chứa <span>Tiếp</span> chính xác).
 */
export async function confirmAndClickNextButton(options: {
  page: Page;
  stepName: string;
  phone: string;
  phoneMode: 'mock' | 'live';
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, phone, phoneMode, timeoutMs, cancellationToken, logger } = options;

  if (phoneMode === 'live') {
    logger?.info(`TabC: Đang chạy ở chế độ LIVE. Chờ người dùng xác nhận trong terminal trước khi gửi mã...`, { flow: 'yopmail-muse', step: stepName });
    const confirmed = await promptLiveModeConfirmation(maskPhoneNumber(phone), timeoutMs * 3);
    if (!confirmed) {
      throw new Error(
        `[HỦY BỎ BẢO MẬT LIVE MODE] Người dùng không xác nhận quyền sử dụng tài khoản Meta hoặc số điện thoại ${maskPhoneNumber(phone)}. Dừng luồng an toàn trước khi bấm nút Tiếp. Bước: "${stepName}".`
      );
    }
  } else {
    logger?.info(`TabC: Đang chạy ở chế độ MOCK (phoneMode = "mock"). Không gửi SMS/WhatsApp thật đến Meta.`, { flow: 'yopmail-muse', step: stepName });
  }

  // Tìm nút chứa <span>Tiếp</span> chính xác (không nhầm với Tiếp tục)
  logger?.info('TabC: Đang tìm nút tương tác chứa <span>Tiếp</span> với nội dung chính xác...', { flow: 'yopmail-muse', step: stepName });

  const nextBtn = await findInteractiveButtonWithSpanText({
    page,
    targetText: 'Tiếp',
    tabName: 'TabC',
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

  const isEnabled = await nextBtn.isEnabled().catch(() => false);
  if (!isEnabled) {
    throw new Error(
      `[LỖI NÚT TIẾP BỊ VÔ HIỆU HÓA] TabC: Nút "Tiếp" đang bị vô hiệu hóa (disabled). Không dùng force: true để bấm. Bước: "${stepName}".`
    );
  }

  // Click đúng một lần, tuyệt đối không retry
  logger?.info('TabC: Đang click nút "Tiếp" đúng một lần...', { flow: 'yopmail-muse', step: stepName });
  await nextBtn.click();
}

/**
 * Chờ màn hình "Nhập mã xác nhận" hiển thị rồi bấm nút [aria-label="Đóng"] trong chính dialog đó.
 * Sau khi đóng dialog, báo thông điệp: "Đã đến màn hình nhập mã xác nhận và đóng dialog."
 */
export async function waitForVerificationCodeAndCloseDialog(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const startTime = Date.now();
  const pollIntervalMs = 200;
  let codeScreenAppeared = false;

  logger?.info('TabC: Đang chờ màn hình "Nhập mã xác nhận" hiển thị trong dialog...', { flow: 'yopmail-muse', step: stepName });

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ màn hình mã xác nhận. Bước: "${stepName}".`);
    }

    // Kiểm tra xem text "Nhập mã xác nhận" có hiển thị không
    const headingLoc = page.locator(':text("Nhập mã xác nhận"), :has-text("Nhập mã xác nhận")');
    const count = await headingLoc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      if (await headingLoc.nth(i).isVisible().catch(() => false)) {
        codeScreenAppeared = true;
        break;
      }
    }

    if (codeScreenAppeared) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!codeScreenAppeared) {
    throw new Error(
      `[LỖI MÀN HÌNH MÃ XÁC NHẬN] TabC: Quá thời gian (${timeoutMs}ms) chờ màn hình "Nhập mã xác nhận" xuất hiện. Không tự bấm Đóng và dừng luồng. Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Đã xác nhận màn hình "Nhập mã xác nhận" hiển thị. Đang tìm nút [aria-label="Đóng"] trong dialog...', { flow: 'yopmail-muse', step: stepName });

  // Tìm [aria-label="Đóng"] duy nhất
  const closeBtn = await waitForSingleMatchingElement({
    page,
    selector: '[aria-label="Đóng"]',
    tabName: 'TabC',
    stepName,
    timeoutMs,
    role: 'clickable',
    cancellationToken,
    logger
  });

  // Click đúng một lần
  await closeBtn.click();

  // Kiểm tra dialog đã đóng
  let isClosed = false;
  const closeStartTime = Date.now();
  while (Date.now() - closeStartTime < 3000) {
    const isStillVisible = await closeBtn.isVisible().catch(() => false);
    const codeScreenStillVisible = await page.locator(':text("Nhập mã xác nhận")').first().isVisible().catch(() => false);
    if (!isStillVisible || !codeScreenStillVisible) {
      isClosed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!isClosed) {
    throw new Error(`[LỖI ĐÓNG DIALOG] TabC: Dialog vẫn chưa đóng sau khi click nút [aria-label="Đóng"]. Bước: "${stepName}".`);
  }

  const completionMsg = 'Đã đến màn hình nhập mã xác nhận và đóng dialog.';
  logger?.info(completionMsg, { flow: 'yopmail-muse', step: stepName });
  console.log(completionMsg);
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
    },
    {
      id: 'tabB-wait-profile-form',
      name: 'TabB: Chờ form thông tin cá nhân sẵn sàng',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi form thông tin sẵn sàng. Không tự tạo tab thay thế. Bước: "tabB-wait-profile-form".');
        }

        const tabB = state.tabB;
        context.page = tabB;

        // Đảm bảo TabB được đưa lên hàng đầu UI
        if (typeof tabB.bringToFront === 'function') {
          await tabB.bringToFront().catch(() => {});
        }

        await waitForProfileFormReady({
          page: tabB,
          stepName: 'tabB-wait-profile-form',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) return false;
        const loc = state.tabB.locator('input[aria-label="First name"]');
        return (await loc.count().catch(() => 0)) > 0;
      }
    },
    {
      id: 'tabB-input-first-name',
      name: 'TabB: Nhập First name',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập First name. Không tự tạo tab thay thế. Bước: "tabB-input-first-name".');
        }

        const tabB = state.tabB;
        context.page = tabB;

        await inputFirstName({
          page: tabB,
          stepName: 'tabB-input-first-name',
          firstName: 'Dang',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.firstName = 'Dang';
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) return false;
        const val = await state.tabB.locator('input[aria-label="First name"]').inputValue().catch(() => '');
        return val === 'Dang';
      }
    },
    {
      id: 'tabB-input-last-name',
      name: 'TabB: Nhập Last name',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập Last name. Không tự tạo tab thay thế. Bước: "tabB-input-last-name".');
        }

        const tabB = state.tabB;
        context.page = tabB;

        await inputLastName({
          page: tabB,
          stepName: 'tabB-input-last-name',
          lastName: 'Dao',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.lastName = 'Dao';
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) return false;
        const val = await state.tabB.locator('input[aria-label="Last name"]').inputValue().catch(() => '');
        return val === 'Dao';
      }
    },
    {
      id: 'tabB-select-year',
      name: 'TabB: Chọn Year 2000',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi chọn Year. Không tự tạo tab thay thế. Bước: "tabB-select-year".');
        }

        const tabB = state.tabB;
        context.page = tabB;

        await selectBirthYear({
          page: tabB,
          stepName: 'tabB-select-year',
          yearValue: '2000',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.birthYear = '2000';
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) return false;
        const val = await state.tabB.locator('select[aria-label="Year"], [aria-label="Year"]').inputValue().catch(() => '');
        return val === '2000';
      }
    },
    {
      id: 'tabB-submit-profile',
      name: 'TabB: Bấm nút tiếp tục',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi bấm tiếp tục. Không tự tạo tab thay thế. Bước: "tabB-submit-profile".');
        }

        const tabB = state.tabB;
        context.page = tabB;

        await submitProfileBirthday({
          page: tabB,
          stepName: 'tabB-submit-profile',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabB && !state.tabB.isClosed());
      }
    },
    {
      id: 'tabC-open-meta-security',
      name: 'TabC: Mở trang bảo mật Meta và chờ sẵn sàng',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        const browserContext = (state.tabB || state.tabA || context.page).context();

        context.logger.info('TabC: Đang tạo tab mới trong cùng browser context hiện tại (giữ nguyên TabA và TabB)...', {
          flow: 'yopmail-muse',
          step: 'tabC-open-meta-security'
        });

        const tabC = await browserContext.newPage();
        state.tabC = tabC;
        context.page = tabC;

        if (typeof tabC.setDefaultTimeout === 'function') {
          tabC.setDefaultTimeout(context.config.actionTimeoutMs);
        }
        if (typeof tabC.setDefaultNavigationTimeout === 'function') {
          tabC.setDefaultNavigationTimeout(context.config.navigationTimeoutMs);
        }

        const metaUrl = 'https://accountscenter.meta.com/password_and_security';
        context.logger.info(`TabC: Đang điều hướng đến: ${metaUrl}`, {
          flow: 'yopmail-muse',
          step: 'tabC-open-meta-security'
        });

        await tabC.goto(metaUrl, { timeout: context.config.navigationTimeoutMs });

        await waitForMetaSecurityPageReady({
          page: tabC,
          stepName: 'tabC-open-meta-security',
          timeoutMs: context.config.navigationTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-click-two-factor',
      name: 'TabC: Chọn mục "Xác thực 2 yếu tố"',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn Xác thực 2 yếu tố. Bước: "tabC-click-two-factor".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        const twoFactorItem = await waitForSingleMatchingElement({
          page: tabC,
          selector: '[aria-label="Xác thực 2 yếu tố"]',
          tabName: 'TabC',
          stepName: 'tabC-click-two-factor',
          timeoutMs: context.config.actionTimeoutMs,
          role: 'clickable',
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        context.logger.info('TabC: Đang click mục [aria-label="Xác thực 2 yếu tố"]...', {
          flow: 'yopmail-muse',
          step: 'tabC-click-two-factor'
        });
        await twoFactorItem.click();
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-click-start',
      name: 'TabC: Click nút "Bắt đầu"',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi click Bắt đầu. Bước: "tabC-click-start".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        context.logger.info('TabC: Đang tìm phần tử tương tác chứa span "Bắt đầu" trong khu vực hoặc dialog...', {
          flow: 'yopmail-muse',
          step: 'tabC-click-start'
        });

        const startBtn = await findInteractiveButtonWithSpanText({
          page: tabC,
          targetText: 'Bắt đầu',
          tabName: 'TabC',
          stepName: 'tabC-click-start',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        const isEnabled = await startBtn.isEnabled().catch(() => false);
        if (!isEnabled) {
          throw new Error('[LỖI NÚT BỊ VÔ HIỆU HÓA] TabC: Nút "Bắt đầu" đang bị vô hiệu hóa. Bước: "tabC-click-start".');
        }

        await startBtn.click();
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-select-sms-whatsapp',
      name: 'TabC: Chọn phương thức "SMS hoặc WhatsApp"',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn SMS hoặc WhatsApp. Bước: "tabC-select-sms-whatsapp".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        await selectSmsOrWhatsAppOption({
          page: tabC,
          stepName: 'tabC-select-sms-whatsapp',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-click-continue',
      name: 'TabC: Click nút "Tiếp tục"',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi click Tiếp tục. Bước: "tabC-click-continue".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        context.logger.info('TabC: Đang tìm nút tương tác chứa span "Tiếp tục" với nội dung chính xác trong dialog...', {
          flow: 'yopmail-muse',
          step: 'tabC-click-continue'
        });

        const continueBtn = await findInteractiveButtonWithSpanText({
          page: tabC,
          targetText: 'Tiếp tục',
          tabName: 'TabC',
          stepName: 'tabC-click-continue',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        const isEnabled = await continueBtn.isEnabled().catch(() => false);
        if (!isEnabled) {
          throw new Error('[LỖI NÚT BỊ VÔ HIỆU HÓA] TabC: Nút "Tiếp tục" đang bị vô hiệu hóa. Bước: "tabC-click-continue".');
        }

        await continueBtn.click();
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-input-phone',
      name: 'TabC: Nhập số điện thoại từ danh sách',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi nhập số điện thoại. Bước: "tabC-input-phone".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        // 1. Nạp số điện thoại nếu chưa có trong bộ nhớ
        if (!state.selectedPhone) {
          const filePath = context.config.phoneNumbersFile;
          if (!filePath) {
            throw new Error(
              '[LỖI CẤU HÌNH] Chưa cấu hình "phoneNumbersFile" để nạp danh sách số điện thoại. ' +
              'Hệ thống không tự ý tạo số điện thoại ngẫu nhiên để chạy thật. Bước: "tabC-input-phone".'
            );
          }

          context.logger.info(`TabC: Đang đọc danh sách số điện thoại từ file: "${filePath}"...`, {
            flow: 'yopmail-muse',
            step: 'tabC-input-phone'
          });

          const phones = readPhoneNumbersFromFile(filePath);
          state.selectedPhone = selectRandomPhone(phones);

          context.logger.info(
            `TabC: Đã chọn ngẫu nhiên một số điện thoại cho lần chạy này: "${maskPhoneNumber(state.selectedPhone)}" ` +
            `(đã bảo vệ bảo mật, lưu trong bộ nhớ và không thay đổi suốt luồng).`,
            { flow: 'yopmail-muse', step: 'tabC-input-phone' }
          );
        }

        // Tạm thời tắt chụp màn hình khi có lỗi để tránh lộ số điện thoại nếu chưa che
        const originalScreenshotOnError = context.config.screenshotOnError;
        context.config.screenshotOnError = false;

        try {
          await inputPhoneNumberOnTabC({
            page: tabC,
            stepName: 'tabC-input-phone',
            phone: state.selectedPhone,
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken,
            logger: context.logger
          });
        } finally {
          context.config.screenshotOnError = originalScreenshotOnError;
        }
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.selectedPhone && state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-confirm-and-next',
      name: 'TabC: Xác nhận quyền sử dụng và bấm nút "Tiếp"',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi bấm Tiếp. Bước: "tabC-confirm-and-next".');
        }
        if (!state.selectedPhone) {
          throw new Error('[LỖI TRẠNG THÁI] Chưa có số điện thoại được chọn. Bước: "tabC-confirm-and-next".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        await confirmAndClickNextButton({
          page: tabC,
          stepName: 'tabC-confirm-and-next',
          phone: state.selectedPhone,
          phoneMode: context.config.phoneMode,
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-verify-and-close-dialog',
      name: 'TabC: Chờ màn hình nhập mã và đóng dialog',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi đóng dialog. Bước: "tabC-verify-and-close-dialog".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        await waitForVerificationCodeAndCloseDialog({
          page: tabC,
          stepName: 'tabC-verify-and-close-dialog',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.twoFactorDialogClosed = true;
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.twoFactorDialogClosed === true);
      }
    }
  ]
};
