import * as assert from 'assert';
import { Page, Locator } from 'playwright';
import {
  handleMetaCookieConsent,
  META_COOKIE_BUTTON_SELECTORS
} from '../src/flows/yopmail-muse.flow';

console.log('--- BẮT ĐẦU KIỂM TRA XỬ LÝ COOKIE BANNER TRÊN TAB C (2 BƯỚC "ALLOW ALL COOKIES") ---');

// Mock helper tạo Page cho test cookie banner
function createMockTabCPage(options?: {
  visibleSelectors?: string[][]; // Mỗi lượt kiểm tra có thể trả về các selector hiển thị khác nhau
  onButtonClick?: (selector: string, step: number) => void;
  onWaitForLoad?: (step: number) => void;
  isClosed?: boolean;
}): { page: Page; getClickHistory: () => string[]; getLoadHistory: () => number[] } {
  const clickHistory: string[] = [];
  const loadHistory: number[] = [];
  let currentCheckIndex = 0;
  const isClosed = options?.isClosed ?? false;

  const mockLocator = (selector: string): Locator => {
    return {
      count: async () => {
        const currentActiveList = options?.visibleSelectors
          ? options.visibleSelectors[Math.min(currentCheckIndex, options.visibleSelectors.length - 1)] || []
          : [];
        return currentActiveList.includes(selector) ? 1 : 0;
      },
      first: () => mockLocator(selector),
      nth: () => mockLocator(selector),
      isVisible: async () => {
        const currentActiveList = options?.visibleSelectors
          ? options.visibleSelectors[Math.min(currentCheckIndex, options.visibleSelectors.length - 1)] || []
          : [];
        return currentActiveList.includes(selector);
      },
      click: async () => {
        clickHistory.push(selector);
        options?.onButtonClick?.(selector, currentCheckIndex + 1);
        // Sau khi click thì chuyển sang state tiếp theo
        currentCheckIndex++;
      }
    } as unknown as Locator;
  };

  const page = {
    isClosed: () => isClosed,
    locator: (selector: string) => mockLocator(selector),
    waitForLoadState: async (state: string) => {
      loadHistory.push(Date.now());
      options?.onWaitForLoad?.(currentCheckIndex);
    }
  } as unknown as Page;

  return { page, getClickHistory: () => clickHistory, getLoadHistory: () => loadHistory };
}

function createMockLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    info: (msg: string) => logs.push({ level: 'info', msg }),
    warn: (msg: string) => logs.push({ level: 'warn', msg }),
    error: (msg: string) => logs.push({ level: 'error', msg })
  };
}

async function runTests() {
  // Test 1: Kiểm tra danh sách selector nhận diện nút Allow all cookies
  console.log('\n1. Kiểm tra danh sách selector nhận diện:');
  assert.ok(META_COOKIE_BUTTON_SELECTORS.includes('button:has-text("Allow all cookies")'));
  assert.ok(META_COOKIE_BUTTON_SELECTORS.includes('[role="button"]:has-text("Allow all cookies")'));
  assert.ok(META_COOKIE_BUTTON_SELECTORS.includes('button:has-text("Cho phép tất cả cookie")'));
  assert.ok(META_COOKIE_BUTTON_SELECTORS.includes('[data-cookiebanner="accept_button"]'));
  console.log('  ✔ Danh sách selector đầy đủ các biến thể nút "Allow all cookies" trên Meta.');

  // Test 2: Không có banner cookie -> Hoàn tất nhanh chóng, clickCount = 0
  console.log('\n2. Kiểm tra khi trang không có banner cookie:');
  {
    const { page, getClickHistory } = createMockTabCPage({
      visibleSelectors: [] // không có selector nào
    });

    const logger = createMockLogger();
    const count = await handleMetaCookieConsent({
      page,
      stepName: 'test-no-cookie',
      timeoutPerStepMs: 100,
      logger: logger as any
    });

    assert.strictEqual(count, 0, 'Phải trả về 0 khi không có cookie banner.');
    assert.strictEqual(getClickHistory().length, 0, 'Không được click nút nào.');
    console.log('  ✔ Khi không có banner cookie, luồng tiếp tục mượt mà không bị treo.');
  }

  // Test 3: Có 1 dialog "Allow all cookies" (1 bước)
  console.log('\n3. Kiểm tra khi có 1 dialog "Allow all cookies" (1 bước):');
  {
    const targetSel = 'button:has-text("Allow all cookies")';
    const { page, getClickHistory, getLoadHistory } = createMockTabCPage({
      visibleSelectors: [
        [targetSel], // Lần 1: có nút
        []          // Lần 2: sau khi click, nút biến mất
      ]
    });

    const logger = createMockLogger();
    const count = await handleMetaCookieConsent({
      page,
      stepName: 'test-1-step',
      timeoutPerStepMs: 100,
      logger: logger as any
    });

    assert.strictEqual(count, 1, 'Phải click đúng 1 lần.');
    assert.strictEqual(getClickHistory().length, 1);
    assert.strictEqual(getClickHistory()[0], targetSel);
    assert.ok(getLoadHistory().length >= 1, 'Phải đợi trang tải xong sau khi bấm.');

    const logMsgs = logger.logs.map((l) => l.msg);
    assert.ok(logMsgs.some((m) => m.includes('Đang thực hiện bấm')));
    assert.ok(logMsgs.some((m) => m.includes('Đang đợi trang tải xong')));
    assert.ok(logMsgs.some((m) => m.includes('Đã hoàn tất tải trang')));
    console.log('  ✔ Bấm "Allow all cookies" 1 bước và đợi trang load xong thành công.');
  }

  // Test 4: Có 2 dialog "Allow all cookies" liên tiếp (2 bước)
  console.log('\n4. Kiểm tra khi có 2 dialog "Allow all cookies" liên tiếp (2 bước):');
  {
    const step1Sel = '[data-cookiebanner="accept_button"]';
    const step2Sel = 'button:has-text("Allow all cookies")';

    const { page, getClickHistory, getLoadHistory } = createMockTabCPage({
      visibleSelectors: [
        [step1Sel], // Bước 1: dialog tổng thể
        [step2Sel], // Bước 2: dialog xác nhận tiếp theo
        []          // Sau bước 2: hết modal
      ]
    });

    const logger = createMockLogger();
    const count = await handleMetaCookieConsent({
      page,
      stepName: 'test-2-steps',
      timeoutPerStepMs: 100,
      maxSteps: 2,
      logger: logger as any
    });

    assert.strictEqual(count, 2, 'Phải click đủ 2 bước.');
    assert.strictEqual(getClickHistory().length, 2);
    assert.strictEqual(getClickHistory()[0], step1Sel, 'Lần 1 bấm dialog 1.');
    assert.strictEqual(getClickHistory()[1], step2Sel, 'Lần 2 bấm dialog 2.');
    assert.ok(getLoadHistory().length >= 2, 'Phải đợi trang tải xong sau MỖI lần bấm (ít nhất 2 lần wait).');

    const logMsgs = logger.logs.map((l) => l.msg);
    assert.ok(logMsgs.some((m) => m.includes('bước 1/2')));
    assert.ok(logMsgs.some((m) => m.includes('bước 2/2')));
    assert.ok(logMsgs.some((m) => m.includes('tổng cộng 2 bước bấm "Allow all cookies"')));
    console.log('  ✔ Bấm "Allow all cookies" đủ 2 bước liên tiếp, sau mỗi lần bấm đều đợi trang load xong.');
  }

  // Test 5: Không bấm quá maxSteps (chỉ tối đa 2 bước)
  console.log('\n5. Kiểm tra giới hạn maxSteps = 2 (không lặp vô tận):');
  {
    const sel = 'button:has-text("Allow all cookies")';
    const { page, getClickHistory } = createMockTabCPage({
      visibleSelectors: [
        [sel],
        [sel],
        [sel],
        [sel]
      ]
    });

    const count = await handleMetaCookieConsent({
      page,
      stepName: 'test-max-steps',
      timeoutPerStepMs: 50,
      maxSteps: 2
    });

    assert.strictEqual(count, 2, 'Tuyệt đối không vượt quá maxSteps = 2.');
    assert.strictEqual(getClickHistory().length, 2);
    console.log('  ✔ Dừng chính xác ở tối đa 2 bước theo yêu cầu.');
  }

  // Test 6: Kiểm tra ngắt an toàn khi nhận CancellationToken
  console.log('\n6. Kiểm tra ngắt an toàn khi nhận tín hiệu hủy:');
  {
    const sel = 'button:has-text("Allow all cookies")';
    const { page } = createMockTabCPage({
      visibleSelectors: [[sel]]
    });

    const token = { isCancelled: true };
    let threw = false;
    try {
      await handleMetaCookieConsent({
        page,
        stepName: 'test-cancel',
        cancellationToken: token
      });
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes('HỦY BỎ'));
    }

    assert.strictEqual(threw, true);
    console.log('  ✔ Dừng ngay lập tức khi nhận tín hiệu hủy bỏ.');
  }

  console.log('\n=== TẤT CẢ CÁC BÀI KIỂM THỬ COOKIE BANNER TAB C ĐÃ VƯỢT QUA 100%! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ BÀI KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
