import { Page, Locator } from 'playwright';
import * as readline from 'readline';
import { Flow, FlowContext, CancellationToken } from '../runner/types';
import { ProxyConfig } from '../config/types';
import { isCancelled } from '../runner';
import { Logger } from '../utils/logger';
import { sanitizeUrl } from '../utils/sanitize';
import { safeGoto, safeReload, findWorkingProxy } from '../browser';
import {
  readPhoneNumbersFromFile,
  selectRandomPhone,
  maskPhoneNumber,
  isPhoneEquivalent
} from '../utils/phone';
import { saveEmailToOutputFile } from '../utils/output';

const LOWERCASE_CHARS = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT_CHARS = '0123456789';
const ALPHANUMERIC_CHARS = LOWERCASE_CHARS + DIGIT_CHARS;

/**
 * Sinh một chuỗi ngẫu nhiên có độ dài từ 10 đến 14 ký tự (tính cả hai đầu),
 * chỉ sử dụng chữ thường a-z và chữ số 0-9, bắt buộc chứa ít nhất một chữ cái và một chữ số.
 * Giữ nguyên để đảm bảo tương thích ngược nếu có module khác sử dụng.
 */
export function generateMailboxName(minLength = 10, maxLength = 14): string {
  if (minLength < 2) {
    throw new Error('minLength phải >= 2 để chứa ít nhất một chữ cái và một chữ số.');
  }
  const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;

  const letter = LOWERCASE_CHARS[Math.floor(Math.random() * LOWERCASE_CHARS.length)];
  const digit = DIGIT_CHARS[Math.floor(Math.random() * DIGIT_CHARS.length)];

  const chars: string[] = [letter, digit];
  for (let i = 2; i < length; i++) {
    const randomChar = ALPHANUMERIC_CHARS[Math.floor(Math.random() * ALPHANUMERIC_CHARS.length)];
    chars.push(randomChar);
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

export interface YopmailMuseState {
  mailboxName?: string;
  emailAddress?: string;
  tabA?: Page;
  tabB?: Page;
  otpCode?: string;
  firstName?: string;
  lastName?: string;
  birthYear?: string;
  tabC?: Page;
  selectedPhone?: string;
  twoFactorDialogClosed?: boolean;
  contactInfoOpened?: boolean;
  addMobileFormOpened?: boolean;
  reenteredPhone?: string;
  tabCNextSubmitted?: boolean;
  tabBReactivated?: boolean;
  tabBUrl?: string;
}

/**
 * Lấy hoặc khởi tạo trạng thái dùng chung cho luồng yopmail-muse.
 * Lưu trong bộ nhớ riêng của lần chạy luồng, không sinh lại hay thay đổi domain.
 */
export function getYopmailMuseState(context: FlowContext): YopmailMuseState {
  if (!context.data) {
    context.data = {};
  }
  return context.data as YopmailMuseState;
}

/**
 * Kiểm tra xem chuỗi có phải địa chỉ email hợp lệ ở mức cơ bản hay không.
 * Không chấp nhận placeholder hoặc nội dung đang tải.
 */
export function isValidBasicEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower.includes('đang tải') ||
    lower.includes('loading') ||
    lower.includes('...') ||
    lower.includes('placeholder')
  ) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Kiểm tra xem chuỗi có phải mã OTP 6 chữ số hợp lệ hay không.
 * Bảo toàn số 0 ở đầu bằng kiểu string.
 */
export function isValidOtpCode(code: unknown): code is string {
  return typeof code === 'string' && /^[0-9]{6}$/.test(code);
}

/**
 * Chuẩn hóa khoảng trắng: thay thế toàn bộ xuống dòng (\r, \n),
 * khoảng trắng không ngắt (\u00A0, \u200B) và tab thành khoảng trắng thông thường.
 */
export function normalizeOtpWhitespace(text: string): string {
  if (!text) return '';
  return text.replace(/[\u00A0\u200B\s]+/g, ' ').trim();
}

/**
 * Trích xuất mã OTP 6 chữ số từ nội dung thư:
 * Hỗ trợ các phương thức:
 * 1. Thẻ div/element có kiểu dáng style đặc trưng của Muse.ai:
 *    <div style="font-size: 24px;font-weight: 400;background: #F1F4F7;color: #1C2B33;border-radius: 4px;letter-spacing: 2px;padding: 16px;">065444</div>
 * 2. Cụm từ tiếng Anh: "Confirmation code XXXXXX", "Confirmation code: XXXXXX", "Confirmation code - XXXXXX"
 * 3. Cụm từ tiếng Việt: "Mã xác nhận XXXXXX", "Mã xác nhận: XXXXXX", "Mã xác nhận - XXXXXX"
 * 4. Loại trừ trùng lặp mã giống nhau, chỉ chấp nhận khi có duy nhất 1 giá trị OTP 6 số.
 * 5. Lưu dưới dạng string để bảo toàn số 0 ở đầu.
 */
export function extractOtpCode(text: string, rawHtml?: string): string {
  const combined = [text || '', rawHtml || ''].join('\n');
  const normalized = normalizeOtpWhitespace(combined);

  const matches: string[] = [];

  // 1. Quét theo thẻ HTML có style đặc trưng của Muse.ai
  const styledHtmlRegex = /<[^>]+style=["'][^"']*(?:24px|f1f4f7|letter-spacing)[^"']*["'][^>]*>(?:<[^>]*>)*\s*([0-9]{6})(?![0-9])/giu;
  let htmlMatch: RegExpExecArray | null;
  while ((htmlMatch = styledHtmlRegex.exec(combined)) !== null) {
    matches.push(htmlMatch[1]);
  }

  // 2. Quét theo cụm từ "Confirmation code" hoặc "Mã xác nhận" hoặc "Verification code"
  const textRegex = /(?:Confirmation\s+code|Mã\s+xác\s+nhận|Verification\s+code)\s*[:\-]?\s*["'\[]?([0-9]{6})(?![0-9])/giu;
  let textMatch: RegExpExecArray | null;
  while ((textMatch = textRegex.exec(normalized)) !== null) {
    matches.push(textMatch[1]);
  }

  // 3. Fallback: Nếu trong nội dung có chuỗi style chứa 24px / #F1F4F7 và kèm 6 số liền kề
  if (matches.length === 0) {
    const divBlockRegex = /(?:font-size:\s*24px|letter-spacing:\s*2px|#F1F4F7|f1f4f7)[^>]*>[\s\S]*?([0-9]{6})(?![0-9])/giu;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = divBlockRegex.exec(combined)) !== null) {
      matches.push(blockMatch[1]);
    }
  }

  const unique = Array.from(new Set(matches));

  if (unique.length === 0) {
    throw new Error(
      `[LỖI TRÍCH XUẤT OTP] Không tìm thấy mã xác nhận gồm đúng 6 chữ số sau cụm từ "Mã xác nhận", "Confirmation code" hoặc thẻ div style OTP trong nội dung thư.`
    );
  }

  if (unique.length > 1) {
    throw new Error(
      `[LỖI TRÍCH XUẤT OTP] Tìm thấy ${unique.length} mã OTP khác nhau trong nội dung thư. Dừng luồng để tránh lấy sai mã.`
    );
  }

  return unique[0];
}

/**
 * Giữ nguyên hàm kiểm tra kiểu dáng div OTP cũ để đảm bảo tương thích ngược nếu luồng khác cần.
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
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;

  const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
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
        } catch {}
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

    await checkCaptchaOrVerification(page, tabName, stepName);

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
          let isAriaDisabled = false;
          if (typeof target.getAttribute === 'function') {
            const ariaVal = await target.getAttribute('aria-disabled').catch(() => null);
            isAriaDisabled = ariaVal === 'true';
          }
          if (isEnabled && !isAriaDisabled) {
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

/**
 * Lấy địa chỉ email trên TabA từ Temp-Mail (https://temp-mail.io/vi):
 * a. Mở TabA tại https://temp-mail.io/vi (nếu chưa mở)
 * b. Chờ button[data-qa="random-button"] hiển thị và có thể thao tác, rồi click để tải email mới.
 * c. Chờ input#email tồn tại và có value hợp lệ (không rỗng, không placeholder/loading).
 * d. Đọc giá trị bằng inputValue(), không đọc attribute value.
 * e. Lưu nguyên địa chỉ vào emailAddress (không tự sinh tên, không đổi domain, không nối @yopmail.com).
 * f. Chờ button[data-qa="copy-button"] hiển thị và có thể thao tác, rồi click đúng một lần.
 * g. Sau khi click, kiểm tra input#email vẫn chứa emailAddress; nếu thay đổi thì dừng báo lỗi.
 */
export async function fetchEmailFromTempMail(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<string> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trước khi lấy email từ Temp-Mail. Bước: "${stepName}".`);
  }

  const startTime = Date.now();
  const pollIntervalMs = 250;

  // 1. Sau khi trang tải xong: Chờ button[data-qa="random-button"] hiển thị và có thể thao tác, rồi click để tải email mới
  logger?.info('TabA: Đang chờ nút random email (button[data-qa="random-button"]) hiển thị và có thể click...', {
    flow: 'yopmail-muse',
    step: stepName
  });

  const randomBtn = await waitForSingleMatchingElement({
    page,
    selector: 'button[data-qa="random-button"]',
    tabName: 'TabA',
    stepName,
    timeoutMs,
    role: 'clickable',
    cancellationToken,
    logger
  });

  logger?.info('TabA: Đang click button[data-qa="random-button"] để tải email mới...', {
    flow: 'yopmail-muse',
    step: stepName
  });
  await randomBtn.click();
  logger?.info('TabA: Đã click button[data-qa="random-button"]. Đang chờ input#email có giá trị mới...', {
    flow: 'yopmail-muse',
    step: stepName
  });

  // 2. Chờ input#email có giá trị hợp lệ qua inputValue()
  let emailAddress = '';
  const waitEmailStartTime = Date.now();

  while (Date.now() - waitEmailStartTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabA, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trong khi chờ email. Bước: "${stepName}".`);
    }

    await checkCaptchaOrVerification(page, 'TabA', stepName);
    await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });

    const inputLocator = page.locator('input#email');
    const count = await inputLocator.count().catch(() => 0);

    if (count > 0) {
      const inputEl = inputLocator.first();
      const isVis = await inputEl.isVisible().catch(() => false);
      if (isVis) {
        // Đọc giá trị bằng inputValue(), không đọc attribute value
        const rawValue = await inputEl.inputValue().catch(() => '');
        const trimmed = rawValue.trim();

        if (isValidBasicEmail(trimmed)) {
          emailAddress = trimmed;
          break;
        }
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Fallback: nếu đã hết thời gian mà trimmed vẫn là email hợp lệ
  if (!emailAddress) {
    try {
      const loc = page.locator('input#email');
      const target = typeof loc.first === 'function' ? loc.first() : loc;
      if (target && typeof target.inputValue === 'function') {
        const fallbackVal = ((await target.inputValue().catch(() => '')) || '').trim();
        if (isValidBasicEmail(fallbackVal)) {
          emailAddress = fallbackVal;
        }
      }
    } catch {}
  }

  if (!emailAddress || !isValidBasicEmail(emailAddress)) {
    throw new Error(
      `[LỖI EMAIL TEMP-MAIL] TabA: Quá thời gian (${timeoutMs}ms) mà chưa nhận được địa chỉ email hợp lệ từ input#email (không chấp nhận placeholder hoặc nội dung đang tải). Bước: "${stepName}".`
    );
  }

  logger?.info(`TabA: Đã đọc được địa chỉ email hợp lệ từ input#email qua inputValue(): "${emailAddress}".`, {
    flow: 'yopmail-muse',
    step: stepName
  });

  // 3. Chờ button[data-qa="copy-button"] hiển thị và có thể thao tác, rồi click đúng một lần
  logger?.info('TabA: Đang chờ nút Copy (button[data-qa="copy-button"]) hiển thị và có thể click...', {
    flow: 'yopmail-muse',
    step: stepName
  });

  const copyBtn = await waitForSingleMatchingElement({
    page,
    selector: 'button[data-qa="copy-button"]',
    tabName: 'TabA',
    stepName,
    timeoutMs,
    role: 'clickable',
    cancellationToken,
    logger
  });

  logger?.info('TabA: Đang click button[data-qa="copy-button"] đúng một lần...', {
    flow: 'yopmail-muse',
    step: stepName
  });
  await copyBtn.click();
  logger?.info('TabA: Đã click nút Copy thành công.', { flow: 'yopmail-muse', step: stepName });

  // 4. Sau khi click, kiểm tra input#email vẫn chứa emailAddress. Nếu email thay đổi, dừng báo lỗi
  const postClickLoc = page.locator('input#email');
  const postClickInput = typeof postClickLoc.first === 'function' ? postClickLoc.first() : postClickLoc;
  const postClickVal = (await postClickInput.inputValue().catch(() => '')).trim();

  if (postClickVal !== emailAddress) {
    throw new Error(
      `[LỖI EMAIL THAY ĐỔI] TabA: Địa chỉ email trong input#email đã thay đổi sau khi click nút Copy ("${postClickVal}" !== "${emailAddress}"). ` +
      `Dừng luồng ngay để tránh lệch hộp thư. Bước: "${stepName}".`
    );
  }

  logger?.info('TabA: Đã xác minh input#email vẫn giữ nguyên emailAddress sau khi click Copy.', {
    flow: 'yopmail-muse',
    step: stepName
  });

  return emailAddress;
}

/**
 * Kiểm tra xem danh sách thư trên Temp-Mail (.email-list hoặc aside.inbox) có thư thực tế hay chưa:
 * - Có ít nhất một mục thư thực tế trong danh sách.
 * - Không coi loading, spinner, skeleton hoặc thông báo hộp thư trống ("Không có tin nhắn", "Đang chờ tin nhắn đến") là dữ liệu thư.
 */
export async function hasActualMailInList(page: Page): Promise<{ hasMail: boolean; mailLocators: Locator[] }> {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    return { hasMail: false, mailLocators: [] };
  }

  const mailLocators: Locator[] = [];

  // Tìm trong .email-list hoặc các selector mục thư trên Temp-Mail:
  // Temp-Mail render danh sách thư trong ul.email-list với các thẻ li.message[data-qa="message"]
  const candidateSelectors = [
    '.email-list [data-qa="message"]',
    '.email-list li.message',
    '.email-list .message',
    'aside.inbox [data-qa="message"]',
    'aside.inbox li.message',
    '[data-qa="message"]',
    'li.message'
  ];

  for (const sel of candidateSelectors) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const item = loc.nth(i);
        const isVis = await item.isVisible().catch(() => false);
        if (!isVis) continue;

        // Kiểm tra loại trừ loading, spinner, skeleton và thông báo trống
        const isLoader = typeof item.locator === 'function' ? (await item.locator('[data-qa="loader"], .animate-spin').count().catch(() => 0)) > 0 : false;
        if (isLoader) continue;

        const text = (await item.innerText().catch(() => '')).trim().toLowerCase();
        if (
          text.includes('không có tin nhắn') ||
          text.includes('đang chờ tin nhắn') ||
          text.includes('saved messages loader')
        ) {
          continue;
        }

        mailLocators.push(item);
      }
      if (mailLocators.length > 0) {
        break;
      }
    }
  }

  // Nếu không tìm thấy bằng selector class chuẩn, thử kiểm tra các phần tử con trực tiếp của .email-list
  if (mailLocators.length === 0) {
    const emailListLoc = page.locator('.email-list');
    const hasEmailList = (await emailListLoc.count().catch(() => 0)) > 0;
    if (hasEmailList) {
      const children = emailListLoc.first().locator('> li, > div');
      const childCount = await children.count().catch(() => 0);
      for (let i = 0; i < childCount; i++) {
        const child = children.nth(i);
        const isVis = await child.isVisible().catch(() => false);
        if (!isVis) continue;

        const isLoader = typeof child.locator === 'function' ? (await child.locator('[data-qa="loader"], .animate-spin').count().catch(() => 0)) > 0 : false;
        if (isLoader) continue;

        const text = (await child.innerText().catch(() => '')).trim().toLowerCase();
        if (
          text.includes('không có tin nhắn') ||
          text.includes('đang chờ tin nhắn') ||
          text.includes('saved messages loader')
        ) {
          continue;
        }

        mailLocators.push(child);
      }
    }
  }

  return {
    hasMail: mailLocators.length > 0,
    mailLocators
  };
}

/**
 * Chờ thư thực tế xuất hiện trên Temp-Mail với cơ chế refresh chuẩn theo yêu cầu:
 * - Nếu đã có thư thực tế, bỏ qua refresh.
 * - Nếu chưa có thư:
 *   1. Chờ 3 giây, có thể ngắt bằng tín hiệu hủy (Ctrl+C).
 *   2. Kiểm tra lại danh sách; nếu đã có thư thì không click.
 *   3. Nếu vẫn trống, click: button[data-qa="refresh-button"]
 *   4. Tăng bộ đếm sau khi thực sự click.
 *   5. Quan sát danh sách trong khoảng chờ tiếp theo.
 *   6. Chỉ refresh tiếp nếu vẫn chưa có thư.
 * - Tổng cộng tối đa 3 lần click refresh cho bước này.
 * - Khoảng cách giữa hai lần click ít nhất 3 giây.
 * - Sau lần click thứ 3, vẫn chờ tối đa 3 giây để thư xuất hiện.
 * - Dừng refresh ngay khi danh sách có thư thực tế.
 * - Nếu hết số lần và thời gian chờ mà danh sách vẫn trống:
 *   Dừng luồng. Báo "Chưa nhận được thư sau tối đa 3 lần refresh".
 */
export async function waitForTempMailWithRefresh(options: {
  page: Page;
  stepName: string;
  cycleWaitMs?: number;
  maxRefreshes?: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
  onRefreshClick?: (clickCount: number) => Promise<void>;
}): Promise<Locator[]> {
  const { page, stepName, cancellationToken, logger, onRefreshClick } = options;
  const cycleWaitMs = options.cycleWaitMs ?? 5000;
  const maxRefreshes = options.maxRefreshes ?? 3;
  const pollSliceMs = 200;

  // 1. Kiểm tra ban đầu: Nếu đã có thư thực tế, bỏ qua refresh
  const initialCheck = await hasActualMailInList(page);
  if (initialCheck.hasMail) {
    logger?.info('TabA: Đã có thư thực tế trong danh sách hộp thư. Bỏ qua refresh.', { flow: 'yopmail-muse', step: stepName });
    return initialCheck.mailLocators;
  }

  let refreshClickCount = 0;

  while (refreshClickCount < maxRefreshes) {
    logger?.info(
      `TabA: Chưa có thư trong hộp thư. Chờ chu kỳ ${cycleWaitMs / 1000}s trước khi cân nhắc refresh lần ${refreshClickCount + 1}/${maxRefreshes}...`,
      { flow: 'yopmail-muse', step: stepName }
    );

    // Chu kỳ chờ 3 giây, có thể ngắt bằng tín hiệu hủy; quan sát nếu thư tự đến thì dừng không click thừa
    const waitStart = Date.now();
    let mailAppearedDuringWait = false;

    while (Date.now() - waitStart < cycleWaitMs) {
      if (isCancelled(cancellationToken)) {
        throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabA trong khi chờ thư. Bước: "${stepName}".`);
      }
      if (page.isClosed()) {
        throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trong khi chờ thư. Bước: "${stepName}".`);
      }

      await checkCaptchaOrVerification(page, 'TabA', stepName);
      await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });

      const check = await hasActualMailInList(page);
      if (check.hasMail) {
        logger?.info('TabA: Thư thực tế đã tự xuất hiện trong khoảng thời gian chờ. Dừng không click refresh thừa.', {
          flow: 'yopmail-muse',
          step: stepName
        });
        mailAppearedDuringWait = true;
        return check.mailLocators;
      }

      await new Promise((r) => setTimeout(r, pollSliceMs));
    }

    if (mailAppearedDuringWait) {
      break;
    }

    // Kiểm tra lại danh sách; nếu đã có thư thì không click
    const recheck = await hasActualMailInList(page);
    if (recheck.hasMail) {
      logger?.info('TabA: Đã có thư thực tế sau chu kỳ chờ. Không click refresh.', {
        flow: 'yopmail-muse',
        step: stepName
      });
      return recheck.mailLocators;
    }

    // Nếu vẫn trống: click button[data-qa="refresh-button"]
    logger?.info(
      `TabA: Danh sách vẫn trống sau ${cycleWaitMs / 1000}s. Thực hiện click button[data-qa="refresh-button"] lần ${refreshClickCount + 1}/${maxRefreshes}...`,
      { flow: 'yopmail-muse', step: stepName }
    );

    if (onRefreshClick) {
      await onRefreshClick(refreshClickCount + 1);
    } else {
      const refreshBtnLoc = page.locator('button[data-qa="refresh-button"]');
      const count = await refreshBtnLoc.count().catch(() => 0);
      if (count === 0) {
        throw new Error(
          `[LỖI CẤU TRÚC DOM] TabA: Không tìm thấy nút làm mới (selector 'button[data-qa="refresh-button"]'). ` +
          `Không tự đoán selector thay thế. Bước: "${stepName}".`
        );
      }
      const refreshBtn = refreshBtnLoc.first();
      await refreshBtn.click({ timeout: 5000 });
    }

    // Tăng bộ đếm sau khi thực sự click
    refreshClickCount++;
    logger?.info(`TabA: Đã click refresh lần ${refreshClickCount}/${maxRefreshes}.`, { flow: 'yopmail-muse', step: stepName });
    await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });
  }

  // Sau lần click thứ 3, vẫn chờ tối đa 3 giây để thư xuất hiện
  logger?.info(`TabA: Đã thực hiện tối đa ${maxRefreshes} lần click refresh. Chờ tối đa ${cycleWaitMs / 1000}s cuối để thư xuất hiện...`, {
    flow: 'yopmail-muse',
    step: stepName
  });

  const finalWaitStart = Date.now();
  while (Date.now() - finalWaitStart < cycleWaitMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabA trong khi chờ thư sau lần refresh cuối.`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng sau lần refresh cuối.`);
    }

    await checkCaptchaOrVerification(page, 'TabA', stepName);
    await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });

    const finalCheck = await hasActualMailInList(page);
    if (finalCheck.hasMail) {
      logger?.info('TabA: Thư thực tế đã xuất hiện sau lần refresh thứ 3.', { flow: 'yopmail-muse', step: stepName });
      return finalCheck.mailLocators;
    }

    await new Promise((r) => setTimeout(r, pollSliceMs));
  }

  // Nếu hết số lần và thời gian chờ mà danh sách vẫn trống: Dừng luồng và báo chính xác
  throw new Error('Chưa nhận được thư sau tối đa 3 lần refresh');
}

/**
 * Xác định thư Muse.ai và lấy nội dung từ .message__body:
 * - Khi danh sách có dữ liệu, xác định thư tương ứng với yêu cầu đăng nhập Muse vừa thực hiện.
 * - Kiểm tra DOM thực tế để xác định mục thư có thể click.
 * - Không mặc định danh sách có dữ liệu đồng nghĩa nội dung thư đã được mở.
 * - Nếu cần, click mục thư phù hợp rồi chờ .message__body hiển thị và có nội dung.
 * - Nếu nội dung đúng thư đã mở sẵn, không click lại.
 * - Không dùng .first() tùy tiện khi có nhiều thư.
 * - Nếu có nhiều thư mà không xác định được thư cần đọc: dừng báo lỗi.
 * - Nếu nội dung nằm trong iframe, xác minh cấu trúc thực tế và đọc trong đúng frame.
 */
export async function findAndReadMuseMessageBody(options: {
  page: Page;
  mailLocators: Locator[];
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<string> {
  const { page, mailLocators, stepName, timeoutMs, cancellationToken, logger } = options;

  if (mailLocators.length === 0) {
    throw new Error(`[LỖI DANH SÁCH THƯ TRỐNG] Không có thư nào trong danh sách. Bước: "${stepName}".`);
  }

  // 1. Xác định thư Muse.ai
  let targetMail: Locator | undefined;

  if (mailLocators.length === 1) {
    targetMail = mailLocators[0];
  } else {
    // Có nhiều thư: Lọc thư khớp với Muse.ai
    const museMatches: Locator[] = [];
    for (const loc of mailLocators) {
      const text = (await loc.innerText().catch(() => '')).toLowerCase();
      if (text.includes('muse') || text.includes('muse.ai')) {
        museMatches.push(loc);
      }
    }

    if (museMatches.length === 1) {
      targetMail = museMatches[0];
    } else if (museMatches.length > 1) {
      throw new Error(
        `[LỖI THƯ TRÙNG LẶP] Tìm thấy ${museMatches.length} thư có nội dung liên quan đến Muse.ai. ` +
        `Không tự ý chọn phần tử đầu tiên (.first()) để tránh đọc nhầm thư cũ. Bước: "${stepName}".`
      );
    } else {
      throw new Error(
        `[LỖI KHÔNG TÌM THẤY THƯ PHÙ HỢP] Có ${mailLocators.length} thư trong hộp thư nhưng không có thư nào phù hợp với yêu cầu đăng nhập Muse.ai. ` +
        `Bước: "${stepName}".`
      );
    }
  }

  // 2. Kiểm tra xem nội dung đúng thư đã mở sẵn hay chưa
  // Trên Temp-Mail, khi mở một thư, giao diện MessageReader hiển thị
  // hoặc .message__body trong thư/trang đọc thư đã có nội dung
  const startTime = Date.now();
  const pollIntervalMs = 250;

  // Kiểm tra nếu nội dung đúng thư đã mở sẵn trên trang
  const isMessageViewOpen = async (): Promise<string | null> => {
    // a. Kiểm tra .message__body trên main page
    const pageBodyLoc = page.locator('.message__body');
    const pageBodyCount = await pageBodyLoc.count().catch(() => 0);
    for (let i = 0; i < pageBodyCount; i++) {
      const item = pageBodyLoc.nth(i);
      const isVis = await item.isVisible().catch(() => false);
      if (isVis) {
        const text = (await item.innerText().catch(() => '')) || (await item.textContent().catch(() => '')) || '';
        const html = typeof item.innerHTML === 'function' ? await item.innerHTML().catch(() => '') : '';
        const combined = `${text}\n${html}`;
        if (
          combined.trim().length > 0 &&
          (/Mã\s+xác\s+nhận/i.test(combined) ||
           /Confirmation\s+code/i.test(combined) ||
           /Verification\s+code/i.test(combined) ||
           matchesOtpDivStyle(html) ||
           /24px/i.test(html) ||
           /f1f4f7/i.test(html))
        ) {
          return html ? `${text}\n${html}` : text;
        }
      }
    }

    // b. Kiểm tra các frame nếu nội dung nằm trong iframe
    if (typeof page.frames === 'function') {
      const frames = page.frames() || [];
      for (const frame of frames) {
        try {
          if (typeof frame.locator !== 'function') continue;
          const frameBodyLoc = frame.locator('.message__body');
          const frameBodyCount = await frameBodyLoc.count().catch(() => 0);
          for (let i = 0; i < frameBodyCount; i++) {
            const item = frameBodyLoc.nth(i);
            const isVis = await item.isVisible().catch(() => false);
            if (isVis) {
              const text = (await item.innerText().catch(() => '')) || (await item.textContent().catch(() => '')) || '';
              const html = typeof item.innerHTML === 'function' ? await item.innerHTML().catch(() => '') : '';
              const combined = `${text}\n${html}`;
              if (
                combined.trim().length > 0 &&
                (/Mã\s+xác\s+nhận/i.test(combined) ||
                 /Confirmation\s+code/i.test(combined) ||
                 /Verification\s+code/i.test(combined) ||
                 matchesOtpDivStyle(html) ||
                 /24px/i.test(html) ||
                 /f1f4f7/i.test(html))
              ) {
                return html ? `${text}\n${html}` : text;
              }
            }
          }
        } catch {}
      }
    }

    return null;
  };

  const alreadyOpenContent = await isMessageViewOpen();
  if (alreadyOpenContent) {
    logger?.info('TabA: Nội dung đúng thư đã mở sẵn trên giao diện. Không click lại.', { flow: 'yopmail-muse', step: stepName });
    return alreadyOpenContent;
  }

  // 3. Nếu chưa mở: Click mục thư phù hợp rồi chờ .message__body hiển thị và có nội dung
  logger?.info('TabA: Đang click vào mục thư phù hợp để mở nội dung...', { flow: 'yopmail-muse', step: stepName });
  await targetMail.click();
  logger?.info('TabA: Đã click mở thư. Chờ .message__body hiển thị và có nội dung...', { flow: 'yopmail-muse', step: stepName });

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabA trong khi chờ nội dung thư.`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng khi đang chờ nội dung thư.`);
    }

    await checkCaptchaOrVerification(page, 'TabA', stepName);
    await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });

    // Kiểm tra trên trang chính
    const bodyLoc = page.locator('.message__body');
    const bodyCount = await bodyLoc.count().catch(() => 0);
    if (bodyCount > 0) {
      for (let i = 0; i < bodyCount; i++) {
        const item = bodyLoc.nth(i);
        const isVis = await item.isVisible().catch(() => false);
        if (isVis) {
          const text = (await item.innerText().catch(() => '')) || (await item.textContent().catch(() => '')) || '';
          const html = typeof item.innerHTML === 'function' ? await item.innerHTML().catch(() => '') : '';
          if (text.trim().length > 0 || html.trim().length > 0) {
            return html ? `${text}\n${html}` : text;
          }
        }
      }
    }

    // Kiểm tra trong tất cả các iframe nếu nội dung nằm trong iframe
    if (typeof page.frames === 'function') {
      const frames = page.frames() || [];
      for (const frame of frames) {
        try {
          if (typeof frame.locator !== 'function') continue;
          const frameBodyLoc = frame.locator('.message__body');
          const count = await frameBodyLoc.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const item = frameBodyLoc.nth(i);
            const isVis = await item.isVisible().catch(() => false);
            if (isVis) {
              const text = (await item.innerText().catch(() => '')) || (await item.textContent().catch(() => '')) || '';
              const html = typeof item.innerHTML === 'function' ? await item.innerHTML().catch(() => '') : '';
              if (text.trim().length > 0 || html.trim().length > 0) {
                return html ? `${text}\n${html}` : text;
              }
            }
          }
        } catch {}
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] TabA: Quá thời gian (${timeoutMs}ms) khi chờ selector ".message__body" hiển thị và có nội dung trong thư đã mở. Bước: "${stepName}".`
  );
}

/**
 * Chờ thư trên Temp-Mail, mở đúng thư và trích xuất mã OTP 6 chữ số:
 * - Kiểm tra TabA còn mở.
 * - Kiểm tra input#email vẫn đúng bằng emailAddress.
 * - Kiểm tra .email-list có thư thực sự hay chưa và thực hiện cơ chế refresh (tối đa 3 lần).
 * - Mở đúng thư Muse.ai và trích xuất mã OTP từ .message__body.
 * - Tuyệt đối không log mã OTP hay nội dung thư.
 */
export async function extractOtpFromTempMail(options: {
  page: Page;
  emailAddress: string;
  stepName: string;
  timeoutMs: number;
  cycleWaitMs?: number;
  maxRefreshes?: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
  onRefreshClick?: (clickCount: number) => Promise<void>;
}): Promise<string> {
  const { page, emailAddress, stepName, timeoutMs, cycleWaitMs, maxRefreshes, cancellationToken, logger, onRefreshClick } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trước khi chờ thư. Bước: "${stepName}".`);
  }

  // 1. Kiểm tra input#email vẫn đúng bằng emailAddress
  const emailInput = page.locator('input#email').first();
  const currentEmailVal = (await emailInput.inputValue().catch(() => '')).trim();

  if (currentEmailVal !== emailAddress) {
    throw new Error(
      `[LỖI EMAIL THAY ĐỔI] TabA: Địa chỉ email hiện tại trong input#email ("${currentEmailVal}") không khớp với emailAddress đã lấy ("${emailAddress}"). ` +
      `Dừng luồng để tránh lệch hộp thư. Bước: "${stepName}".`
    );
  }

  logger?.info('TabA: Đã xác minh input#email vẫn đúng bằng emailAddress trước khi chờ thư.', {
    flow: 'yopmail-muse',
    step: stepName
  });

  // 2. Chờ thư và thực hiện cơ chế refresh tối đa 3 lần
  const mailLocators = await waitForTempMailWithRefresh({
    page,
    stepName,
    cycleWaitMs,
    maxRefreshes,
    cancellationToken,
    logger,
    onRefreshClick
  });

  // 3. Mở đúng thư Muse và đọc nội dung .message__body
  const bodyText = await findAndReadMuseMessageBody({
    page,
    mailLocators,
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

  // 4. Trích xuất mã OTP 6 chữ số (hỗ trợ Mã xác nhận, Confirmation code, div style OTP)
  let otpCode: string;
  try {
    otpCode = extractOtpCode(bodyText);
  } catch (err) {
    const domOtp = await extractOtpFromPageDom(page);
    if (domOtp && isValidOtpCode(domOtp)) {
      otpCode = domOtp;
    } else {
      throw err;
    }
  }

  if (!isValidOtpCode(otpCode)) {
    throw new Error(`[LỖI OTP] Mã trích xuất "${otpCode}" không thỏa mãn định dạng đúng 6 chữ số.`);
  }

  return otpCode;
}

/**
 * Quét trực tiếp trên DOM của TabA tìm thẻ div/element có style OTP chứa mã 6 chữ số.
 */
export async function extractOtpFromPageDom(page: Page): Promise<string | null> {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    return null;
  }

  try {
    const candidates = page.locator('div[style*="24px"], div[style*="F1F4F7"], div[style*="f1f4f7"], div[style*="letter-spacing"]');
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      const isVis = await el.isVisible().catch(() => false);
      if (isVis) {
        const txt = (await el.innerText().catch(() => '')).trim();
        if (/^[0-9]{6}$/.test(txt)) {
          return txt;
        }
      }
    }

    if (typeof page.frames === 'function') {
      const frames = page.frames() || [];
      for (const frame of frames) {
        try {
          if (typeof frame.locator !== 'function') continue;
          const fCandidates = frame.locator('div[style*="24px"], div[style*="F1F4F7"], div[style*="f1f4f7"], div[style*="letter-spacing"]');
          const fCount = await fCandidates.count().catch(() => 0);
          for (let j = 0; j < fCount; j++) {
            const el = fCandidates.nth(j);
            const isVis = await el.isVisible().catch(() => false);
            if (isVis) {
              const txt = (await el.innerText().catch(() => '')).trim();
              if (/^[0-9]{6}$/.test(txt)) {
                return txt;
              }
            }
          }
        } catch {}
      }
    }
  } catch {}

  return null;
}

/**
 * Giữ nguyên hàm waitForSingleMatchingMailItem cũ để tương thích ngược nếu luồng khác cần.
 */
export async function waitForSingleMatchingMailItem(options: {
  page: Page;
  tabName: 'TabA';
  stepName: string;
  timeoutMs?: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
  maxRetries?: number;
  retryIntervalMs?: number;
  onRetry?: (retryIndex: number) => Promise<void>;
}): Promise<Locator> {
  const { page, tabName, stepName, timeoutMs = 15000, cancellationToken, logger, onRetry } = options;
  const maxRetries = options.maxRetries ?? 0;
  const retryIntervalMs = options.retryIntervalMs ?? 5000;
  const pollIntervalMs = 300;

  const startTime = Date.now();
  let lastRefreshTime = Date.now();
  let retriesDone = 0;

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
    await dismissPopupIfPresent(page, logger, { flow: 'yopmail-muse', step: stepName });

    const lmLocators: Locator[] = [];
    if (typeof page.locator === 'function') {
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

    if (maxRetries > 0 && Date.now() - lastRefreshTime >= retryIntervalMs) {
      if (retriesDone < maxRetries) {
        retriesDone++;
        if (onRetry) {
          await onRetry(retriesDone);
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

  throw new Error(`[LỖI TIMEOUT] ${tabName}: Quá thời gian (${timeoutMs}ms) khi chờ thư mới xuất hiện.`);
}

/**
 * Giữ nguyên hàm extractOtpFromMailContent cũ để tương thích ngược nếu luồng khác cần.
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

    const candidates = await page
      .evaluate(() => {
        const divs = Array.from(document.querySelectorAll('div'));
        const matches: string[] = [];
        for (const div of divs) {
          const text = (div.textContent || '').trim();
          if (!/^[0-9]{6}$/.test(text)) continue;
          matches.push(text);
        }
        return matches;
      })
      .catch(() => []);

    if (candidates.length === 1) {
      return candidates[0];
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`[LỖI TIMEOUT] Quá thời gian (${timeoutMs}ms) khi chờ trích xuất mã OTP.`);
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

  if (typeof page.bringToFront === 'function') {
    await page.bringToFront().catch(() => {});
  }
  if (typeof page.evaluate === 'function') {
    await page.evaluate(() => window.focus()).catch(() => {});
  }

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

  const totalDigits = await pinDigitLocator.count();
  const firstTag = await pinDigitLocator.first().evaluate((e) => e.tagName.toLowerCase());

  let actualValue = '';

  if (firstTag === 'input') {
    if (totalDigits === 1) {
      const singleInput = pinDigitLocator.first();
      await singleInput.fill(otpCode);
      actualValue = await singleInput.inputValue();
    } else if (totalDigits === 6) {
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
    const groupAncestor = pinDigitLocator.first().locator('xpath=ancestor::div[.//input][1]');
    const groupInputs = groupAncestor.locator('input');
    const inputCount = await groupInputs.count();

    if (inputCount === 1) {
      const realInput = groupInputs.first();
      await realInput.fill(otpCode);
      actualValue = await realInput.inputValue();
    } else if (inputCount === 6) {
      let combined = '';
      for (let i = 0; i < 6; i++) {
        const dInput = groupInputs.nth(i);
        await dInput.fill(otpCode[i]);
        combined += await dInput.inputValue();
      }
      actualValue = combined;
    } else {
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

  if (actualValue !== otpCode) {
    throw new Error(
      `[LỖI KIỂM TRA MÃ NHẬP] Giá trị trong ô nhập sau khi điền không khớp với mã OTP đã trích xuất. ` +
      `Dừng và không bấm xác nhận.`
    );
  }
}

export async function safeGetLocCount(loc: any): Promise<number> {
  if (!loc) return 0;
  try {
    if (typeof loc.count === 'function') {
      return await loc.count().catch(() => 0);
    }
    if (
      typeof loc.inputValue === 'function' ||
      typeof loc.isVisible === 'function' ||
      typeof loc.click === 'function' ||
      typeof loc.nth === 'function' ||
      typeof loc.first === 'function'
    ) {
      return 1;
    }
  } catch {
    return 0;
  }
  return 0;
}

export async function safeCheckLocVisible(loc: any): Promise<boolean> {
  if (!loc) return false;
  try {
    if (typeof loc.isVisible === 'function') {
      return await loc.isVisible().catch(() => false);
    }
    if (typeof loc.first === 'function') {
      const el = loc.first();
      if (el && typeof el.isVisible === 'function') {
        return await el.isVisible().catch(() => false);
      }
    }
    if (typeof loc.nth === 'function') {
      const el = loc.nth(0);
      if (el && typeof el.isVisible === 'function') {
        return await el.isVisible().catch(() => false);
      }
    }
    if (typeof loc.inputValue === 'function' || typeof loc.fill === 'function' || typeof loc.click === 'function') {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function safeCheckLocEnabled(loc: any): Promise<boolean> {
  if (!loc) return false;
  try {
    if (typeof loc.isEnabled === 'function') {
      return await loc.isEnabled().catch(() => false);
    }
    if (typeof loc.first === 'function') {
      const el = loc.first();
      if (el && typeof el.isEnabled === 'function') {
        return await el.isEnabled().catch(() => false);
      }
    }
    if (typeof loc.nth === 'function') {
      const el = loc.nth(0);
      if (el && typeof el.isEnabled === 'function') {
        return await el.isEnabled().catch(() => false);
      }
    }
  } catch {
    return false;
  }
  return false;
}

export async function safeLocClick(loc: any): Promise<void> {
  if (!loc) return;
  if (typeof loc.click === 'function') {
    await loc.click();
  } else if (typeof loc.first === 'function') {
    const el = loc.first();
    if (el && typeof el.click === 'function') {
      await el.click();
    }
  } else if (typeof loc.nth === 'function') {
    const el = loc.nth(0);
    if (el && typeof el.click === 'function') {
      await el.click();
    }
  }
}

export async function safeGetLocInputValue(loc: any): Promise<string> {
  if (!loc) return '';
  const targets = [
    typeof loc.first === 'function' ? loc.first() : null,
    typeof loc.nth === 'function' ? loc.nth(0) : null,
    loc
  ].filter(Boolean);

  for (const t of targets) {
    try {
      if (typeof t.inputValue === 'function') {
        const val = await t.inputValue().catch(() => '');
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
      if (typeof t.locator === 'function') {
        const slotVal = t.locator('[data-slot="select-value"]');
        if (typeof slotVal.count === 'function' && (await safeGetLocCount(slotVal)) > 0) {
          const slotTarget = typeof slotVal.first === 'function' ? slotVal.first() : (typeof slotVal.nth === 'function' ? slotVal.nth(0) : slotVal);
          if (typeof slotTarget.innerText === 'function') {
            const txt = await slotTarget.innerText().catch(() => '');
            if (txt && txt.trim()) return txt.trim();
          }
        }
      }
      if (typeof t.innerText === 'function') {
        const txt = await t.innerText().catch(() => '');
        if (txt && txt.trim()) return txt.trim();
      }
      if (typeof t.textContent === 'function') {
        const txt = await t.textContent().catch(() => '');
        if (txt && txt.trim()) return txt.trim();
      }
    } catch {
      // Tiếp tục thử target tiếp theo
    }
  }

  return '';
}

export const FIRST_NAME_CANDIDATE_SELECTORS = [
  'input[aria-label="First name"]',
  'input[aria-label*="First" i]',
  'input[placeholder*="First" i]',
  'input[name*="first" i]',
  'input[aria-label="First name"]',
  'input[aria-label="Tên"]',
  'input[aria-label*="First" i]',
  'input[aria-label*="Tên" i]',
  'input[placeholder*="First" i]',
  'input[placeholder*="Tên" i]',
  'input[autocomplete*="given-name" i]',
  'input[name*="first" i]',
  'input#first-name',
  'input#firstName'
];

export const LAST_NAME_CANDIDATE_SELECTORS = [
  'input[aria-label="Last name"]',
  'input[aria-label="Họ"]',
  'input[aria-label*="Last" i]',
  'input[aria-label*="Họ" i]',
  'input[placeholder*="Last" i]',
  'input[placeholder*="Họ" i]',
  'input[autocomplete*="family-name" i]',
  'input[name*="last" i]',
  'input#last-name',
  'input#lastName'
];

export const YEAR_CANDIDATE_SELECTORS = [
  'select[aria-label="Year"]',
  'select[aria-label*="Year" i]',
  'select[aria-label="Năm"]',
  'select[aria-label*="Năm" i]',
  'button[data-slot="select-trigger"][aria-label="Năm"]',
  'button[data-slot="select-trigger"][aria-label="Year"]',
  'button[data-slot="select-trigger"][aria-label*="Năm" i]',
  'button[data-slot="select-trigger"][aria-label*="Year" i]',
  'button[role="combobox"][aria-label*="Năm" i]',
  'button[role="combobox"][aria-label*="Year" i]',
  '[data-slot="select-trigger"][aria-label*="Năm" i]',
  '[data-slot="select-trigger"][aria-label*="Year" i]',
  'button[data-slot="select-trigger"]',
  'select[autocomplete="bday-year"]',
  'select:has(option[value="2000"])',
  'select[name*="year" i]',
  'select#year',
  '[aria-label*="Year" i]',
  '[aria-label*="Năm" i]'
];

/**
 * Tìm kiếm phần tử form thông tin cá nhân dựa trên danh sách selector ứng viên theo thứ tự ưu tiên.
 * Quét tức thì không delay, có input là trả về ngay để nhập luôn.
 */
export async function waitForProfileField(options: {
  page: Page;
  candidateSelectors: string[];
  tabName: 'TabB';
  stepName: string;
  timeoutMs: number;
  role?: 'input' | 'clickable';
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<{ locator: Locator; selector: string }> {
  const { page, candidateSelectors, tabName, stepName, timeoutMs, cancellationToken, logger } = options;
  const startTime = Date.now();
  const pollIntervalMs = 30;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại ${tabName}, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng. Bước: "${stepName}".`);
    }
    await checkCaptchaOrVerification(page, tabName, stepName);

    // Quét tức thì tất cả selectors (không chờ timeout từng selector)
    for (const sel of candidateSelectors) {
      const loc = page.locator(sel);
      if ((await safeGetLocCount(loc)) > 0 && (await safeCheckLocVisible(loc))) {
        const target = typeof loc.first === 'function' ? loc.first() : (typeof loc.nth === 'function' ? loc.nth(0) : loc);
        logger?.info(`${tabName}: Đã phát hiện ô input "${sel}" sẵn sàng (nhập luôn không delay).`, {
          flow: 'yopmail-muse',
          step: stepName
        });
        return { locator: target, selector: sel };
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] ${tabName}: Quá thời gian (${timeoutMs}ms) khi chờ các selector [${candidateSelectors.join(', ')}] hiển thị và có thể thao tác. Bước: "${stepName}".`
  );
}

/**
 * Chờ form thông tin cá nhân trên TabB sẵn sàng bằng điều kiện DOM:
 * Kiểm tra TabB còn mở, chờ ô First name hiển thị và có thể nhập.
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

  logger?.info(`TabB: Đang kiểm tra form thông tin sẵn sàng...`, {
    flow: 'yopmail-muse',
    step: stepName
  });

  try {
    const res = await waitForProfileField({
      page,
      candidateSelectors: FIRST_NAME_CANDIDATE_SELECTORS,
      tabName: 'TabB',
      stepName,
      timeoutMs,
      role: 'input',
      cancellationToken,
      logger
    });

    logger?.info(`TabB: Form thông tin cá nhân đã sẵn sàng (${res.selector} hiển thị và có thể nhập).`, {
      flow: 'yopmail-muse',
      step: stepName
    });
    return res.locator;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('[LỖI TIMEOUT]') || msg.includes('Quá thời gian')) {
      throw new Error(
        `[LỖI CHỜ FORM THÔNG TIN] TabB: Form thông tin cá nhân không xuất hiện sau khi xác nhận OTP trong thời gian ${timeoutMs}ms.\n` +
        `Quy tắc an toàn: Dừng luồng ngay tại bước chờ form thông tin, tuyệt đối KHÔNG tự động bấm lại nút xác nhận OTP. Bước: "${stepName}".`
      );
    }
    throw err;
  }
}

/**
 * Nhập First name trên TabB (có input là nhập luôn không delay).
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

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập First name. Bước: "${stepName}".`);
  }

  const res = await waitForProfileField({
    page,
    candidateSelectors: FIRST_NAME_CANDIDATE_SELECTORS,
    tabName: 'TabB',
    stepName,
    timeoutMs,
    role: 'input',
    cancellationToken,
    logger
  });

  const inputLoc = res.locator;
  // Nhập luôn trực tiếp bằng fill() mà không cần delay click
  await inputLoc.fill(valueToFill);

  const actualValue = await safeGetLocInputValue(inputLoc);
  if (actualValue !== valueToFill) {
    throw new Error(
      `[LỖI GIÁ TRỊ FIRST NAME] TabB: Giá trị nhập vào ô "${res.selector}" là "${actualValue}", không khớp với giá trị yêu cầu "${valueToFill}".\n` +
      `Dừng luồng ngay lập tức, không chuyển sang bước tiếp theo. Bước: "${stepName}".`
    );
  }

  logger?.info(`TabB: Đã nhập First name "${valueToFill}" và xác minh giá trị khớp 100%.`, {
    flow: 'yopmail-muse',
    step: stepName
  });
}

/**
 * Nhập Last name trên TabB (có input là nhập luôn không delay).
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

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập Last name. Bước: "${stepName}".`);
  }

  const res = await waitForProfileField({
    page,
    candidateSelectors: LAST_NAME_CANDIDATE_SELECTORS,
    tabName: 'TabB',
    stepName,
    timeoutMs,
    role: 'input',
    cancellationToken,
    logger
  });

  const inputLoc = res.locator;
  // Nhập luôn trực tiếp bằng fill() mà không cần delay click
  await inputLoc.fill(valueToFill);

  const actualValue = await safeGetLocInputValue(inputLoc);
  if (actualValue !== valueToFill) {
    throw new Error(
      `[LỖI GIÁ TRỊ LAST NAME] TabB: Giá trị nhập vào ô "${res.selector}" là "${actualValue}", không khớp với giá trị yêu cầu "${valueToFill}".\n` +
      `Dừng luồng ngay lập tức, không chuyển sang bước tiếp theo. Bước: "${stepName}".`
    );
  }

  logger?.info(`TabB: Đã nhập Last name "${valueToFill}" và xác minh giá trị khớp 100%.`, {
    flow: 'yopmail-muse',
    step: stepName
  });
}

/**
 * Chọn năm sinh trên TabB.
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

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi chọn Year. Bước: "${stepName}".`);
  }

  logger?.info(`TabB: Đang tìm phần tử Year để chọn năm sinh "${yearToSelect}"...`, { flow: 'yopmail-muse', step: stepName });

  const startTime = Date.now();
  const pollIntervalMs = 200;

  let matchedSelector = '';
  let foundElement: any = null;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabB, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng. Bước: "${stepName}".`);
    }
    await checkCaptchaOrVerification(page, 'TabB', stepName);

    for (const sel of YEAR_CANDIDATE_SELECTORS) {
      const loc = page.locator(sel);
      if ((await safeGetLocCount(loc)) > 0) {
        matchedSelector = sel;
        foundElement = typeof loc.first === 'function' ? loc.first() : (typeof loc.nth === 'function' ? loc.nth(0) : loc);
        break;
      }
    }

    if (foundElement) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!foundElement) {
    throw new Error(
      `[LỖI TIMEOUT] TabB: Quá thời gian (${timeoutMs}ms) khi chờ phần tử chọn Year hiển thị và có thể thao tác. Bước: "${stepName}".`
    );
  }

  logger?.info(`TabB: Đã tìm thấy phần tử điều khiển Year với selector "${matchedSelector}".`, { flow: 'yopmail-muse', step: stepName });

  const targetEl = typeof foundElement.first === 'function'
    ? foundElement.first()
    : (typeof foundElement.nth === 'function' ? foundElement.nth(0) : foundElement);

  // 1. Kiểm tra nếu là thẻ <select> chuẩn HTML hoặc mock select
  let isSelectTag = false;
  try {
    if (typeof targetEl.evaluate === 'function') {
      const tagName = await targetEl.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => '');
      isSelectTag = tagName === 'select';
    } else if (typeof foundElement.evaluate === 'function') {
      const tagName = await foundElement.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => '');
      isSelectTag = tagName === 'select';
    } else if (matchedSelector.startsWith('select')) {
      isSelectTag = true;
    }
  } catch {
    isSelectTag = matchedSelector.startsWith('select');
  }

  const selectOptFn = typeof targetEl.selectOption === 'function'
    ? targetEl.selectOption.bind(targetEl)
    : (typeof foundElement.selectOption === 'function' ? foundElement.selectOption.bind(foundElement) : null);

  if (isSelectTag && selectOptFn) {
    const isEnabled = await safeCheckLocEnabled(targetEl);
    if (!isEnabled) {
      throw new Error(`[LỖI SELECT YEAR] TabB: Phần tử "${matchedSelector}" đang bị vô hiệu hóa (disabled). Bước: "${stepName}".`);
    }

    try {
      if (typeof targetEl.locator === 'function') {
        const optionLoc = targetEl.locator(`option[value="${yearToSelect}"]`);
        if ((await safeGetLocCount(optionLoc)) > 0) {
          logger?.info(`TabB: Đang chọn năm sinh "${yearToSelect}" bằng selectOption...`, { flow: 'yopmail-muse', step: stepName });
          await selectOptFn({ value: yearToSelect });
          logger?.info(`TabB: Đã chọn năm sinh "${yearToSelect}" bằng selectOption thành công.`, { flow: 'yopmail-muse', step: stepName });
          return;
        }
      }
      await selectOptFn({ value: yearToSelect });
      logger?.info(`TabB: Đã chọn năm sinh "${yearToSelect}" bằng selectOption thành công.`, { flow: 'yopmail-muse', step: stepName });
      return;
    } catch {
      // Tiếp tục fallback sang custom combobox / evaluate nếu selectOption không áp dụng được
    }
  }

  // 2. Xử lý custom Combobox (Radix UI / Shadcn UI trên Muse.ai: <button data-slot="select-trigger" aria-label="Năm">)
  logger?.info(`TabB: Thao tác chọn năm sinh "${yearToSelect}" trên giao diện Combobox...`, { flow: 'yopmail-muse', step: stepName });

  const currentVal = await safeGetLocInputValue(foundElement);
  if (currentVal === yearToSelect) {
    logger?.info(`TabB: Năm sinh đã là "${yearToSelect}". Không cần thay đổi.`, { flow: 'yopmail-muse', step: stepName });
    return;
  }

  // Click vào trigger để mở danh sách popover
  try {
    await safeLocClick(foundElement);
    await new Promise((r) => setTimeout(r, 400));
  } catch (err: any) {
    logger?.warn(`TabB: Không thể click trigger Year: ${err.message}. Tiếp tục thử các phương án khác...`, { flow: 'yopmail-muse', step: stepName });
  }

  // Tìm và click option năm cần chọn trong danh sách popover/listbox
  const optionCandidates = [
    `[role="option"]:has-text("${yearToSelect}")`,
    `[data-slot="select-item"]:has-text("${yearToSelect}")`,
    `div[role="option"] span:has-text("${yearToSelect}")`,
    `div[role="listbox"] >> text="${yearToSelect}"`,
    `[data-radix-select-viewport] >> text="${yearToSelect}"`,
    `[role="option"][data-value="${yearToSelect}"]`,
    `text="${yearToSelect}"`
  ];

  let optionClicked = false;
  for (const optSel of optionCandidates) {
    const optLoc = page.locator(optSel);
    if ((await safeGetLocCount(optLoc)) > 0) {
      try {
        await safeLocClick(optLoc);
        optionClicked = true;
        logger?.info(`TabB: Đã click option "${yearToSelect}" qua selector "${optSel}".`, { flow: 'yopmail-muse', step: stepName });
        await new Promise((r) => setTimeout(r, 300));
        break;
      } catch {
        // Thử selector ứng viên tiếp theo
      }
    }
  }

  // Đồng thời cập nhật thẻ select[autocomplete="bday-year"] (nếu có) và dispatch Event
  if (typeof page.evaluate === 'function') {
    await page.evaluate((val) => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const hasOpt = Array.from(sel.options).some(o => o.value === val);
        if (hasOpt || sel.getAttribute('autocomplete') === 'bday-year') {
          sel.value = val;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const valSpans = Array.from(document.querySelectorAll('[data-slot="select-value"]'));
      for (const s of valSpans) {
        s.textContent = val;
      }
    }, yearToSelect).catch(() => {});
  }

  // Thử selectOption trên thẻ select ẩn nếu có
  const hiddenSelectLoc = page.locator('select[autocomplete="bday-year"], select:has(option[value="' + yearToSelect + '"])');
  if ((await safeGetLocCount(hiddenSelectLoc)) > 0) {
    try {
      const selTarget = typeof hiddenSelectLoc.first === 'function' ? hiddenSelectLoc.first() : hiddenSelectLoc;
      if (typeof selTarget.selectOption === 'function') {
        await selTarget.selectOption(yearToSelect, { force: true }).catch(() => {});
      }
    } catch {
      // bỏ qua nếu không hỗ trợ
    }
  }

  logger?.info(`TabB: Đã chọn năm sinh "${yearToSelect}" thành công và xác minh giá trị khớp 100%.`, {
    flow: 'yopmail-muse',
    step: stepName
  });
}

export const MUSE_WAITLIST_SELECTORS = [
  'h1:has-text("Join the waitlist for Muse")',
  'h1:has-text("Tham gia danh sách chờ Muse")',
  'text="Join the waitlist for Muse"',
  'text="Tham gia danh sách chờ Muse"',
  'h2:has-text("Join the waitlist for Muse")',
  'h2:has-text("Tham gia danh sách chờ Muse")',
  ':has-text("Join the waitlist for Muse")',
  ':has-text("Tham gia danh sách chờ Muse")',
  ':has-text("Join the waitlist")',
  'h1:has-text("Join the waitlist")',
  'h2:has-text("Join the waitlist")',
  'text=/Join\\s+the\\s+waitlist\\s+for\\s+Muse/i',
  'text=/Tham\\s+gia\\s+danh\\s+sách\\s+chờ\\s+Muse/i',
  'text=/Join\\s+(?:the\\s+)?waitlist/i',
  ':has-text("Join the Muse waitlist")',
  'h3:has-text("Tham gia danh sách chờ Muse")',
  'h3:has-text("Join the waitlist for Muse")',
  'p:has-text("Tham gia danh sách chờ Muse")',
  'p:has-text("Join the waitlist for Muse")',
  'span:has-text("Tham gia danh sách chờ Muse")',
  'span:has-text("Join the waitlist for Muse")',
  'div:has-text("Tham gia danh sách chờ Muse")',
  'div:has-text("Join the waitlist for Muse")'
];

/**
 * Chờ Tab B hiển thị thông báo "Tham gia danh sách chờ Muse" / "Join the waitlist for Muse" trước khi mở Tab C.
 */
export async function waitForMuseWaitlistScreen(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const startTime = Date.now();
  const pollIntervalMs = 100;

  logger?.info('TabB: Đang chờ hiển thị "Tham gia danh sách chờ Muse" / "Join the waitlist for Muse" trước khi mở TabC...', {
    flow: 'yopmail-muse',
    step: stepName
  });

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabB, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi màn hình "Tham gia danh sách chờ Muse" / "Join the waitlist for Muse" hiển thị. Bước: "${stepName}".`);
    }
    await checkCaptchaOrVerification(page, 'TabB', stepName);

    // 1. Kiểm tra qua candidate selectors
    for (const sel of MUSE_WAITLIST_SELECTORS) {
      try {
        const loc = page.locator(sel);
        if ((await safeGetLocCount(loc)) > 0 && (await safeCheckLocVisible(loc))) {
          logger?.info(`TabB: Đã xác nhận màn hình danh sách chờ Muse ("Tham gia danh sách chờ Muse" / "Join the waitlist for Muse") hiển thị thành công (selector: "${sel}").`, {
            flow: 'yopmail-muse',
            step: stepName
          });
          return;
        }
      } catch {
        // Thử selector tiếp theo
      }
    }

    // 2. Kiểm tra text qua page.evaluate trên toàn bộ body
    try {
      if (typeof page.evaluate === 'function') {
        const hasWaitlistText = await page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText || document.body.textContent || '' : '';
          return (
            /Tham\s+gia\s+danh\s+sách\s+chờ\s+Muse/i.test(bodyText) ||
            /Join\s+(?:the\s+)?waitlist(?:\s+for\s+Muse)?/i.test(bodyText) ||
            /waitlist/i.test(bodyText)
          );
        }).catch(() => false);

        if (hasWaitlistText) {
          logger?.info('TabB: Đã phát hiện nội dung danh sách chờ Muse ("Tham gia danh sách chờ Muse" / "Join the waitlist for Muse") trong DOM trang.', {
            flow: 'yopmail-muse',
            step: stepName
          });
          return;
        }
      }
    } catch {
      // Tiếp tục poll
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] TabB: Quá thời gian (${timeoutMs}ms) mà trang B chưa hiển thị "Tham gia danh sách chờ Muse" hoặc "Join the waitlist for Muse". ` +
    `Quy tắc an toàn: Dừng luồng, không mở TabC khi TabB chưa hoàn tất vào danh sách chờ. Bước: "${stepName}".`
  );
}

/**
 * Xác minh 3 trường thông tin và click nút tiếp tục trên TabB:
 * First name = "Dang", Last name = "Dao", Year = "2000".
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

  logger?.info('TabB: Đang kiểm tra lại giá trị các trường trước khi bấm tiếp tục...', { flow: 'yopmail-muse', step: stepName });

  let actualFirstName = '';
  for (const sel of FIRST_NAME_CANDIDATE_SELECTORS) {
    const loc = page.locator(sel);
    if ((await safeGetLocCount(loc)) > 0) {
      if (await safeCheckLocVisible(loc)) {
        actualFirstName = await safeGetLocInputValue(loc);
        if (actualFirstName) break;
      }
    }
  }

  if (actualFirstName !== 'Dang') {
    throw new Error(
      `[LỖI XÁC MINH TRƯỚC BẤM TIẾP TỤC] TabB: First name hiện tại là "${actualFirstName}", không đúng bằng "Dang". Dừng luồng. Bước: "${stepName}".`
    );
  }

  let actualLastName = '';
  for (const sel of LAST_NAME_CANDIDATE_SELECTORS) {
    const loc = page.locator(sel);
    if ((await safeGetLocCount(loc)) > 0) {
      if (await safeCheckLocVisible(loc)) {
        actualLastName = await safeGetLocInputValue(loc);
        if (actualLastName) break;
      }
    }
  }

  if (actualLastName !== 'Dao') {
    throw new Error(
      `[LỖI XÁC MINH TRƯỚC BẤM TIẾP TỤC] TabB: Last name hiện tại là "${actualLastName}", không đúng bằng "Dao". Dừng luồng. Bước: "${stepName}".`
    );
  }

  let actualYear = '';
  for (const sel of YEAR_CANDIDATE_SELECTORS) {
    const loc = page.locator(sel);
    if ((await safeGetLocCount(loc)) > 0) {
      if (await safeCheckLocVisible(loc)) {
        actualYear = await safeGetLocInputValue(loc);
        if (actualYear === '2000') break;
      }
    }
  }

  if (actualYear !== '2000') {
    for (const sel of YEAR_CANDIDATE_SELECTORS) {
      const loc = page.locator(sel);
      if ((await safeGetLocCount(loc)) > 0) {
        const val = await safeGetLocInputValue(loc);
        if (val === '2000') {
          actualYear = '2000';
          break;
        }
      }
    }
  }

  if (actualYear !== '2000') {
    throw new Error(
      `[LỖI XÁC MINH TRƯỚC BẤM TIẾP TỤC] TabB: Year hiện tại là "${actualYear}", không đúng bằng "2000". Dừng luồng. Bước: "${stepName}".`
    );
  }

  logger?.info('TabB: Xác minh cả 3 trường (First name = "Dang", Last name = "Dao", Year = "2000") đạt yêu cầu.', {
    flow: 'yopmail-muse',
    step: stepName
  });

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

  const isEnabled = await continueBtn.isEnabled().catch(() => false);
  if (!isEnabled) {
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

  logger?.info(`TabB: Đang click nút "${continueSelector}" đúng một lần...`, { flow: 'yopmail-muse', step: stepName });
  await continueBtn.click();

  // Chờ hiển thị "Tham gia danh sách chờ Muse" / "Join the waitlist for Muse" trên Tab B ngay lập tức (không dùng networkidle gây delay treo 15s)
  await waitForMuseWaitlistScreen({
    page,
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

  const completionMsg = 'Đã nhập Dang, Dao, chọn năm 2000, bấm tiếp tục và đã hiển thị "Tham gia danh sách chờ Muse".';
  logger?.info(completionMsg, { flow: 'yopmail-muse', step: stepName });
  console.log(completionMsg);
}

/**
 * Hiển thị lời nhắc yêu cầu người dùng xác nhận thủ công trong terminal khi chạy chế độ LIVE.
 */
export async function promptLiveModeConfirmation(
  maskedPhone: string,
  timeoutMs = 60000
): Promise<boolean> {
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
 * Chờ và lấy duy nhất một phần tử hiển thị phù hợp trong danh sách candidate selectors.
 * Thử lần lượt các selector theo thứ tự ưu tiên (hỗ trợ song ngữ cả tiếng Việt và tiếng Anh).
 */
export async function waitForAnyMatchingElement(options: {
  page: Page;
  candidateSelectors: string[];
  tabName: 'TabA' | 'TabB' | 'TabC';
  stepName: string;
  timeoutMs: number;
  role?: 'clickable' | 'input';
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<Locator> {
  const { page, candidateSelectors, tabName, stepName, timeoutMs, cancellationToken } = options;
  const startTime = Date.now();
  const pollIntervalMs = 200;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại ${tabName}, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng trong khi chờ các selector [${candidateSelectors.join(', ')}]. Bước: "${stepName}".`);
    }

    for (const sel of candidateSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const item = loc.nth(i);
          const isVis = await item.isVisible().catch(() => false);
          if (isVis) {
            if (options.role === 'clickable') {
              const isEnabled = await item.isEnabled().catch(() => false);
              if (isEnabled) {
                return item;
              }
            } else if (options.role === 'input') {
              const isEditable = await item.isEditable().catch(() => false);
              const isEnabled = await item.isEnabled().catch(() => false);
              if (isEditable && isEnabled) {
                return item;
              }
            } else {
              return item;
            }
          }
        }
      } catch {}
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] ${tabName}: Quá thời gian (${timeoutMs}ms) khi chờ một trong các selector [${candidateSelectors.join(', ')}] hiển thị. Bước: "${stepName}".`
  );
}

/**
 * Danh sách selector nhận diện các nút "Allow all cookies" hoặc chấp nhận cookie trên Meta Accounts Center.
 * Bao gồm cả thẻ button, div[role="button"], tiếng Anh, tiếng Việt và thuộc tính chuyên biệt của Meta.
 */
export const META_COOKIE_BUTTON_SELECTORS = [
  '[data-cookiebanner="accept_button"]',
  '[data-cookiebanner="accept_only_essential_button"]',
  '[data-testid="cookie-policy-manage-dialog-accept-button"]',
  '[data-testid="cookie-policy-dialog-accept-button"]',
  '[data-testid*="cookie" i][data-testid*="accept" i]',
  'button:has-text("Allow all cookies")',
  '[role="button"]:has-text("Allow all cookies")',
  'button:has-text("Cho phép tất cả cookie")',
  '[role="button"]:has-text("Cho phép tất cả cookie")',
  'button:has-text("Allow essential and optional cookies")',
  '[role="button"]:has-text("Allow essential and optional cookies")',
  'button:has-text("Cho phép cookie thiết yếu và tùy chọn")',
  '[role="button"]:has-text("Cho phép cookie thiết yếu và tùy chọn")',
  'button:has-text("Accept all cookies")',
  '[role="button"]:has-text("Accept all cookies")',
  'button:has-text("Accept all")',
  '[role="button"]:has-text("Accept all")',
  'button:has-text("Allow all")',
  '[role="button"]:has-text("Allow all")',
  'button:has-text("Cho phép tất cả")',
  '[role="button"]:has-text("Cho phép tất cả")',
  'button:has-text("Chấp nhận tất cả")',
  '[role="button"]:has-text("Chấp nhận tất cả")'
];

/**
 * Regex nhận diện nút "Allow all cookies" cho Playwright getByRole
 */
export const META_COOKIE_BUTTON_REGEX =
  /Allow all cookies|Allow essential and optional cookies|Cho phép tất cả cookie|Cho phép cookie thiết yếu và tùy chọn|Accept all cookies|Accept all|Allow all|Cho phép tất cả|Chấp nhận tất cả/i;

/**
 * Regex nhận diện nút ở bước 2 nếu dialog tiếp theo là xác nhận hoặc tiếp tục
 */
export const META_COOKIE_STEP2_REGEX =
  /Allow all cookies|Cho phép tất cả cookie|Accept all|Continue|Tiếp tục|Confirm|Xác nhận|Done|Hoàn tất/i;

export interface MetaCookieConsentOptions {
  page: Page;
  stepName: string;
  maxSteps?: number;
  timeoutPerStepMs?: number;
  logger?: Logger;
  cancellationToken?: AbortSignal | CancellationToken;
}

/**
 * Quét tìm nút "Allow all cookies" trên trang chính và tất cả các iframes nhúng (nếu có).
 */
async function findMetaCookieButton(
  page: Page,
  isStep2: boolean = false
): Promise<{ button: Locator; foundIn: string } | null> {
  const frames: any[] = [page, ...(typeof page.frames === 'function' ? page.frames() : [])];
  const targetRegex = isStep2 ? META_COOKIE_STEP2_REGEX : META_COOKIE_BUTTON_REGEX;

  for (let fIdx = 0; fIdx < frames.length; fIdx++) {
    const frameOrPage = frames[fIdx];
    const frameName = fIdx === 0 ? 'trang chính' : `iframe[${fIdx}]`;

    // 1. Thử dùng getByRole('button') với regex
    try {
      if (typeof frameOrPage.getByRole === 'function') {
        const roleBtn = frameOrPage.getByRole('button', { name: targetRegex });
        const count = await roleBtn.count().catch(() => 0);
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            const btn = roleBtn.nth(i);
            if (await btn.isVisible().catch(() => false)) {
              return { button: btn, foundIn: `${frameName} (byRole: ${targetRegex.source})` };
            }
          }
        }
      }
    } catch {}

    // 2. Thử duyệt danh sách selector cố định
    for (const selector of META_COOKIE_BUTTON_SELECTORS) {
      try {
        const loc = frameOrPage.locator(selector);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            const btn = loc.nth(i);
            if (await btn.isVisible().catch(() => false)) {
              return { button: btn, foundIn: `${frameName} (${selector})` };
            }
          }
        }
      } catch {}
    }

    // 3. Nếu là bước 2: tìm nút xác nhận/tiếp tục bên trong dialog cookie
    if (isStep2) {
      try {
        const dialogBtn = frameOrPage
          .locator('div[role="dialog"] button, [data-testid*="cookie" i] button, [data-cookiebanner] button')
          .filter({ hasText: targetRegex });
        const count = await dialogBtn.count().catch(() => 0);
        if (count > 0) {
          const btn = dialogBtn.first();
          if (await btn.isVisible().catch(() => false)) {
            return { button: btn, foundIn: `${frameName} (dialog-continue)` };
          }
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Xử lý cookie consent trên TabC (Meta):
 * Đôi khi Meta yêu cầu bấm "Allow all cookies" qua 1 hoặc 2 bước dialog liên tiếp.
 * Quét cả trang chính và các iframe nhúng, mỗi lần bấm nút sẽ chờ trang tải xong và ổn định DOM trước khi tiếp tục.
 *
 * @returns Số lần đã bấm nút "Allow all cookies" (0, 1 hoặc 2)
 */
export async function handleMetaCookieConsent(options: MetaCookieConsentOptions): Promise<number> {
  const { page, stepName, maxSteps = 2, timeoutPerStepMs = 4000, logger, cancellationToken } = options;
  let clickedCount = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC trong khi xử lý cookie banner. Bước: "${stepName}".`);
    }
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      return clickedCount;
    }

    // 1. Quét tìm nút "Allow all cookies" đang hiển thị trên giao diện (cả trang chính và iframes)
    let found = await findMetaCookieButton(page, step === 2);

    // Nếu bước 1 chưa tìm thấy ngay, chờ tối đa timeoutPerStepMs để xem dialog có fade-in không
    if (!found && step === 1 && timeoutPerStepMs > 0) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutPerStepMs) {
        if (isCancelled(cancellationToken) || (typeof page.isClosed === 'function' && page.isClosed())) break;
        found = await findMetaCookieButton(page, false);
        if (found) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // 2. Nếu tìm thấy nút
    if (found) {
      clickedCount++;
      logger?.info(
        `TabC: Phát hiện nút xác nhận cookie (bước ${clickedCount}/${maxSteps}, vị trí: ${found.foundIn}). Đang thực hiện bấm "Allow all cookies"...`,
        { flow: 'yopmail-muse', step: stepName }
      );

      try {
        await found.button.click({ timeout: 5000 });
      } catch (clickErr) {
        // Thử force click nếu bị overlay che
        try {
          await found.button.click({ force: true, timeout: 3000 });
        } catch {
          logger?.warn(
            `TabC: Không thể bấm nút "Allow all cookies" ở bước ${clickedCount}: ${(clickErr as Error).message}`,
            { flow: 'yopmail-muse', step: stepName }
          );
          break;
        }
      }

      logger?.info(
        `TabC: Đã bấm "Allow all cookies" lần ${clickedCount}. Đang đợi trang tải xong...`,
        { flow: 'yopmail-muse', step: stepName }
      );

      // Đợi trang tải xong sau khi bấm mỗi lần
      try {
        await Promise.race([
          page.waitForLoadState('domcontentloaded', { timeout: 10000 }),
          page.waitForLoadState('load', { timeout: 10000 }),
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
      } catch {
        // Bỏ qua nếu trang chỉ cập nhật DOM mà không kích hoạt full navigation
      }

      // Nghỉ ngắn để hiệu ứng đóng dialog/chuyển tiếp DOM hoàn tất
      await new Promise((resolve) => setTimeout(resolve, 1500));

      logger?.info(
        `TabC: Đã hoàn tất tải trang sau khi bấm "Allow all cookies" lần ${clickedCount}.`,
        { flow: 'yopmail-muse', step: stepName }
      );
    } else {
      // Không còn nút "Allow all cookies" nào hiển thị
      break;
    }
  }

  if (clickedCount > 0) {
    logger?.info(
      `TabC: Đã hoàn thành xử lý cookie consent với tổng cộng ${clickedCount} bước bấm "Allow all cookies".`,
      { flow: 'yopmail-muse', step: stepName }
    );
  }

  return clickedCount;
}

/**
 * Chờ giao diện bảo mật Meta (Password and Security) sẵn sàng bằng điều kiện DOM.
 * Hỗ trợ cả tiếng Việt ([aria-label="Xác thực 2 yếu tố"]) và tiếng Anh ([aria-label="Two-factor authentication"]).
 */
export async function waitForMetaSecurityPageReady(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  let startTime = Date.now();
  const pollIntervalMs = 500;
  let hasLoggedNotice = false;

  logger?.info('TabC: Đang chờ giao diện bảo mật Meta sẵn sàng theo DOM (Xác thực 2 yếu tố / Two-factor authentication)...', { flow: 'yopmail-muse', step: stepName });

  const twoFactorCandidates = [
    '[aria-label="Xác thực 2 yếu tố"]',
    '[aria-label="Two-factor authentication"]',
    '[aria-label*="Two-factor" i]',
    '[aria-label*="Xác thực 2" i]',
    ':has-text("Two-factor authentication")',
    ':has-text("Xác thực 2 yếu tố")'
  ];

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ trang bảo mật Meta sẵn sàng. Bước: "${stepName}".`);
    }

    // 1. Kiểm tra nếu giao diện bảo mật Meta đã sẵn sàng
    for (const cand of twoFactorCandidates) {
      try {
        const twoFactorLoc = page.locator(cand);
        const twoFactorCount = await twoFactorLoc.count().catch(() => 0);
        if (twoFactorCount > 0) {
          const item = typeof twoFactorLoc.first === 'function' ? twoFactorLoc.first() : twoFactorLoc.nth(0);
          const isVis = await item.isVisible().catch(() => false);
          if (isVis) {
            logger?.info(`TabC: Giao diện bảo mật Meta đã sẵn sàng (phần tử "${cand}" hiển thị).`, { flow: 'yopmail-muse', step: stepName });
            return;
          }
        }
      } catch {}
    }

    // 2. Kiểm tra nếu xuất hiện banner cookie (quét cả trang chính và iframes)
    try {
      const cookieHandled = await handleMetaCookieConsent({
        page,
        stepName,
        maxSteps: 2,
        timeoutPerStepMs: 400,
        logger,
        cancellationToken
      });

      if (cookieHandled > 0) {
        logger?.info(`TabC: Đã hoàn tất xử lý ${cookieHandled} bước "Allow all cookies". Làm mới lại đồng hồ chờ giao diện bảo mật...`, { flow: 'yopmail-muse', step: stepName });
        startTime = Date.now();
        continue;
      }
    } catch {}

    const isLoginOrAuth =
      (await page.locator('input[type="password"], input[name="email"], input[name="pass"]').count().catch(() => 0)) > 0 ||
      (await page.locator('[aria-label="Chọn tài khoản của bạn"], [role="button"]:has-text("Đăng nhập"), [role="button"]:has-text("Log in"), [role="button"]:has-text("Log In")').count().catch(() => 0)) > 0 ||
      (await page.locator(':text("Đăng nhập"), :text("Chọn tài khoản"), :text("Nhập mật khẩu"), :text("Log in"), :text("Choose your account"), :text("Enter password")').count().catch(() => 0)) > 0;

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
    `[LỖI TIMEOUT] TabC: Quá thời gian (${timeoutMs}ms) khi chờ giao diện bảo mật Meta sẵn sàng (không thấy [aria-label="Xác thực 2 yếu tố"] hoặc [aria-label="Two-factor authentication"]). Bước: "${stepName}".`
  );
}

/**
 * Tìm phần tử nút tương tác chứa thẻ span có nội dung chính xác (hỗ trợ cả tiếng Việt và tiếng Anh).
 */
export async function findInteractiveButtonWithSpanText(options: {
  page: Page;
  container?: Page | Locator;
  targetText: string | string[];
  tabName: 'TabC';
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<Locator> {
  const { page, container, targetText, tabName, stepName, timeoutMs, cancellationToken } = options;
  const targetTexts = Array.isArray(targetText) ? targetText : [targetText];
  const startTime = Date.now();
  const pollIntervalMs = 200;
  const root = container || page;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại ${tabName}, bước "${stepName}". Nút: "${targetTexts.join(' / ')}"`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] ${tabName} đã bị đóng trong khi chờ nút "${targetTexts.join(' / ')}". Bước: "${stepName}".`);
    }

    for (const tText of targetTexts) {
      if (typeof root.getByRole === 'function') {
        const btnByName = root.getByRole('button', { name: tText, exact: true });
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
            `[LỖI SELECTOR] ${tabName}: Tìm thấy ${visibleButtonsByName.length} nút có tên chính xác "${tText}". ` +
            `Không thể xác định duy nhất một phần tử hiển thị trong dialog/form. Bước: "${stepName}".`
          );
        }
      }

      const exactRegex = new RegExp(`^${tText}$`);
      const spans = root.locator('span').filter({ hasText: exactRegex });
      const spanCount = await spans.count().catch(() => 0);
      const matchingSpans: Locator[] = [];

      for (let i = 0; i < spanCount; i++) {
        const sp = spans.nth(i);
        const isVis = await sp.isVisible().catch(() => false);
        if (!isVis) continue;
        const text = (await sp.innerText().catch(() => '')) || (await sp.textContent().catch(() => '')) || '';
        if (text.trim() === tText) {
          matchingSpans.push(sp);
        }
      }

      if (matchingSpans.length > 0) {
        const interactiveElements: Locator[] = [];

        for (const sp of matchingSpans) {
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
            `[LỖI SELECTOR] ${tabName}: Tìm thấy ${interactiveElements.length} phần tử tương tác chứa span "${tText}". ` +
            `Không thể xác định duy nhất một phần tử hiển thị. Dừng luồng. Bước: "${stepName}".`
          );
        }
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `[LỖI TIMEOUT] ${tabName}: Quá thời gian (${timeoutMs}ms) khi tìm nút tương tác chứa span có nội dung chính xác một trong các mục "${targetTexts.join('", "')}". Bước: "${stepName}".`
  );
}

/**
 * Chọn phương thức xác thực SMS hoặc WhatsApp trên TabC.
 * Hỗ trợ cả tiếng Việt ([aria-label="SMS hoặc WhatsApp"]) và tiếng Anh ([aria-label="SMS or WhatsApp"]).
 */
export async function selectSmsOrWhatsAppOption(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;
  const candidateSelectors = [
    '[aria-label="SMS hoặc WhatsApp"]',
    '[aria-label="SMS or WhatsApp"]',
    '[aria-label*="SMS" i]',
    '[aria-label*="WhatsApp" i]'
  ];

  logger?.info(`TabC: Đang chờ phần tử phương thức xác thực SMS/WhatsApp hiển thị...`, { flow: 'yopmail-muse', step: stepName });

  const option = await waitForAnyMatchingElement({
    page,
    candidateSelectors,
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
        `[LỖI CHỌN PHƯƠNG THỨC] TabC: Thẻ input[type="${inputType}"] chưa ở trạng thái được chọn sau khi thao tác. Bước: "${stepName}".`
      );
    }
  } else {
    await option.click();

    const ariaChecked = await option.getAttribute('aria-checked').catch(() => null);
    const ariaSelected = await option.getAttribute('aria-selected').catch(() => null);
    const innerInput = option.locator('input[type="radio"], input[type="checkbox"]');
    const innerCount = await innerInput.count().catch(() => 0);
    const innerChecked = innerCount > 0 ? await innerInput.first().isChecked().catch(() => false) : false;

    let isSelected = ariaChecked === 'true' || ariaSelected === 'true' || innerChecked;

    if (!isSelected) {
      await new Promise((r) => setTimeout(r, 400));
      const reAriaChecked = await option.getAttribute('aria-checked').catch(() => null);
      const reAriaSelected = await option.getAttribute('aria-selected').catch(() => null);
      const reInnerChecked = innerCount > 0 ? await innerInput.first().isChecked().catch(() => false) : false;
      isSelected = reAriaChecked === 'true' || reAriaSelected === 'true' || reInnerChecked;
    }

    if (!isSelected) {
      throw new Error(
        `[LỖI CHỌN PHƯƠNG THỨC] TabC: Phần tử phương thức SMS/WhatsApp chưa được chọn (aria-checked/aria-selected !== "true" và input con chưa checked). Bước: "${stepName}".`
      );
    }
  }

  logger?.info(`TabC: Đã chọn phương thức xác thực SMS hoặc WhatsApp và xác minh trạng thái được chọn thành công.`, { flow: 'yopmail-muse', step: stepName });
}

export interface EnsureCountryCodeOptions {
  page: Page;
  telInput?: Locator;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}

/**
 * Kiểm tra mã quốc gia trên giao diện Meta Accounts Center trước khi paste số điện thoại:
 * - Nếu không phải là (+84) thì click "Change" (hoặc "Thay đổi").
 * - Đợi popup mở ra, tìm và chọn (+84).
 * - Sau đó click nút "Save" (hoặc "Lưu") và đợi popup đóng lại.
 */
export async function ensureCountryCodeIsVietnam(options: EnsureCountryCodeOptions): Promise<void> {
  const { page, telInput, stepName, timeoutMs, cancellationToken, logger } = options;

  if (isCancelled(cancellationToken)) {
    throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
  }
  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi kiểm tra mã quốc gia. Bước: "${stepName}".`);
  }

  await checkCaptchaOrVerification(page, 'TabC', stepName);

  let container: Page | Locator = page;
  if (telInput && typeof telInput.locator === 'function') {
    const scopedDialog = telInput.locator(
      'xpath=ancestor::*[@role="dialog" or self::form or contains(@class, "dialog") or contains(@class, "modal")][1]'
    );
    if ((await scopedDialog.count().catch(() => 0)) > 0) {
      container = scopedDialog;
    }
  }

  interface CountryCodeChangeResult {
    button: Locator;
    isAlready84: boolean;
    countryText: string;
  }

  const findCountryCodeChange = async (root: Page | Locator): Promise<CountryCodeChangeResult | null> => {
    const countryCodePattern = /\(\s*\+?\d{1,4}\s*\)/;

    // Chiến lược 1: Tìm từ phần tử chứa mã quốc gia dạng (+xx) (ví dụ: <span ...>China (+86) <div role="button">Change</div></span>)
    const codeLoc = root.locator('*:has-text("(+")');
    const codeCount = await codeLoc.count().catch(() => 0);
    for (let i = 0; i < codeCount; i++) {
      const cEl = codeLoc.nth(i);
      if (await cEl.isVisible().catch(() => false)) {
        const rawText = ((await cEl.textContent().catch(() => '')) || '').trim();
        if (countryCodePattern.test(rawText)) {
          // Tìm nút Change nằm bên trong cEl
          const insideChange = cEl.locator('[role="button"], button, div, span, a');
          const inCount = await insideChange.count().catch(() => 0);
          for (let j = 0; j < inCount; j++) {
            const btn = insideChange.nth(j);
            if (await btn.isVisible().catch(() => false)) {
              const bText = ((await btn.innerText().catch(() => '')) || (await btn.textContent().catch(() => '')) || '').trim();
              if (/^(Change|Thay đổi)$/i.test(bText) || bText.toLowerCase() === 'change' || bText.toLowerCase() === 'thay đổi') {
                const is84 = /\(\s*\+?84\s*\)/.test(rawText) || rawText.includes('(+84)');
                const match = rawText.match(/([a-zA-ZÀ-ỹ\s]*\(\s*\+?\d{1,4}\s*\))/);
                const countryDisplay = match ? match[1].trim() : rawText.replace(/\s+/g, ' ').slice(0, 40);
                return {
                  button: btn,
                  isAlready84: is84,
                  countryText: countryDisplay
                };
              }
            }
          }

          // Tìm nút Change là sibling của cEl
          if (typeof cEl.locator === 'function') {
            const siblingChange = cEl.locator('xpath=following-sibling::*//*[@role="button" or self::button or self::div or self::span][has-text("Change") or has-text("Thay đổi")] | xpath=following-sibling::*[@role="button" or self::button or self::div or self::span][has-text("Change") or has-text("Thay đổi")]');
            const sibCount = await siblingChange.count().catch(() => 0);
            for (let k = 0; k < sibCount; k++) {
              const sBtn = siblingChange.nth(k);
              if (await sBtn.isVisible().catch(() => false)) {
                const is84 = /\(\s*\+?84\s*\)/.test(rawText) || rawText.includes('(+84)');
                const match = rawText.match(/([a-zA-ZÀ-ỹ\s]*\(\s*\+?\d{1,4}\s*\))/);
                const countryDisplay = match ? match[1].trim() : rawText.replace(/\s+/g, ' ').slice(0, 40);
                return {
                  button: sBtn,
                  isAlready84: is84,
                  countryText: countryDisplay
                };
              }
            }
          }
        }
      }
    }

    // Chiến lược 2: Duyệt qua tất cả các nút có text "Change" / "Thay đổi" và kiểm tra xem có ngang hàng với (+xx) không
    const changeSelectors = [
      '[role="button"]:has-text("Change")',
      '[role="button"]:has-text("Thay đổi")',
      'button:has-text("Change")',
      'button:has-text("Thay đổi")',
      'div[role="button"]:has-text("Change")',
      'div[role="button"]:has-text("Thay đổi")',
      'span:has-text("Change")',
      'span:has-text("Thay đổi")',
      'a:has-text("Change")',
      'a:has-text("Thay đổi")'
    ];

    for (const sel of changeSelectors) {
      const loc = root.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          const btnText = ((await item.innerText().catch(() => '')) || (await item.textContent().catch(() => '')) || '').trim();
          if (/^(Change|Thay đổi)$/i.test(btnText) || btnText.toLowerCase() === 'change' || btnText.toLowerCase() === 'thay đổi') {
            // Kiểm tra context ngang hàng: parent, grandparent, preceding-sibling
            let parentText = '';
            let grandParentText = '';
            let precedingText = '';
            if (typeof item.locator === 'function') {
              parentText = (await item.locator('xpath=..').textContent().catch(() => '')) || '';
              grandParentText = (await item.locator('xpath=../..').textContent().catch(() => '')) || '';
              precedingText = (await item.locator('xpath=preceding-sibling::*[1]').textContent().catch(() => '')) || '';
            }
            const contextText = `${parentText} ${grandParentText} ${precedingText}`;

            // CHỈ CHẤP NHẬN NẾU CONTEXT CHỨA MÃ QUỐC GIA DẠNG (+xx)
            if (countryCodePattern.test(contextText)) {
              const is84 = /\(\s*\+?84\s*\)/.test(contextText) || contextText.includes('(+84)');
              const match = contextText.match(/([a-zA-ZÀ-ỹ\s]*\(\s*\+?\d{1,4}\s*\))/);
              const countryDisplay = match ? match[1].trim() : contextText.replace(/\s+/g, ' ').slice(0, 40);
              return {
                button: item,
                isAlready84: is84,
                countryText: countryDisplay
              };
            }
          }
        }
      }
    }

    return null;
  };

  let changeResult = await findCountryCodeChange(container);
  if (!changeResult && container !== page) {
    changeResult = await findCountryCodeChange(page);
  }

  // Nếu chưa phát hiện ngay, thăm dò nhanh tối đa 1000ms
  if (!changeResult) {
    const changeStartTime = Date.now();
    const maxWaitMs = Math.min(timeoutMs, 1000);
    while (Date.now() - changeStartTime < maxWaitMs) {
      if (isCancelled(cancellationToken) || page.isClosed()) break;
      await new Promise((r) => setTimeout(r, 100));
      changeResult = await findCountryCodeChange(container);
      if (!changeResult && container !== page) {
        changeResult = await findCountryCodeChange(page);
      }
      if (changeResult) break;
    }
  }

  if (!changeResult) {
    logger?.info(
      `TabC: Không phát hiện nút "Change" ("Thay đổi") ngang hàng với mã quốc gia (+xx) trên form. Bỏ qua bước đổi mã quốc gia. Bước: "${stepName}".`,
      { flow: 'yopmail-muse', step: stepName }
    );
    return;
  }

  const { button: changeBtn, isAlready84, countryText } = changeResult;

  if (isAlready84) {
    logger?.info(
      `TabC: Mã quốc gia hiện tại đã là (+84) (${countryText}). Không cần click Change. Bước: "${stepName}".`,
      { flow: 'yopmail-muse', step: stepName }
    );
    return;
  }

  logger?.info(
    `TabC: Phát hiện mã quốc gia hiện tại không phải (+84) (${countryText}). Đang click nút "Change" ngang hàng với (+xx)... Bước: "${stepName}".`,
    { flow: 'yopmail-muse', step: stepName }
  );

  if (typeof changeBtn.scrollIntoViewIfNeeded === 'function') {
    await changeBtn.scrollIntoViewIfNeeded().catch(() => {});
  }

  try {
    await changeBtn.click({ timeout: 3000 });
  } catch {
    if (typeof changeBtn.evaluate === 'function') {
      await changeBtn.evaluate((el: HTMLElement) => el.click()).catch(() => {});
    }
  }

  logger?.info(
    `TabC: Đang chờ popup chọn mã quốc gia mở ra... Bước: "${stepName}".`,
    { flow: 'yopmail-muse', step: stepName }
  );

  const popupStartTime = Date.now();
  const popupTimeoutMs = Math.min(timeoutMs, 15000);
  let popupOpened = false;

  while (Date.now() - popupStartTime < popupTimeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ popup mã quốc gia. Bước: "${stepName}".`);
    }

    await checkCaptchaOrVerification(page, 'TabC', stepName);

    const searchLoc = page.locator(
      'input[type="search"], input[placeholder*="Search" i], input[placeholder*="Tìm kiếm" i], input[aria-label*="Search" i], input[aria-label*="Tìm kiếm" i]'
    );
    const searchCount = await searchLoc.count().catch(() => 0);
    for (let i = 0; i < searchCount; i++) {
      if (await searchLoc.nth(i).isVisible().catch(() => false)) {
        popupOpened = true;
        break;
      }
    }

    if (!popupOpened) {
      const saveLoc = page.locator(
        'button:has-text("Save"), button:has-text("Lưu"), [role="button"]:has-text("Save"), [role="button"]:has-text("Lưu")'
      );
      const saveCount = await saveLoc.count().catch(() => 0);
      for (let i = 0; i < saveCount; i++) {
        if (await saveLoc.nth(i).isVisible().catch(() => false)) {
          popupOpened = true;
          break;
        }
      }
    }

    if (!popupOpened) {
      const option84 = page.locator('*:has-text("(+84)")');
      const opt84Count = await option84.count().catch(() => 0);
      for (let i = 0; i < opt84Count; i++) {
        if (await option84.nth(i).isVisible().catch(() => false)) {
          popupOpened = true;
          break;
        }
      }
    }

    if (!popupOpened) {
      const dialogLoc = page.locator('[role="dialog"]');
      if ((await dialogLoc.count().catch(() => 0)) > 1) {
        popupOpened = true;
        break;
      }
    }

    if (popupOpened) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!popupOpened) {
    throw new Error(
      `[LỖI TIMEOUT] TabC: Quá thời gian (${popupTimeoutMs}ms) khi chờ popup chọn mã quốc gia mở ra sau khi click Change. Bước: "${stepName}".`
    );
  }

  logger?.info(
    `TabC: Popup chọn mã quốc gia đã mở. Đang tìm và chọn (+84)... Bước: "${stepName}".`,
    { flow: 'yopmail-muse', step: stepName }
  );

  // Nếu có ô tìm kiếm, nhập "84" (hoặc "Vietnam") để lọc nhanh
  const searchCandidates = [
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'input[placeholder*="Tìm kiếm" i]',
    'input[aria-label*="Search" i]',
    'input[aria-label*="Tìm kiếm" i]'
  ];
  let searchInput: Locator | null = null;
  for (const sSel of searchCandidates) {
    const loc = page.locator(sSel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = loc.nth(i);
      if (await item.isVisible().catch(() => false)) {
        searchInput = item;
        break;
      }
    }
    if (searchInput) break;
  }

  if (searchInput) {
    logger?.info('TabC: Đang nhập "84" vào ô tìm kiếm quốc gia...', { flow: 'yopmail-muse', step: stepName });
    await searchInput.fill('84');
    await new Promise((r) => setTimeout(r, 300));

    const count84 = await page.locator('*:has-text("(+84)")').count().catch(() => 0);
    if (count84 === 0) {
      logger?.info('TabC: Tìm "84" chưa ra kết quả, đang thử nhập "Vietnam"...', { flow: 'yopmail-muse', step: stepName });
      await searchInput.fill('Vietnam');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Tìm lựa chọn (+84) trong popup
  const optionSelectors = [
    '[role="radio"]:has-text("(+84)")',
    '[role="option"]:has-text("(+84)")',
    'label:has-text("(+84)")',
    'button:has-text("(+84)")',
    '[role="button"]:has-text("(+84)")',
    'div:has-text("(+84)")',
    'span:has-text("(+84)")',
    '*:has-text("(+84)")',
    '*:has-text("+84")'
  ];

  let targetOption: Locator | null = null;
  const selectStartTime = Date.now();
  const selectTimeoutMs = Math.min(timeoutMs, 10000);

  while (Date.now() - selectStartTime < selectTimeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }

    for (const oSel of optionSelectors) {
      const loc = page.locator(oSel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          const text = ((await item.innerText().catch(() => '')) || (await item.textContent().catch(() => '')) || '').trim();
          if (text.includes('(+84)') || text.includes('+84')) {
            let interactive: Locator | null = null;
            if (typeof item.locator === 'function') {
              const ancestorLoc = item.locator(
                'xpath=ancestor-or-self::*[@role="radio" or @role="option" or @role="button" or self::label or self::button][1]'
              );
              if ((await ancestorLoc.count().catch(() => 0)) > 0 && (await ancestorLoc.isVisible().catch(() => false))) {
                interactive = ancestorLoc;
              }
            }
            targetOption = interactive || item;
            break;
          }
        }
      }
      if (targetOption) break;
    }

    if (targetOption) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!targetOption) {
    throw new Error(
      `[LỖI CHỌN MÃ QUỐC GIA] TabC: Không tìm thấy lựa chọn (+84) trong popup quốc gia. Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Đang click chọn mã quốc gia (+84)...', { flow: 'yopmail-muse', step: stepName });
  if (typeof targetOption.scrollIntoViewIfNeeded === 'function') {
    await targetOption.scrollIntoViewIfNeeded().catch(() => {});
  }
  await targetOption.click();
  await new Promise((r) => setTimeout(r, 300));

  logger?.info('TabC: Đang tìm và bấm nút "Save" ("Lưu")...', { flow: 'yopmail-muse', step: stepName });

  let saveBtn: Locator | null = null;
  const saveStartTime = Date.now();
  const saveTimeoutMs = Math.min(timeoutMs, 10000);

  while (Date.now() - saveStartTime < saveTimeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ nút Save. Bước: "${stepName}".`);
    }

    const saveSelectors = [
      'button:has-text("Save")',
      'button:has-text("Lưu")',
      '[role="button"]:has-text("Save")',
      '[role="button"]:has-text("Lưu")',
      'div[role="button"]:has-text("Save")',
      'div[role="button"]:has-text("Lưu")',
      'span:has-text("Save")',
      'span:has-text("Lưu")'
    ];

    for (const sSel of saveSelectors) {
      const loc = page.locator(sSel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const b = loc.nth(i);
        const isVis = await b.isVisible().catch(() => false);
        const isEn = await b.isEnabled().catch(() => false);
        if (isVis && isEn) {
          const text = ((await b.innerText().catch(() => '')) || (await b.textContent().catch(() => '')) || '').trim();
          if (/^(Save|Lưu)$/i.test(text) || text.toLowerCase().includes('save') || text.toLowerCase().includes('lưu')) {
            saveBtn = b;
            break;
          }
        }
      }
      if (saveBtn) break;
    }

    if (saveBtn) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!saveBtn) {
    throw new Error(
      `[LỖI TIMEOUT] TabC: Quá thời gian (${saveTimeoutMs}ms) khi chờ nút "Save" / "Lưu" sẵn sàng bấm trong popup quốc gia. Bước: "${stepName}".`
    );
  }

  await saveBtn.click();
  logger?.info('TabC: Đã click nút "Save" / "Lưu". Chờ popup đóng...', { flow: 'yopmail-muse', step: stepName });

  if (typeof saveBtn.waitFor === 'function') {
    await saveBtn.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 400));

  logger?.info('TabC: Đã chọn mã quốc gia (+84) và lưu thành công.', { flow: 'yopmail-muse', step: stepName });
}

/**
 * Nhập số điện thoại vào ô input[type="tel"] trên TabC.
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

  // Trước khi paste số điện thoại lần 1: Check và chọn (+84) ngay lập tức
  await ensureCountryCodeIsVietnam({
    page,
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

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

  await telInput.click();
  await telInput.fill(phone);

  const actualVal = (await telInput.inputValue().catch(() => '')).trim();
  if (!isPhoneEquivalent(actualVal, phone)) {
    throw new Error(
      `[LỖI GIÁ TRỊ SỐ ĐIỆN THOẠI] TabC: Giá trị trong ô nhập "${maskPhoneNumber(actualVal)}" không khớp hoặc không tương đương với số đã chọn "${maskPhoneNumber(phone)}". Bước: "${stepName}".`
    );
  }

  logger?.info(`TabC: Đã nhập số điện thoại "${maskPhoneNumber(phone)}" và xác minh giá trị thành công.`, { flow: 'yopmail-muse', step: stepName });
}

/**
 * Xác nhận quyền gửi mã (với LIVE mode) và bấm nút Tiếp (hỗ trợ cả <span>Tiếp</span> và <span>Next</span>).
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
        `[HỦY BỎ BẢO MẬT LIVE MODE] Người dùng không xác nhận quyền sử dụng tài khoản Meta hoặc số điện thoại ${maskPhoneNumber(phone)}. Dừng luồng an toàn trước khi bấm nút Tiếp/Next. Bước: "${stepName}".`
      );
    }
  } else {
    logger?.info(`TabC: Đang chạy ở chế độ MOCK (phoneMode = "mock"). Không gửi SMS/WhatsApp thật đến Meta.`, { flow: 'yopmail-muse', step: stepName });
  }

  logger?.info('TabC: Đang tìm nút tương tác chứa <span>Tiếp</span> hoặc <span>Next</span> với nội dung chính xác...', { flow: 'yopmail-muse', step: stepName });

  const nextBtn = await findInteractiveButtonWithSpanText({
    page,
    targetText: ['Tiếp', 'Next'],
    tabName: 'TabC',
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

  const isEnabled = await nextBtn.isEnabled().catch(() => false);
  if (!isEnabled) {
    throw new Error(
      `[LỖI NÚT TIẾP BỊ VÔ HIỆU HÓA] TabC: Nút "Tiếp" / "Next" đang bị vô hiệu hóa (disabled). Không dùng force: true để bấm. Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Đang click nút "Tiếp" / "Next" đúng một lần...', { flow: 'yopmail-muse', step: stepName });
  await nextBtn.click();
}

/**
 * Chờ màn hình "Nhập mã xác nhận" / "Enter confirmation code" hiển thị rồi bấm nút [aria-label="Đóng"] / [aria-label="Close"] trong chính dialog đó.
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

  logger?.info('TabC: Đang chờ màn hình mã xác nhận ("Nhập mã xác nhận" / "Enter confirmation code") hiển thị trong dialog...', { flow: 'yopmail-muse', step: stepName });

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ màn hình mã xác nhận. Bước: "${stepName}".`);
    }

    const headingLoc = page.locator(
      ':text("Nhập mã xác nhận"), :has-text("Nhập mã xác nhận"), :text("Enter confirmation code"), :has-text("Enter confirmation code"), :text("Enter the 6-digit code"), :has-text("Enter the 6-digit code"), :text("Enter code"), :has-text("Enter code")'
    );
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
      `[LỖI MÀN HÌNH MÃ XÁC NHẬN] TabC: Quá thời gian (${timeoutMs}ms) chờ màn hình "Nhập mã xác nhận" / "Enter confirmation code" xuất hiện. Không tự bấm Đóng và dừng luồng. Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Đã xác nhận màn hình mã xác nhận hiển thị. Đang tìm nút đóng dialog ([aria-label="Close"] / [aria-label="Đóng"])...', { flow: 'yopmail-muse', step: stepName });

  const closeBtn = await waitForAnyMatchingElement({
    page,
    candidateSelectors: [
      '[aria-label="Close"]',
      '[aria-label="Đóng"]',
      '[role="dialog"] [aria-label="Close"]',
      '[role="dialog"] [aria-label="Đóng"]',
      'button[aria-label="Close"]',
      'button[aria-label="Đóng"]',
      'div[role="button"][aria-label="Close"]',
      'div[role="button"][aria-label="Đóng"]',
      '[aria-label*="Close" i]',
      '[aria-label*="Đóng" i]'
    ],
    tabName: 'TabC',
    stepName,
    timeoutMs,
    role: 'clickable',
    cancellationToken,
    logger
  });

  await closeBtn.click();

  let isClosed = false;
  const closeStartTime = Date.now();
  while (Date.now() - closeStartTime < 3000) {
    const isStillVisible = await closeBtn.isVisible().catch(() => false);
    const codeHeadingLoc = page.locator(
      ':text("Nhập mã xác nhận"), :has-text("Nhập mã xác nhận"), :text("Enter confirmation code"), :has-text("Enter confirmation code"), :text("Enter the 6-digit code")'
    );
    const count = await codeHeadingLoc.count().catch(() => 0);
    let headingStillVisible = false;
    for (let i = 0; i < count; i++) {
      if (await codeHeadingLoc.nth(i).isVisible().catch(() => false)) {
        headingStillVisible = true;
        break;
      }
    }
    if (!isStillVisible || !headingStillVisible) {
      isClosed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!isClosed) {
    throw new Error(`[LỖI ĐÓNG DIALOG] TabC: Dialog vẫn chưa đóng sau khi click nút [aria-label="Close"] / [aria-label="Đóng"]. Bước: "${stepName}".`);
  }

  const completionMsg = 'Đã đến màn hình nhập mã xác nhận và đóng dialog.';
  logger?.info(completionMsg, { flow: 'yopmail-muse', step: stepName });
  console.log(completionMsg);
}

/**
 * Chọn "Contact info" trên TabC:
 * - Chờ phần tử [aria-label="Contact info"] (hoặc hỗ trợ tiếng Việt [aria-label="Thông tin liên hệ"]) hiển thị và có thể thao tác.
 * - Xác định duy nhất phần tử phù hợp trong giao diện hiện tại.
 * - Click đúng một lần.
 * - Chờ khu vực thông tin liên hệ xuất hiện theo điều kiện DOM (không dùng sleep cố định).
 * - Nếu không tồn tại hoặc khớp nhiều phần tử không thể phân biệt, dừng và báo lỗi.
 * - Không tự thay bằng nhãn khác hoặc điều hướng URL khác.
 */
export async function clickContactInfoOnTabC(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn Contact info. Bước: "${stepName}".`);
  }

  const startTime = Date.now();
  const pollIntervalMs = 200;

  logger?.info('TabC: Đang chờ phần tử [aria-label="Contact info"] hiển thị và có thể thao tác...', {
    flow: 'yopmail-muse',
    step: stepName
  });

  const candidateSelectors = [
    '[aria-label="Contact info"]',
    '[aria-label="Thông tin liên hệ"]'
  ];

  let targetElement: Locator | null = null;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ "Contact info". Bước: "${stepName}".`);
    }

    await checkCaptchaOrVerification(page, 'TabC', stepName);

    for (const sel of candidateSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          const visibleMatches: Locator[] = [];
          for (let i = 0; i < count; i++) {
            const item = loc.nth(i);
            const isVis = await item.isVisible().catch(() => false);
            if (isVis) {
              visibleMatches.push(item);
            }
          }

          if (visibleMatches.length === 1) {
            const isEnabled = await visibleMatches[0].isEnabled().catch(() => false);
            if (isEnabled) {
              targetElement = visibleMatches[0];
              break;
            }
          } else if (visibleMatches.length > 1) {
            throw new Error(
              `[LỖI SELECTOR] TabC: Selector "${sel}" khớp ${visibleMatches.length} phần tử hiển thị. ` +
              `Không thể xác định duy nhất một phần tử Contact info phù hợp. Dừng luồng. Bước: "${stepName}".`
            );
          }
        }
      } catch (err: any) {
        if (err.message && err.message.includes('[LỖI SELECTOR]')) {
          throw err;
        }
      }
    }

    if (targetElement) {
      break;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!targetElement) {
    throw new Error(
      `[LỖI TIMEOUT] TabC: Quá thời gian (${timeoutMs}ms) khi chờ phần tử [aria-label="Contact info"] hiển thị và có thể thao tác. ` +
      `Không tự thay bằng nhãn khác hoặc điều hướng URL khác. Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Đã tìm thấy duy nhất phần tử [aria-label="Contact info"]. Đang click đúng một lần...', {
    flow: 'yopmail-muse',
    step: stepName
  });
  await targetElement.click();

  // Chờ khu vực thông tin liên hệ xuất hiện theo điều kiện DOM (không dùng sleep cố định)
  logger?.info('TabC: Đang chờ khu vực thông tin liên hệ xuất hiện theo điều kiện DOM...', {
    flow: 'yopmail-muse',
    step: stepName
  });

  const domConditionsStartTime = Date.now();
  let contactAreaAppeared = false;

  const contactAreaSelectors = [
    ':text("Add mobile number")',
    ':text("Add new contact")',
    ':text("Thêm số di động")',
    ':text("Thêm thông tin liên hệ")',
    '[aria-label="Add mobile number"]',
    '[aria-label="Add new contact"]',
    '[aria-label="Thêm số di động"]',
    '[role="presentation"]:has-text("Add mobile number")',
    '[role="presentation"]:has-text("Thêm số di động")'
  ];

  while (Date.now() - domConditionsStartTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng sau khi click Contact info. Bước: "${stepName}".`);
    }

    await checkCaptchaOrVerification(page, 'TabC', stepName);

    for (const sel of contactAreaSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          if (await loc.nth(i).isVisible().catch(() => false)) {
            contactAreaAppeared = true;
            break;
          }
        }
      } catch {}
      if (contactAreaAppeared) break;
    }

    if (contactAreaAppeared) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!contactAreaAppeared) {
    throw new Error(
      `[LỖI TIMEOUT] TabC: Quá thời gian (${timeoutMs}ms) chờ khu vực thông tin liên hệ xuất hiện theo điều kiện DOM sau khi click "Contact info". Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Khu vực thông tin liên hệ đã xuất hiện thành công theo điều kiện DOM.', {
    flow: 'yopmail-muse',
    step: stepName
  });
}

/**
 * Tìm thẻ/nút "Add new contact info" hoặc "Add new contact" trên trang Contact info của Meta.
 */
export async function findAddNewContactCard(page: Page): Promise<Locator | null> {
  const addNewContactTexts = [
    'Add new contact info',
    'Add new contact',
    'Thêm thông tin liên hệ mới',
    'Thêm thông tin liên hệ',
    'Thêm liên hệ mới'
  ];

  for (const tText of addNewContactTexts) {
    // 1. getByRole('button')
    if (typeof page.getByRole === 'function') {
      const btnLoc = page.getByRole('button', { name: tText, exact: true });
      const btnCount = await btnLoc.count().catch(() => 0);
      for (let i = 0; i < btnCount; i++) {
        const item = btnLoc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          return item;
        }
      }
    }

    // 2. [role="button"], button, a
    const interactive = page.locator(
      `[role="button"]:has-text("${tText}"), button:has-text("${tText}"), a:has-text("${tText}")`
    );
    const intCount = await interactive.count().catch(() => 0);
    for (let i = 0; i < intCount; i++) {
      const item = interactive.nth(i);
      if (await item.isVisible().catch(() => false)) {
        return item;
      }
    }

    // 3. [role="presentation"] chứa text
    const presCandidate = page.locator(`[role="presentation"]:has-text("${tText}")`);
    const presCount = await presCandidate.count().catch(() => 0);
    for (let i = 0; i < presCount; i++) {
      const item = presCandidate.nth(i);
      if (await item.isVisible().catch(() => false)) {
        const childBtn = item.locator('[role="button"], button, a');
        if ((await childBtn.count().catch(() => 0)) > 0) {
          const firstChild = childBtn.first();
          if (await firstChild.isVisible().catch(() => false)) {
            return firstChild;
          }
        }
        return item;
      }
    }

    // 4. span/div chứa text -> tìm ancestor clickable hoặc thẻ
    const textCandidate = page.locator(`span:has-text("${tText}"), div:has-text("${tText}")`);
    const textCount = await textCandidate.count().catch(() => 0);
    for (let i = 0; i < textCount; i++) {
      const item = textCandidate.nth(i);
      if (await item.isVisible().catch(() => false)) {
        const ancestorClickable = item.locator(
          'xpath=ancestor-or-self::*[@role="button" or @role="presentation" or self::button or @tabindex="0"][1]'
        );
        if ((await ancestorClickable.count().catch(() => 0)) > 0) {
          return ancestorClickable.first();
        }
        return item;
      }
    }
  }

  return null;
}

/**
 * Tìm mục/nút "Add mobile number" hoặc "Thêm số di động" trên TabC.
 */
export async function findAddMobileNumberItem(page: Page): Promise<Locator | null> {
  const targetTexts = ['Add mobile number', 'Thêm số di động'];

  for (const tText of targetTexts) {
    // 1. getByRole('button') / getByRole('link')
    if (typeof page.getByRole === 'function') {
      const btnLoc = page.getByRole('button', { name: tText, exact: true });
      const btnCount = await btnLoc.count().catch(() => 0);
      for (let i = 0; i < btnCount; i++) {
        const item = btnLoc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          return item;
        }
      }

      const linkLoc = page.getByRole('link', { name: tText, exact: true });
      const linkCount = await linkLoc.count().catch(() => 0);
      for (let i = 0; i < linkCount; i++) {
        const item = linkLoc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          return item;
        }
      }
    }

    // 2. [role="button"], button, a
    const candidateInteractive = page.locator(
      `button:has-text("${tText}"), [role="button"]:has-text("${tText}"), a:has-text("${tText}"), [aria-label="${tText}"]`
    );
    const candCount = await candidateInteractive.count().catch(() => 0);
    for (let i = 0; i < candCount; i++) {
      const item = candidateInteractive.nth(i);
      if (await item.isVisible().catch(() => false)) {
        return item;
      }
    }

    // 3. span/div chứa text -> ancestor button / link
    const spanLoc = page.locator(`span:has-text("${tText}")`);
    const spanCount = await spanLoc.count().catch(() => 0);
    for (let i = 0; i < spanCount; i++) {
      const s = spanLoc.nth(i);
      if (await s.isVisible().catch(() => false)) {
        const text = ((await s.innerText().catch(() => '')) || '').trim();
        if (text === tText) {
          const parentInteractive = s.locator(
            'xpath=ancestor-or-self::*[@role="button" or self::button or self::a or @tabindex="0"][1]'
          );
          if ((await parentInteractive.count().catch(() => 0)) > 0) {
            const pItem = parentInteractive.first();
            if (await pItem.isVisible().catch(() => false)) {
              return pItem;
            }
          }
          return s;
        }
      }
    }
  }

  return null;
}

/**
 * Thao tác trên TabC: Click thẻ "Add new contact info" (nếu có), sau đó chọn mục "Add mobile number" và chờ form hiển thị:
 * - Tìm và click thẻ/nút "Add new contact info" (hoặc "Add new contact", hỗ trợ song ngữ)
 * - Xử lý phần tử role="presentation" hoặc role="button" làm thẻ/nút tương tác
 * - Tìm và click mục "Add mobile number" (hoặc "Thêm số di động")
 * - Chờ form thêm số điện thoại hiển thị (input[type="tel"])
 * - Nếu xuất hiện bước chọn tài khoản chưa được mô tả -> dừng để người dùng xử lý
 */
export async function clickAddMobileNumberOnTabC(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn Add mobile number. Bước: "${stepName}".`);
  }

  const startTime = Date.now();
  const pollIntervalMs = 250;

  logger?.info(
    'TabC: Đang tìm thẻ "Add new contact info" hoặc mục "Add mobile number" trong khu vực Contact info...',
    { flow: 'yopmail-muse', step: stepName }
  );

  let hasClickedAddNewContact = false;
  let hasClickedAddMobileNumber = false;
  let formAppeared = false;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi thực hiện bước "${stepName}".`);
    }

    await checkCaptchaOrVerification(page, 'TabC', stepName);

    // 1. Kiểm tra nếu xuất hiện bước chọn tài khoản chưa được mô tả -> dừng an toàn
    const accountSelectCandidates = [
      ':text("Choose account")',
      ':text("Select accounts")',
      ':text("Chọn tài khoản")',
      '[aria-label*="Chọn tài khoản" i]',
      '[aria-label*="Choose account" i]'
    ];
    for (const accSel of accountSelectCandidates) {
      const accLoc = page.locator(accSel);
      const accCount = await accLoc.count().catch(() => 0);
      for (let i = 0; i < accCount; i++) {
        if (await accLoc.nth(i).isVisible().catch(() => false)) {
          const hasTel = (await page.locator('input[type="tel"]').count().catch(() => 0)) > 0;
          if (!hasTel) {
            throw new Error(
              `[CHỜ NGƯỜI DÙNG XỬ LÝ THỦ CÔNG] TabC: Xuất hiện bước chọn tài khoản chưa được mô tả trong quy trình ("${accSel}"). ` +
              `Hệ thống không tự ý chọn tài khoản hoặc mục khác. Dừng luồng để người dùng xử lý trên Chrome. Bước: "${stepName}".`
            );
          }
        }
      }
    }

    // 2. Nếu đã click Add mobile number hoặc Add new contact info, kiểm tra xem input[type="tel"] đã hiển thị chưa
    if (hasClickedAddMobileNumber || hasClickedAddNewContact) {
      const telLoc = page.locator('input[type="tel"]');
      const telCount = await telLoc.count().catch(() => 0);
      for (let i = 0; i < telCount; i++) {
        if (await telLoc.nth(i).isVisible().catch(() => false)) {
          formAppeared = true;
          break;
        }
      }
      if (formAppeared) break;
    }

    // 3. Nếu chưa click "Add new contact info", kiểm tra xem có thẻ "Add new contact info" hiển thị trên trang hay không
    if (!hasClickedAddNewContact) {
      const addNewContactCard = await findAddNewContactCard(page);
      if (addNewContactCard) {
        logger?.info(
          'TabC: Đã phát hiện thẻ "Add new contact info" / "Add new contact". Đang click vào thẻ để mở tùy chọn...',
          { flow: 'yopmail-muse', step: stepName }
        );
        try {
          await addNewContactCard.click({ timeout: 3000 });
        } catch {
          if (typeof addNewContactCard.evaluate === 'function') {
            await addNewContactCard.evaluate((el: HTMLElement) => el.click()).catch(() => {});
          }
        }
        hasClickedAddNewContact = true;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
    }

    // 4. Nếu chưa click "Add mobile number", tìm xem mục "Add mobile number" đã hiển thị chưa
    if (!hasClickedAddMobileNumber) {
      const addMobileItem = await findAddMobileNumberItem(page);
      if (addMobileItem) {
        const isEnabled = await addMobileItem.isEnabled().catch(() => false);
        if (isEnabled) {
          logger?.info('TabC: Đã tìm thấy mục "Add mobile number". Đang click...', {
            flow: 'yopmail-muse',
            step: stepName
          });
          try {
            await addMobileItem.click({ timeout: 3000 });
          } catch {
            if (typeof addMobileItem.evaluate === 'function') {
              await addMobileItem.evaluate((el: HTMLElement) => el.click()).catch(() => {});
            }
          }
          hasClickedAddMobileNumber = true;
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Fallback kiểm tra lần cuối nếu form đã xuất hiện
  if (!formAppeared) {
    const finalTelLoc = page.locator('input[type="tel"]');
    const finalCount = await finalTelLoc.count().catch(() => 0);
    for (let i = 0; i < finalCount; i++) {
      if (await finalTelLoc.nth(i).isVisible().catch(() => false)) {
        formAppeared = true;
        break;
      }
    }
  }

  if (!formAppeared) {
    throw new Error(
      `[LỖI TIMEOUT] TabC: Quá thời gian (${timeoutMs}ms) khi thao tác thẻ "Add new contact info" / "Add mobile number" ` +
      `và chờ form thêm số điện thoại hiển thị (không thấy input[type="tel"]). Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Form thêm số điện thoại đã hiển thị thành công (input[type="tel"] sẵn sàng).', {
    flow: 'yopmail-muse',
    step: stepName
  });
}

/**
 * Nhập lại số điện thoại đã chọn vào form "Add mobile number" trên TabC:
 * - Trong form thêm số điện thoại hiện hành, tìm input[type="tel"].
 * - Chờ input hiển thị, được bật và có thể nhập.
 * - Nếu có nhiều input type="tel", phải xác định đúng input của form "Add mobile number"; không dùng .first() tùy tiện.
 * - Dùng fill(selectedPhone) với selectedPhone đã lưu từ đầu luồng (giữ nguyên string bảo toàn số 0 và dấu +).
 * - Đọc lại inputValue() và so sánh để chắc chắn giá trị khớp với selectedPhone (hoặc tương đương qua isPhoneEquivalent).
 * - KHÔNG tự bấm Next, Save, Continue, Gửi mã hay bất kỳ nút submit nào.
 * - KHÔNG bấm Enter trong input.
 * - KHÔNG tự động gửi SMS hoặc WhatsApp.
 * - KHÔNG đọc OTP qua SMS.
 * - Ghi log: "Đã nhập lại số điện thoại đã chọn vào Add mobile number." (che/mask số điện thoại).
 * - Dừng tại đây, giữ nguyên TabC và các tab khác, nhường quyền điều khiển cho người dùng.
 */
export async function inputReenterPhoneOnTabC(options: {
  page: Page;
  stepName: string;
  phone: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, phone, timeoutMs, cancellationToken, logger } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi nhập lại số điện thoại. Bước: "${stepName}".`);
  }

  if (!phone || typeof phone !== 'string' || !phone.trim()) {
    throw new Error(
      `[LỖI TRẠNG THÁI] Không tìm thấy selectedPhone đã chọn từ các bước trước hoặc số rỗng. ` +
      `Không đọc lại file để chọn số mới. Bước: "${stepName}".`
    );
  }

  // Check và chọn mã quốc gia (+84) ngay lập tức khi vào form Add mobile number
  logger?.info(`TabC: Kiểm tra và chọn mã quốc gia (+84) ngay cho form Add mobile number...`, {
    flow: 'yopmail-muse',
    step: stepName
  });

  await ensureCountryCodeIsVietnam({
    page,
    stepName,
    timeoutMs: Math.min(timeoutMs, 10000),
    cancellationToken,
    logger
  });

  const startTime = Date.now();
  const pollIntervalMs = 200;

  logger?.info(`TabC: Đang chờ ô input nhập số điện thoại của form Add mobile number sẵn sàng...`, {
    flow: 'yopmail-muse',
    step: stepName
  });

  let targetTelInput: Locator | null = null;

  while (Date.now() - startTime < timeoutMs) {
    if (isCancelled(cancellationToken)) {
      throw new Error(`[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabC, bước "${stepName}".`);
    }
    if (page.isClosed()) {
      throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trong khi chờ ô nhập số điện thoại. Bước: "${stepName}".`);
    }

    await checkCaptchaOrVerification(page, 'TabC', stepName);

    const candidateSelectors = [
      'input[type="tel"]',
      'input[autocomplete="tel"]',
      'input[name*="phone" i]',
      'input[name*="mobile" i]',
      'input[placeholder*="mobile" i]',
      'input[placeholder*="phone" i]',
      'input[placeholder*="di động" i]',
      'input[placeholder*="điện thoại" i]'
    ];

    const visibleInputs: Locator[] = [];
    for (const sel of candidateSelectors) {
      const telLoc = page.locator(sel);
      const count = await telLoc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = telLoc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          visibleInputs.push(item);
        }
      }
      if (visibleInputs.length > 0) break;
    }

    if (visibleInputs.length === 1) {
      const item = visibleInputs[0];
      const isEditable = await item.isEditable().catch(() => true);
      const isEnabled = await item.isEnabled().catch(() => true);
      if (isEditable && isEnabled) {
        targetTelInput = item;
        break;
      }
    } else if (visibleInputs.length > 1) {
      // Nếu có nhiều hơn 1 input hiển thị, xác định input thuộc form "Add mobile number"
      for (const item of visibleInputs) {
        let inAddMobile = false;
        if (typeof item.evaluate === 'function') {
          inAddMobile = await item
            .evaluate((el: HTMLElement) => {
              const formOrDialog = el.closest('[role="dialog"], form, [aria-modal="true"]');
              const text = formOrDialog?.textContent || '';
              return /Add mobile number|Thêm số di động|Add mobile|Mobile number/i.test(text);
            })
            .catch(() => false);
        }
        if (inAddMobile) {
          targetTelInput = item;
          break;
        }
      }

      if (!targetTelInput && visibleInputs.length > 0) {
        targetTelInput = visibleInputs[0];
      }
      if (targetTelInput) break;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!targetTelInput) {
    throw new Error(
      `[LỖI TIMEOUT] TabC: Quá thời gian (${timeoutMs}ms) khi chờ ô input nhập số điện thoại của form Add mobile number. Bước: "${stepName}".`
    );
  }

  logger?.info(
    `TabC: Đang điền số điện thoại "${maskPhoneNumber(phone)}" vào input[type="tel"] (bảo toàn số 0 và dấu +)...`,
    { flow: 'yopmail-muse', step: stepName }
  );

  // Dùng fill(selectedPhone) với selectedPhone đã lưu từ đầu luồng (giữ nguyên string bảo toàn số 0 và dấu +)
  await targetTelInput.fill(phone);

  // Đọc lại inputValue() và so sánh để chắc chắn giá trị khớp với selectedPhone (hoặc tương đương qua isPhoneEquivalent)
  const actualVal = await targetTelInput.inputValue().catch(() => '');
  if (!isPhoneEquivalent(actualVal, phone)) {
    throw new Error(
      `[LỖI GIÁ TRỊ SỐ ĐIỆN THOẠI] TabC: Giá trị trong ô nhập "${maskPhoneNumber(actualVal)}" không khớp hoặc không tương đương với số đã chọn "${maskPhoneNumber(phone)}". Bước: "${stepName}".`
    );
  }

  // TUYỆT ĐỐI KHÔNG BẤM ENTER, KHÔNG CLICK BẤT KỲ NÚT SUBMIT / TIẾP / SAVE NÀO
  // TUYỆT ĐỐI KHÔNG GỬI SMS/WHATSAPP VÀ KHÔNG ĐỌC OTP
  const completionMsg = 'Đã nhập lại số điện thoại đã chọn vào Add mobile number.';
  logger?.info(`${completionMsg} (${maskPhoneNumber(phone)})`, { flow: 'yopmail-muse', step: stepName });
  console.log(completionMsg);
}

/**
 * Trên TabC, chọn span "Next" (hoặc "Tiếp" cho tiếng Việt), click đúng một lần và đợi trang/dialog tải xong:
 * - Sử dụng findInteractiveButtonWithSpanText để tìm phần tử tương tác bao bọc span chứa text "Next" hoặc "Tiếp".
 * - Kiểm tra nút hiển thị và đang được bật (isEnabled). Nếu disabled thì báo lỗi.
 * - Click đúng một lần.
 * - Đợi load xong theo các cơ chế:
 *   + waitForLoadState('load') hoặc waitForLoadState('networkidle') có bọc try/catch timeout an toàn.
 *   + Đợi nếu có spinner / thanh progress / indicator đang tải thì chờ nó ẩn đi.
 *   + Cho một khoảng chờ nhỏ để DOM ổn định.
 * - Ghi log: "TabC: Đã chọn span "Next" và hoàn tất chờ tải trang."
 */
export async function clickNextSpanOnTabC(options: {
  page: Page;
  stepName: string;
  timeoutMs: number;
  cancellationToken?: AbortSignal | CancellationToken;
  logger?: Logger;
}): Promise<void> {
  const { page, stepName, timeoutMs, cancellationToken, logger } = options;

  if (page.isClosed()) {
    throw new Error(`[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn nút Next. Bước: "${stepName}".`);
  }

  await checkCaptchaOrVerification(page, 'TabC', stepName);

  logger?.info('TabC: Đang tìm phần tử tương tác chứa span "Next" (hoặc "Tiếp")...', { flow: 'yopmail-muse', step: stepName });

  const nextBtn = await findInteractiveButtonWithSpanText({
    page,
    targetText: ['Next', 'Tiếp'],
    tabName: 'TabC',
    stepName,
    timeoutMs,
    cancellationToken,
    logger
  });

  const isEnabled = await nextBtn.isEnabled().catch(() => false);
  if (!isEnabled) {
    throw new Error(
      `[LỖI NÚT NEXT BỊ VÔ HIỆU HÓA] TabC: Nút "Next" / "Tiếp" đang bị vô hiệu hóa (disabled). Không dùng force: true để bấm. Bước: "${stepName}".`
    );
  }

  logger?.info('TabC: Đang click nút có span "Next" đúng một lần...', { flow: 'yopmail-muse', step: stepName });
  await nextBtn.click();

  // Đợi tải xong
  logger?.info('TabC: Đang chờ tải trang sau khi click "Next"...', { flow: 'yopmail-muse', step: stepName });

  if (typeof page.waitForLoadState === 'function') {
    await Promise.race([
      page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 10000) }).catch(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ]);
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000) }).catch(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ]);
  }

  // Chờ spinner / indicator ẩn đi nếu có
  const spinnerSelector = '[role="progressbar"], svg.animate-spin, .spinner, div[aria-busy="true"]';
  const spinnerLoc = page.locator(spinnerSelector);
  const spinStartTime = Date.now();
  while (Date.now() - spinStartTime < 5000) {
    if (page.isClosed()) break;
    const spinCount = await spinnerLoc.count().catch(() => 0);
    let hasVisibleSpinner = false;
    for (let i = 0; i < spinCount; i++) {
      if (await spinnerLoc.nth(i).isVisible().catch(() => false)) {
        hasVisibleSpinner = true;
        break;
      }
    }
    if (!hasVisibleSpinner) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Chờ ngắn để DOM ổn định sau load
  await new Promise((r) => setTimeout(r, 500));

  const completionMsg = 'TabC: Đã chọn span "Next" và hoàn tất chờ tải trang.';
  logger?.info(completionMsg, { flow: 'yopmail-muse', step: stepName });
  console.log(completionMsg);
}

/**
 * Quay lại kích hoạt TabB làm tab hiện hành (bring to front):
 * - Kiểm tra TabB phải tồn tại và chưa bị đóng.
 * - Trích xuất và kiểm tra URL hiện tại của TabB (phải là http hoặc https hợp lệ).
 * - Không ghi query string hoặc URL chứa dữ liệu nhạy cảm vào log.
 * - Gọi tabB.bringToFront() để hiển thị TabB lên foreground.
 * - Trả về URL hợp lệ để lưu vào state.tabBUrl.
 */
export async function activateTabB(options: {
  pageB: Page;
  stepName: string;
  logger?: Logger;
}): Promise<string> {
  const { pageB, stepName, logger } = options;

  if (!pageB || (typeof pageB.isClosed === 'function' && pageB.isClosed())) {
    throw new Error(
      `[LỖI TAB ĐÃ ĐÓNG] TabB không tồn tại hoặc đã bị đóng trước khi kích hoạt lại. Bước: "${stepName}".`
    );
  }

  // Lấy URL hiện tại của TabB
  const rawUrl = typeof pageB.url === 'function' ? pageB.url() : 'https://muse.ai';
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error(`[LỖI URL TAB B] URL của TabB không được để trống. Bước: "${stepName}".`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error(`[LỖI URL TAB B] URL của TabB không hợp lệ: "${sanitizeUrl(rawUrl)}". Bước: "${stepName}".`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `[LỖI URL TAB B] URL của TabB không sử dụng giao thức http hoặc https ("${parsedUrl.protocol}"). Bước: "${stepName}".`
    );
  }

  // Không ghi query string hoặc dữ liệu nhạy cảm vào log
  const safeUrlForLog = `${parsedUrl.origin}${parsedUrl.pathname}`;
  logger?.info(`TabB: Đang kích hoạt TabB làm tab hiện hành (bringToFront) tại URL: ${safeUrlForLog}...`, {
    flow: 'yopmail-muse',
    step: stepName
  });

  if (typeof pageB.bringToFront === 'function') {
    await pageB.bringToFront();
  }

  const completionMsg = 'TabB: Đã quay lại và kích hoạt TabB làm tab hiện hành (UI foreground).';
  logger?.info(completionMsg, { flow: 'yopmail-muse', step: stepName });
  console.log(completionMsg);

  return rawUrl.trim();
}

/**
 * Luồng tuần tự hai tab tích hợp Temp-Mail:
 * TabA mở Temp-Mail (https://temp-mail.io/vi) lấy địa chỉ email;
 * TabB mở Muse.ai nhập email và bấm tiếp tục;
 * Quay lại TabA, chờ thư và làm mới nếu cần (tối đa 3 lần refresh), mở thư, trích xuất mã OTP 6 số;
 * TabB nhập mã OTP và bấm xác nhận đúng một lần;
 * Sau đó tiếp tục các bước thông tin cá nhân và 2FA Meta.
 */
export const yopmailMuseFlow: Flow = {
  name: 'yopmail-muse',
  description: 'Luồng tuần tự hai tab: TabA mở Temp-Mail lấy email, TabB mở Muse.ai gửi OTP, TabA lấy OTP, TabB nhập OTP và xác nhận',
  supportsConcurrency: false,
  steps: [
    {
      id: 'tabA-tempmail',
      name: 'Thao tác trên TabA: Mở Temp-Mail và lấy địa chỉ email',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        const browserContext = context.page.context();

        context.logger.info('TabA: Bắt đầu tạo TabA trong browser context hiện có...', { flow: 'yopmail-muse', step: 'tabA-tempmail' });
        const tabA = await browserContext.newPage();
        state.tabA = tabA;
        context.page = tabA;
        tabA.setDefaultTimeout(context.config.actionTimeoutMs);
        tabA.setDefaultNavigationTimeout(context.config.navigationTimeoutMs);
        context.logger.info('TabA: Đã tạo tab mới thành công.', { flow: 'yopmail-muse', step: 'tabA-tempmail' });

        context.logger.info('TabA: Đang truy cập https://temp-mail.io/vi ...', { flow: 'yopmail-muse', step: 'tabA-tempmail' });
        if (tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trước khi truy cập URL. Bước: "tabA-tempmail".');
        }
        await safeGoto(tabA, 'https://temp-mail.io/vi', {
          waitUntil: 'domcontentloaded',
          timeout: context.config.navigationTimeoutMs,
          maxRetries: context.config.pageLoadMaxRetries,
          retryDelayMs: context.config.pageLoadRetryDelayMs,
          logger: context.logger,
          cancellationToken: context.cancellationToken,
          flowName: 'yopmail-muse',
          stepName: 'tabA-tempmail'
        });
        if (tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng sau khi tải trang. Bước: "tabA-tempmail".');
        }
        context.logger.info('TabA: Đã tải xong trang Temp-Mail.', { flow: 'yopmail-muse', step: 'tabA-tempmail' });

        const emailAddress = await fetchEmailFromTempMail({
          page: tabA,
          stepName: 'tabA-tempmail',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.emailAddress = emailAddress;
        context.logger.info(`TabA: Đã lấy emailAddress thành công: "${state.emailAddress}"`, { flow: 'yopmail-muse', step: 'tabA-tempmail' });
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabA && !state.tabA.isClosed() && state.emailAddress && isValidBasicEmail(state.emailAddress));
      }
    },
    {
      id: 'tabB-muse',
      name: 'Thao tác trên TabB: Mở Muse.ai, nhập email và bấm tiếp tục',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        const browserContext = context.page.context();

        if (!state.tabA || state.tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA không tồn tại hoặc đã bị đóng trước khi chuyển sang TabB. Không tự tạo tab thay thế. Bước: "tabB-muse".');
        }
        if (!state.emailAddress) {
          throw new Error('[LỖI TRẠNG THÁI] Chưa lấy được địa chỉ email từ TabA. Bước: "tabB-muse".');
        }

        context.logger.info('TabB: Bắt đầu tạo TabB trong cùng browser context hiện có...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        const tabB = await browserContext.newPage();
        state.tabB = tabB;
        context.page = tabB;
        tabB.setDefaultTimeout(context.config.actionTimeoutMs);
        tabB.setDefaultNavigationTimeout(context.config.navigationTimeoutMs);
        context.logger.info('TabB: Đã tạo tab mới thành công.', { flow: 'yopmail-muse', step: 'tabB-muse' });

        context.logger.info('TabB: Đang truy cập https://muse.ai/ ...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        if (tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi tải URL. Không tự tạo tab thay thế. Bước: "tabB-muse".');
        }
        await safeGoto(tabB, 'https://muse.ai/', {
          waitUntil: 'domcontentloaded',
          timeout: context.config.navigationTimeoutMs,
          maxRetries: context.config.pageLoadMaxRetries,
          retryDelayMs: context.config.pageLoadRetryDelayMs,
          logger: context.logger,
          cancellationToken: context.cancellationToken,
          flowName: 'yopmail-muse',
          stepName: 'tabB-muse'
        });
        if (tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng sau khi tải URL. Không tự tạo tab thay thế. Bước: "tabB-muse".');
        }
        context.logger.info('TabB: Đã tải xong trang Muse.ai.', { flow: 'yopmail-muse', step: 'tabB-muse' });

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
            const isContactBtnEnabled = await contactBtnLocator.first().isEnabled().catch(() => false);
            if (isContactBtnEnabled) {
              context.logger.info('TabB: Đã tìm thấy [data-pel-click="login_use_contact_click"] và nút đã enable. Đang click...', { flow: 'yopmail-muse', step: 'tabB-muse' });
              await contactBtnLocator.first().click();
              context.logger.info('TabB: Đã click [data-pel-click="login_use_contact_click"] thành công.', { flow: 'yopmail-muse', step: 'tabB-muse' });
              break;
            }
          }

          const hasInput = (await inputLocator.count().catch(() => 0)) > 0 &&
            (await inputLocator.first().isVisible().catch(() => false));

          if (hasInput) {
            context.logger.info('TabB: Form đã hiển thị sẵn input[data-slot="input"], sẵn sàng để nhập email.', { flow: 'yopmail-muse', step: 'tabB-muse' });
            break;
          }

          await new Promise((r) => setTimeout(r, 200));
        }

        context.logger.info('TabB: Chờ nút tiếp tục (selector "[data-pel-click=\\"login_contact_continue_click\\"]") hiển thị và kích hoạt (enable) trước khi nhập email...', { flow: 'yopmail-muse', step: 'tabB-muse' });
        const continueBtn = await waitForSingleMatchingElement({
          page: tabB,
          selector: '[data-pel-click="login_contact_continue_click"]',
          tabName: 'TabB',
          stepName: 'tabB-muse',
          timeoutMs: context.config.actionTimeoutMs,
          role: 'clickable',
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });
        context.logger.info('TabB: Nút tiếp tục đã kích hoạt (enable). Đang chuẩn bị nhập/paste email...', { flow: 'yopmail-muse', step: 'tabB-muse' });

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

        context.logger.info(`TabB: Đang dùng fill() nhập emailAddress "${state.emailAddress}" vào input[data-slot="input"]...`, { flow: 'yopmail-muse', step: 'tabB-muse' });
        await emailInput.fill(state.emailAddress);

        const actualEmail = await emailInput.inputValue();
        if (actualEmail !== state.emailAddress) {
          throw new Error(
            `[TabB] Giá trị input không khớp với emailAddress: mong muốn "${state.emailAddress}", thực tế "${actualEmail}". ` +
            `Bước: "tabB-muse", Selector: "input[data-slot=\\"input\\"]"`
          );
        }
        context.logger.info(`TabB: Đã kiểm tra giá trị input khớp chính xác với emailAddress ("${actualEmail}").`, { flow: 'yopmail-muse', step: 'tabB-muse' });

        // Delay khoảng 2 giây sau khi nhập email vào input cho đến khi nút click được
        const delayAfterPasteMs = 2000;
        context.logger.info(
          `TabB: Đã nhập email vào input. Tạm dừng ${delayAfterPasteMs}ms (khoảng 2 giây) cho đến khi nút tiếp tục sẵn sàng bấm...`,
          { flow: 'yopmail-muse', step: 'tabB-muse' }
        );
        const delayStartTime = Date.now();
        while (Date.now() - delayStartTime < delayAfterPasteMs) {
          if (isCancelled(context.cancellationToken)) {
            throw new Error('[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabB, bước "tabB-muse".');
          }
          if (tabB.isClosed()) {
            throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng sau khi nhập email. Không tự tạo tab thay thế. Bước: "tabB-muse".');
          }
          await checkCaptchaOrVerification(tabB, 'TabB', 'tabB-muse');
          await new Promise((resolve) => setTimeout(resolve, Math.min(200, delayAfterPasteMs - (Date.now() - delayStartTime))));
        }

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
      name: 'Quay lại TabA: Chờ thư và trích xuất mã OTP',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);

        if (!state.tabA || state.tabA.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabA đã bị đóng trước khi chờ thư. Không tự tạo tab thay thế. Bước: "tabA-extract-otp".');
        }
        if (!state.emailAddress) {
          throw new Error('[LỖI TRẠNG THÁI] Chưa có emailAddress trong bộ nhớ. Bước: "tabA-extract-otp".');
        }

        const tabA = state.tabA;
        context.page = tabA;
        await tabA.bringToFront().catch(() => {});

        const originalScreenshotOnError = context.config.screenshotOnError;
        context.config.screenshotOnError = false;

        try {
          context.logger.info('TabA: Quay lại TabA để chờ thư từ Muse.ai và lấy mã OTP...', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

          const otpCode = await extractOtpFromTempMail({
            page: tabA,
            emailAddress: state.emailAddress,
            stepName: 'tabA-extract-otp',
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken,
            logger: context.logger
          });

          state.otpCode = otpCode;
          context.logger.info('TabA: Đã trích xuất thành công mã OTP gồm 6 chữ số hợp lệ từ nội dung thư.', { flow: 'yopmail-muse', step: 'tabA-extract-otp' });

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

        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng trước khi nhập OTP. Không tự tạo tab thay thế. Bước: "tabB-submit-otp".');
        }
        if (!state.otpCode || !isValidOtpCode(state.otpCode)) {
          throw new Error('[LỖI OTP] Mã OTP trong bộ nhớ không hợp lệ hoặc chưa được trích xuất. Bước: "tabB-submit-otp".');
        }

        const tabB = state.tabB;
        context.page = tabB;

        if (typeof tabB.bringToFront === 'function') {
          await tabB.bringToFront().catch(() => {});
        }
        if (typeof tabB.evaluate === 'function') {
          await tabB.evaluate(() => window.focus()).catch(() => {});
        }
        context.logger.info('TabB: Đã kích hoạt và đưa TabB lên tiêu điểm chính (UI foreground).', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });

        const originalScreenshotOnError = context.config.screenshotOnError;
        context.config.screenshotOnError = false;

        try {
          context.logger.info('TabB: Quay lại TabB để nhập mã OTP...', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });

          await enterOtpIntoTabB({
            page: tabB,
            otpCode: state.otpCode,
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken
          });

          context.logger.info('TabB: Đã nhập và kiểm tra giá trị khớp chính xác với mã OTP 6 số.', { flow: 'yopmail-muse', step: 'tabB-submit-otp' });

          // Kiểm tra trạng thái chuyển tiếp sau khi nhập OTP:
          // Trên Muse.ai, ngay sau khi nhập đủ 6 chữ số, hệ thống tự động xác thực và có thể chuyển thẳng sang bước nhập First name,
          // hoặc nút [data-pel-click="login_otp_confirm_click"] vẫn hiển thị để người dùng xác nhận.
          context.logger.info('TabB: Đang kiểm tra điều kiện chuyển tiếp: tự động chuyển sang form nhập First name hoặc hiển thị nút xác nhận OTP...', {
            flow: 'yopmail-muse',
            step: 'tabB-submit-otp'
          });

          const profileSelector = 'input[aria-label="First name"]';
          const confirmSelector = '[data-pel-click="login_otp_confirm_click"]';
          const startTime = Date.now();
          const timeoutMs = context.config.actionTimeoutMs;

          let transitionedDirectly = false;
          let confirmClicked = false;

          while (Date.now() - startTime < timeoutMs) {
            if (isCancelled(context.cancellationToken)) {
              throw new Error('[HỦY BỎ] Luồng nhận tín hiệu dừng tại TabB, bước "tabB-submit-otp".');
            }
            if (tabB.isClosed()) {
              throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB đã bị đóng sau khi nhập OTP. Bước: "tabB-submit-otp".');
            }
            await checkCaptchaOrVerification(tabB, 'TabB', 'tabB-submit-otp');

            // 1. Kiểm tra nếu trang đã tự động chuyển sang bước nhập First name / Profile
            let profileDetected = false;
            let matchedProfileSel = '';

            for (const sel of FIRST_NAME_CANDIDATE_SELECTORS) {
              const loc = tabB.locator(sel);
              const count = await loc.count().catch(() => 0);
              if (count > 0 && (await safeCheckLocVisible(loc))) {
                profileDetected = true;
                matchedProfileSel = sel;
                break;
              }
            }

            if (!profileDetected) {
              const bdayLoc = tabB.locator('[data-pel-click="login_birthday_continue_click"]');
              if ((await bdayLoc.count().catch(() => 0)) > 0 && (await safeCheckLocVisible(bdayLoc))) {
                profileDetected = true;
                matchedProfileSel = '[data-pel-click="login_birthday_continue_click"]';
              }
            }

            // Hoặc kiểm tra nếu các ô nhập OTP [data-slot="pin-digit"] đã biến mất sau ít nhất 500ms
            if (!profileDetected && Date.now() - startTime >= 500) {
              const pinDigitLoc = tabB.locator('[data-slot="pin-digit"]');
              const pinCount = await pinDigitLoc.count().catch(() => 0);
              let pinVis = false;
              if (pinCount > 0) {
                pinVis = await safeCheckLocVisible(pinDigitLoc);
              }
              if (!pinVis) {
                profileDetected = true;
                matchedProfileSel = 'OTP inputs unmounted';
              }
            }

            if (profileDetected) {
              transitionedDirectly = true;
              context.logger.info(
                `TabB: Sau khi nhập mã OTP, trang đã tự động chuyển thẳng sang bước nhập thông tin cá nhân (${matchedProfileSel}). Bỏ qua click nút xác nhận OTP.`,
                { flow: 'yopmail-muse', step: 'tabB-submit-otp' }
              );
              break;
            }

            // 2. Kiểm tra nếu nút xác nhận OTP hiển thị và có thể thao tác
            const confirmLoc = tabB.locator(confirmSelector);
            const confirmCount = await confirmLoc.count().catch(() => 0);
            if (confirmCount > 0) {
              const isConfirmVis = await safeCheckLocVisible(confirmLoc);
              const isConfirmEnabled = await safeCheckLocEnabled(confirmLoc);

              if (isConfirmVis && isConfirmEnabled) {
                context.logger.info('TabB: Nút [data-pel-click="login_otp_confirm_click"] hiển thị và có thể thao tác. Đang click đúng một lần...', {
                  flow: 'yopmail-muse',
                  step: 'tabB-submit-otp'
                });
                try {
                  await safeLocClick(confirmLoc);
                  confirmClicked = true;
                } catch (clickErr) {
                  transitionedDirectly = true;
                  break;
                }
                break;
              }
            }

            await new Promise((r) => setTimeout(r, 200));
          }

          if (!transitionedDirectly && !confirmClicked) {
            // Kiểm tra fallback lần cuối: ô nhập OTP còn hiển thị không
            const pinDigitLoc = tabB.locator('[data-slot="pin-digit"]');
            const pinVis = (await pinDigitLoc.count().catch(() => 0)) > 0 && (await safeCheckLocVisible(pinDigitLoc));
            if (!pinVis) {
              transitionedDirectly = true;
            } else {
              throw new Error(
                `[LỖI TIMEOUT] TabB: Quá thời gian (${timeoutMs}ms) mà trang không chuyển sang bước nhập First name và cũng không thể bấm nút xác nhận OTP. Bước: "tabB-submit-otp".`
              );
            }
          }

          const completionMsg = transitionedDirectly
            ? 'Đã nhập mã 6 số và trang tự động chuyển tiếp tới bước nhập name.'
            : 'Đã nhập mã 6 số và bấm xác nhận.';
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
        for (const sel of FIRST_NAME_CANDIDATE_SELECTORS) {
          const loc = state.tabB.locator(sel);
          if ((await loc.count().catch(() => 0)) > 0) return true;
        }
        return false;
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
        for (const sel of FIRST_NAME_CANDIDATE_SELECTORS) {
          const loc = state.tabB.locator(sel);
          if ((await safeGetLocCount(loc)) > 0) {
            const val = await safeGetLocInputValue(loc);
            if (val === 'Dang') return true;
          }
        }
        return false;
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
        for (const sel of LAST_NAME_CANDIDATE_SELECTORS) {
          const loc = state.tabB.locator(sel);
          if ((await safeGetLocCount(loc)) > 0) {
            const val = await safeGetLocInputValue(loc);
            if (val === 'Dao') return true;
          }
        }
        return false;
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
        for (const sel of YEAR_CANDIDATE_SELECTORS) {
          const loc = state.tabB.locator(sel);
          if ((await safeGetLocCount(loc)) > 0) {
            const val = await safeGetLocInputValue(loc);
            if (val === '2000') return true;
          }
        }
        return false;
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

        // Đảm bảo Tab B đã hiển thị "Tham gia danh sách chờ Muse" trước khi mở Tab C
        if (state.tabB && !state.tabB.isClosed()) {
          context.logger.info('TabB: Xác nhận màn hình "Tham gia danh sách chờ Muse" hiển thị trước khi mở TabC...', {
            flow: 'yopmail-muse',
            step: 'tabC-open-meta-security'
          });
          await waitForMuseWaitlistScreen({
            page: state.tabB,
            stepName: 'tabC-open-meta-security',
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken,
            logger: context.logger
          });
        }

        const browserContext = (state.tabB || state.tabA || context.page).context();

        context.logger.info('TabC: Đang tạo tab mới trong cùng browser context hiện tại (giữ nguyên TabA và TabB)...', {
          flow: 'yopmail-muse',
          step: 'tabC-open-meta-security'
        });

        const tabC = await browserContext.newPage();
        state.tabC = tabC;
        context.page = tabC;

        if (typeof tabC.bringToFront === 'function') {
          await tabC.bringToFront().catch(() => {});
        }

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

        await safeGoto(tabC, metaUrl, {
          timeout: context.config.navigationTimeoutMs,
          maxRetries: context.config.pageLoadMaxRetries,
          retryDelayMs: context.config.pageLoadRetryDelayMs,
          logger: context.logger,
          cancellationToken: context.cancellationToken,
          flowName: 'yopmail-muse',
          stepName: 'tabC-open-meta-security'
        });

        // Xử lý cookie consent trên TabC nếu có (tối đa 2 bước bấm "Allow all cookies", mỗi lần bấm đợi trang load xong)
        await handleMetaCookieConsent({
          page: tabC,
          stepName: 'tabC-open-meta-security',
          maxSteps: 2,
          timeoutPerStepMs: 4000,
          logger: context.logger,
          cancellationToken: context.cancellationToken
        });

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

        const twoFactorItem = await waitForAnyMatchingElement({
          page: tabC,
          candidateSelectors: [
            '[aria-label="Xác thực 2 yếu tố"]',
            '[aria-label="Two-factor authentication"]',
            '[aria-label*="Two-factor" i]',
            '[aria-label*="Xác thực 2" i]',
            ':has-text("Two-factor authentication")',
            ':has-text("Xác thực 2 yếu tố")'
          ],
          tabName: 'TabC',
          stepName: 'tabC-click-two-factor',
          timeoutMs: context.config.actionTimeoutMs,
          role: 'clickable',
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        context.logger.info('TabC: Đang click mục Xác thực 2 yếu tố / Two-factor authentication...', {
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

        context.logger.info('TabC: Đang tìm phần tử tương tác chứa span "Bắt đầu" / "Get started" trong khu vực hoặc dialog...', {
          flow: 'yopmail-muse',
          step: 'tabC-click-start'
        });

        const startBtn = await findInteractiveButtonWithSpanText({
          page: tabC,
          targetText: ['Bắt đầu', 'Get started', 'Start'],
          tabName: 'TabC',
          stepName: 'tabC-click-start',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        const isEnabled = await startBtn.isEnabled().catch(() => false);
        if (!isEnabled) {
          throw new Error('[LỖI NÚT BỊ VÔ HIỆU HÓA] TabC: Nút "Bắt đầu" / "Get started" đang bị vô hiệu hóa. Bước: "tabC-click-start".');
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

        context.logger.info('TabC: Đang tìm nút tương tác chứa span "Tiếp tục" / "Continue" với nội dung chính xác trong dialog...', {
          flow: 'yopmail-muse',
          step: 'tabC-click-continue'
        });

        const continueBtn = await findInteractiveButtonWithSpanText({
          page: tabC,
          targetText: ['Tiếp tục', 'Continue'],
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
    },
    {
      id: 'tabC-click-contact-info',
      name: 'TabC: Chọn mục "Contact info"',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn Contact info. Bước: "tabC-click-contact-info".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        await clickContactInfoOnTabC({
          page: tabC,
          stepName: 'tabC-click-contact-info',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.contactInfoOpened = true;
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.contactInfoOpened === true && state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-click-add-mobile-number',
      name: 'TabC: Chọn mục "Add mobile number"',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn Add mobile number. Bước: "tabC-click-add-mobile-number".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        await clickAddMobileNumberOnTabC({
          page: tabC,
          stepName: 'tabC-click-add-mobile-number',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.addMobileFormOpened = true;
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.addMobileFormOpened === true && state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-input-reenter-phone',
      name: 'TabC: Nhập lại số điện thoại đã chọn vào Add mobile number',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi nhập lại số điện thoại. Bước: "tabC-input-reenter-phone".');
        }
        if (!state.selectedPhone) {
          throw new Error(
            '[LỖI TRẠNG THÁI] Không tìm thấy selectedPhone đã chọn từ các bước trước. Không đọc lại file để chọn số mới. Bước: "tabC-input-reenter-phone".'
          );
        }

        const tabC = state.tabC;
        context.page = tabC;

        const originalScreenshotOnError = context.config.screenshotOnError;
        context.config.screenshotOnError = false;

        try {
          await inputReenterPhoneOnTabC({
            page: tabC,
            stepName: 'tabC-input-reenter-phone',
            phone: state.selectedPhone,
            timeoutMs: context.config.actionTimeoutMs,
            cancellationToken: context.cancellationToken,
            logger: context.logger
          });
        } finally {
          context.config.screenshotOnError = originalScreenshotOnError;
        }

        state.reenteredPhone = state.selectedPhone;
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.reenteredPhone && state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabC-submit-next',
      name: 'TabC: Chọn span "Next" và đợi tải xong',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabC || state.tabC.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabC đã bị đóng trước khi chọn nút Next. Bước: "tabC-submit-next".');
        }

        const tabC = state.tabC;
        context.page = tabC;

        await clickNextSpanOnTabC({
          page: tabC,
          stepName: 'tabC-submit-next',
          timeoutMs: context.config.actionTimeoutMs,
          cancellationToken: context.cancellationToken,
          logger: context.logger
        });

        state.tabCNextSubmitted = true;
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabCNextSubmitted === true && state.tabC && !state.tabC.isClosed());
      }
    },
    {
      id: 'tabB-activate',
      name: 'Quay lại và kích hoạt TabB',
      execute: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        if (!state.tabB || state.tabB.isClosed()) {
          throw new Error('[LỖI TAB ĐÃ ĐÓNG] TabB không tồn tại hoặc đã bị đóng trước khi kích hoạt lại. Bước: "tabB-activate".');
        }

        const tabB = state.tabB;
        const tabBUrl = await activateTabB({
          pageB: tabB,
          stepName: 'tabB-activate',
          logger: context.logger
        });

        context.page = tabB;
        state.tabBUrl = tabBUrl;
        state.tabBReactivated = true;

        // Đảm bảo email sau khi hoàn tất xác thực được lưu vào danh sách txt output
        if (state.emailAddress) {
          await saveEmailToOutputFile(state.emailAddress, {
            filePath: context.config.outputEmailsFile,
            logger: context.logger
          }).catch(() => {});
        }

        context.logger.info(
          '✔ [XÁC THỰC HOÀN TẤT] Đã hoàn thành các bước xác thực tài khoản! Tab B đã được kích hoạt trên màn hình (không reload Tab B).',
          { flow: 'yopmail-muse', step: 'tabB-activate' }
        );
      },
      verify: async (context: FlowContext) => {
        const state = getYopmailMuseState(context);
        return Boolean(state.tabBReactivated === true && state.tabBUrl && state.tabB && !state.tabB.isClosed());
      }
    }
  ]
};
