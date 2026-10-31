import * as assert from 'assert';
import { Page, Response } from 'playwright';
import {
  safeGoto,
  safeReload,
  DEFAULT_PAGE_LOAD_MAX_RETRIES,
  DEFAULT_PAGE_LOAD_RETRY_DELAY_MS,
  delayWithCancellation
} from '../src/browser/navigation';

console.log('--- BẮT ĐẦU KIỂM TRA TÍNH NĂNG RETRY TẢI TRANG DO PROXY KHÔNG ỔN ĐỊNH ---');

// Mock helper tạo Page giả lập
function createMockPage(options?: {
  url?: string;
  isClosed?: boolean;
  gotoHandler?: (url: string, opts?: any) => Promise<any>;
  reloadHandler?: (opts?: any) => Promise<any>;
}): Page {
  const curUrl = options?.url ?? 'https://example.com/test';
  let closed = options?.isClosed ?? false;

  return {
    url: () => curUrl,
    isClosed: () => closed,
    bringToFront: async () => {},
    goto: options?.gotoHandler || (async () => ({ ok: () => true, status: () => 200 } as unknown as Response)),
    reload: options?.reloadHandler || (async () => ({ ok: () => true, status: () => 200 } as unknown as Response)),
    context: () => ({
      request: {
        get: async () => ({ ok: () => true, json: async () => ({ origin: '103.166.184.218' }) })
      }
    }),
    locator: () => ({
      count: async () => 0,
      first: () => ({ isVisible: async () => false })
    })
  } as unknown as Page;
}

// Mock logger để thu thập log
function createMockLogger() {
  const logs: { level: string; msg: string; meta?: any }[] = [];
  return {
    logs,
    info: (msg: string, meta?: any) => logs.push({ level: 'info', msg, meta }),
    warn: (msg: string, meta?: any) => logs.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta?: any) => logs.push({ level: 'error', msg, meta })
  };
}

async function runTests() {
  // Test 1: Kiểm tra hằng số mặc định
  console.log('\n1. Kiểm tra hằng số mặc định retry:');
  assert.strictEqual(DEFAULT_PAGE_LOAD_MAX_RETRIES, 3, 'Số lần retry tối đa phải là 3.');
  assert.strictEqual(DEFAULT_PAGE_LOAD_RETRY_DELAY_MS, 3000, 'Thời gian chờ giữa các lần retry phải là 3000ms (3 giây).');
  console.log('  ✔ Hằng số mặc định chính xác: 3 lần retry, mỗi lần 3 giây (3000ms).');

  // Test 2: safeGoto thành công ngay lần đầu tiên
  console.log('\n2. Kiểm tra safeGoto khi tải trang thành công ngay lần đầu:');
  {
    let callCount = 0;
    const logger = createMockLogger();
    const mockPage = createMockPage({
      gotoHandler: async () => {
        callCount++;
        return { ok: () => true, status: () => 200 } as unknown as Response;
      }
    });

    const res = await safeGoto(mockPage, 'https://example.com/first-try', {
      maxRetries: 3,
      retryDelayMs: 10, // giảm thời gian test để chạy nhanh
      logger
    });

    assert.strictEqual(callCount, 1, 'Chỉ được gọi goto 1 lần khi không có lỗi.');
    assert.ok(res, 'Response phải tồn tại.');
    assert.strictEqual(logger.logs.filter((l) => l.msg.includes('RETRY')).length, 0, 'Không được có log retry.');
    console.log('  ✔ Tải trang thành công ngay lần đầu, không retry không cần thiết.');
  }

  // Test 3: safeGoto tự động retry khi lỗi lần 1, 2 và thành công ở lần 3
  console.log('\n3. Kiểm tra safeGoto tự động retry 2 lần khi proxy chập chờn rồi thành công ở lần 3:');
  {
    let callCount = 0;
    const logger = createMockLogger();
    const mockPage = createMockPage({
      gotoHandler: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
        }
        if (callCount === 2) {
          throw new Error('net::ERR_TIMED_OUT');
        }
        return { ok: () => true, status: () => 200 } as unknown as Response;
      }
    });

    const startTime = Date.now();
    const res = await safeGoto(mockPage, 'https://example.com/retry-success', {
      maxRetries: 3,
      retryDelayMs: 50, // dùng 50ms cho test kiểm tra độ trễ
      logger
    });

    const duration = Date.now() - startTime;
    assert.strictEqual(callCount, 3, 'Phải gọi goto 3 lần (1 lần gốc + 2 lần retry).');
    assert.ok(duration >= 90, `Thời gian chạy phải trải qua ít nhất 2 khoảng chờ retry (thực tế: ${duration}ms).`);
    assert.ok(res, 'Response phải thành công ở lần thứ 3.');

    // Kiểm tra log
    const warnLogs = logger.logs.filter((l) => l.level === 'warn');
    assert.strictEqual(warnLogs.length, 2, 'Phải có 2 cảnh báo lỗi tương ứng với 2 lần thất bại.');
    assert.ok(warnLogs[0].msg.includes('thử lại lần 1/3 sau'), 'Log cảnh báo lần 1 phải đúng cú pháp.');
    assert.ok(warnLogs[1].msg.includes('thử lại lần 2/3 sau'), 'Log cảnh báo lần 2 phải đúng cú pháp.');

    const successLog = logger.logs.find((l) => l.msg.includes('RETRY THÀNH CÔNG'));
    assert.ok(successLog, 'Phải có log ghi nhận retry thành công.');
    console.log('  ✔ Tự động retry 2 lần và thành công ở lần 3, log cảnh báo và thông tin đầy đủ.');
  }

  // Test 4: safeGoto thất bại sau đúng 3 lần retry (tổng cộng 4 lần thử)
  console.log('\n4. Kiểm tra safeGoto thất bại sau tối đa 3 lần retry (tổng cộng 4 lần gọi):');
  {
    let callCount = 0;
    const logger = createMockLogger();
    const mockPage = createMockPage({
      gotoHandler: async () => {
        callCount++;
        throw new Error('net::ERR_TUNNEL_CONNECTION_FAILED');
      }
    });

    let threw = false;
    try {
      await safeGoto(mockPage, 'https://example.com/always-fail', {
        maxRetries: 3,
        retryDelayMs: 10,
        logger
      });
    } catch (err) {
      threw = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('thất bại sau khi đã thử lại tối đa 3 lần'), 'Thông báo lỗi phải nêu rõ 3 lần thử lại.');
      assert.ok(msg.includes('ERR_TUNNEL_CONNECTION_FAILED'), 'Thông báo lỗi phải chứa chi tiết lỗi gốc.');
    }

    assert.strictEqual(threw, true, 'safeGoto phải ném lỗi khi vượt quá 3 lần retry.');
    assert.strictEqual(callCount, 4, 'Phải thử đúng 4 lần (1 lần đầu + 3 lần retry).');

    const warnLogs = logger.logs.filter((l) => l.level === 'warn');
    assert.strictEqual(warnLogs.length, 3, 'Phải có đúng 3 lần cảnh báo tương ứng với 3 lần retry.');
    console.log('  ✔ Dừng an toàn và ném lỗi rõ ràng sau đúng 3 lần retry khi proxy lỗi liên tiếp.');
  }

  // Test 5: safeReload tự động retry tối đa 3 lần khi reload Tab B
  console.log('\n5. Kiểm tra safeReload retry khi reload TabB bị lỗi proxy:');
  {
    let reloadCount = 0;
    const logger = createMockLogger();
    const mockPage = createMockPage({
      url: 'https://muse.ai/dashboard',
      reloadHandler: async () => {
        reloadCount++;
        if (reloadCount === 1) {
          throw new Error('net::ERR_CONNECTION_RESET');
        }
        return { ok: () => true, status: () => 200 } as unknown as Response;
      }
    });

    const res = await safeReload(mockPage, {
      maxRetries: 3,
      retryDelayMs: 20,
      logger
    });

    assert.strictEqual(reloadCount, 2, 'Phải reload 2 lần.');
    assert.ok(res, 'Phải reload thành công ở lần 2.');
    const warnLog = logger.logs.find((l) => l.level === 'warn');
    assert.ok(warnLog && warnLog.msg.includes('Tải lại trang'), 'Phải có log cảnh báo tải lại trang lỗi.');
    console.log('  ✔ safeReload retry chính xác khi tải lại Tab B gặp sự cố kết nối.');
  }

  // Test 6: Kiểm tra dừng ngay khi tab bị đóng (page.isClosed())
  console.log('\n6. Kiểm tra không retry vô ích khi tab đã bị đóng:');
  {
    let callCount = 0;
    const mockPage = createMockPage({
      isClosed: true,
      gotoHandler: async () => {
        callCount++;
        return {} as any;
      }
    });

    let threw = false;
    try {
      await safeGoto(mockPage, 'https://example.com/closed', { maxRetries: 3 });
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes('LỖI TAB ĐÃ ĐÓNG'), 'Phải báo lỗi tab đã bị đóng.');
    }

    assert.strictEqual(threw, true);
    assert.strictEqual(callCount, 0, 'Tuyệt đối không gọi goto trên tab đã bị đóng.');
    console.log('  ✔ Ngăn chặn gọi goto và không retry khi tab đã bị đóng.');
  }

  // Test 7: Kiểm tra dừng ngay khi nhận tín hiệu hủy (CancellationToken) trong lúc chờ delay
  console.log('\n7. Kiểm tra hủy an toàn ngay lập tức khi nhận CancellationToken trong lúc chờ 3 giây:');
  {
    const cancellationToken = { isCancelled: false };

    // Kích hoạt tín hiệu hủy sau 30ms trong khoảng chờ 1000ms
    setTimeout(() => {
      cancellationToken.isCancelled = true;
    }, 30);

    const startTime = Date.now();
    let threw = false;
    try {
      await delayWithCancellation(1000, cancellationToken);
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes('HỦY BỎ'), 'Phải ném lỗi hủy bỏ.');
    }

    const duration = Date.now() - startTime;
    assert.strictEqual(threw, true);
    assert.ok(duration < 500, `Phải ngắt ngay lập tức thay vì chờ hết 1000ms (thực tế: ${duration}ms).`);
    console.log(`  ✔ Ngắt ngay lập tức sau ${duration}ms khi nhận tín hiệu hủy trong lúc chờ retry.`);
  }

  // Test 8: Kiểm tra bảo mật URL nhạy cảm trong log retry
  console.log('\n8. Kiểm tra lọc URL nhạy cảm (token, mật khẩu) khi log retry:');
  {
    const logger = createMockLogger();
    const sensitiveUrl = 'https://example.com/verify?token=SECRET_123456&otp=999888&pass=secretPass';

    const mockPage = createMockPage({
      gotoHandler: async () => {
        throw new Error('Connection failed');
      }
    });

    try {
      await safeGoto(mockPage, sensitiveUrl, {
        maxRetries: 1,
        retryDelayMs: 5,
        logger
      });
    } catch {
      // bỏ qua lỗi mong đợi
    }

    for (const log of logger.logs) {
      assert.ok(!log.msg.includes('SECRET_123456'), 'Log không được chứa token nhạy cảm.');
      assert.ok(!log.msg.includes('999888'), 'Log không được chứa OTP nhạy cảm.');
      assert.ok(!log.msg.includes('secretPass'), 'Log không được chứa password.');
    }
    console.log('  ✔ Toàn bộ query string và thông tin nhạy cảm đã được lọc an toàn khỏi log retry.');
  }

  console.log('\n=== TẤT CẢ CÁC BÀI KIỂM THỬ RETRY TẢI TRANG ĐÃ VƯỢT QUA 100%! ===\n');
}

runTests().catch((err) => {
  console.error('\n❌ BÀI KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
