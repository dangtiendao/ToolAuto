import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { buildPlaywrightProxy, handleLaunchError, launchBrowser, closeBrowser } from '../src/browser';
import { AppConfig } from '../src/config/types';

async function runTests(): Promise<void> {
  console.log('--- BẮT ĐẦU KIỂM TRA MODULE BROWSER & PROXY ---\n');

  // ==========================================
  // Test 1: Thẩm định và tạo cấu hình Proxy cho Playwright
  // ==========================================
  console.log('1. Kiểm tra buildPlaywrightProxy:');

  // 1.1: Proxy HTTP hợp lệ có bypass và xác thực
  {
    const proxyCfg = {
      enabled: true,
      server: 'http://127.0.0.1:8080',
      bypass: 'localhost;*.local',
      username: 'my_user',
      password: 'my_password'
    };

    const pwProxy = buildPlaywrightProxy(proxyCfg);
    assert.strictEqual(pwProxy.server, 'http://127.0.0.1:8080');
    assert.strictEqual(pwProxy.bypass, 'localhost;*.local');
    assert.strictEqual(pwProxy.username, 'my_user');
    assert.strictEqual(pwProxy.password, 'my_password');
    console.log('  ✔ Proxy HTTP hợp lệ có credentials chuyển đổi chính xác.');
  }

  // 1.2: Proxy SOCKS5 hợp lệ
  {
    const proxyCfg = {
      enabled: true,
      server: 'socks5://10.0.0.1:1080'
    };

    const pwProxy = buildPlaywrightProxy(proxyCfg);
    assert.strictEqual(pwProxy.server, 'socks5://10.0.0.1:1080');
    console.log('  ✔ Proxy SOCKS5 hợp lệ chuyển đổi chính xác.');
  }

  // 1.3: Giao thức không được Playwright hỗ trợ (ví dụ socks4://)
  {
    const unsupportedCfg = {
      enabled: true,
      server: 'socks4://127.0.0.1:1080'
    };

    let threw = false;
    try {
      buildPlaywrightProxy(unsupportedCfg);
    } catch (err: unknown) {
      threw = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('socks4'), 'Thông báo phải chỉ rõ giao thức socks4 không được hỗ trợ');
      assert.ok(msg.includes('http://, https://, socks5://'), 'Thông báo phải nêu các giao thức được hỗ trợ');
    }
    assert.strictEqual(threw, true, 'Phải ném lỗi khi giao thức không được hỗ trợ');
    console.log('  ✔ Từ chối giao thức proxy không được hỗ trợ (socks4) thành công.');
  }

  // ==========================================
  // Test 2: Xử lý thông báo lỗi (handleLaunchError)
  // ==========================================
  console.log('\n2. Kiểm tra handleLaunchError:');

  const dummyConfig: AppConfig = {
    startUrl: 'https://example.com',
    profileDir: path.resolve(__dirname, '../profiles/dummy'),
    navigationTimeoutMs: 10000,
    actionTimeoutMs: 5000,
    flowName: 'demo',
    proxy: { enabled: false }
  };

  // 2.1: Profile đang được sử dụng bởi tiến trình khác
  {
    const rawLockError = new Error(
      'browserType.launchPersistentContext: Opening in existing browser session. This usually means that the profile is already in use'
    );
    const friendlyErr = handleLaunchError(rawLockError, dummyConfig);
    assert.ok(friendlyErr.message.includes('[LỖI PROFILE]'), 'Phải gắn cờ lỗi profile');
    assert.ok(friendlyErr.message.includes('không tự động kill'), 'Phải nhấn mạnh không tự kill tiến trình');
    console.log('  ✔ Xử lý thông báo lỗi profile bị chiếm dụng chính xác.');
  }

  // 2.2: Chrome chưa được cài đặt
  {
    const rawNoChromeError = new Error(
      'browserType.launchPersistentContext: Executable doesn\'t exist at channel "chrome"'
    );
    const friendlyErr = handleLaunchError(rawNoChromeError, dummyConfig);
    assert.ok(friendlyErr.message.includes('[LỖI TRÌNH DUYỆT]'), 'Phải gắn cờ lỗi trình duyệt');
    assert.ok(friendlyErr.message.includes('Google Chrome chính thức'), 'Phải nhắc người dùng cài Chrome');
    console.log('  ✔ Xử lý thông báo lỗi thiếu Google Chrome chính xác.');
  }

  // 2.3: Lỗi proxy và cam kết không đổi sang kết nối trực tiếp
  {
    const proxyConfig: AppConfig = {
      ...dummyConfig,
      proxy: { enabled: true, server: 'http://127.0.0.1:9999' }
    };
    const rawProxyError = new Error('net::ERR_PROXY_CONNECTION_FAILED');
    const friendlyErr = handleLaunchError(rawProxyError, proxyConfig);
    assert.ok(friendlyErr.message.includes('[LỖI KẾT NỐI PROXY]'), 'Phải gắn cờ lỗi proxy');
    assert.ok(friendlyErr.message.includes('KHÔNG tự động chuyển sang kết nối trực tiếp'), 'Phải cam kết không fallback');
    console.log('  ✔ Xử lý thông báo lỗi kết nối proxy và cam kết không fallback.');
  }

  // ==========================================
  // Test 3: Thử nghiệm không tự động chuyển kết nối trực tiếp khi Proxy lỗi
  // ==========================================
  console.log('\n3. Kiểm tra không tự fallback khi proxy chết:');
  {
    const testProfile = path.resolve(__dirname, '../profiles/test_unreachable_proxy');
    const unreachableProxyConfig: AppConfig = {
      startUrl: 'https://example.com',
      profileDir: testProfile,
      navigationTimeoutMs: 5000,
      actionTimeoutMs: 5000,
      flowName: 'test',
      proxy: {
        enabled: true,
        server: 'http://127.0.0.1:59999' // Cổng không có service nào lắng nghe
      }
    };

    let launchFailed = false;
    try {
      const session = await launchBrowser(unreachableProxyConfig);
      await closeBrowser(session.context);
    } catch (err: unknown) {
      launchFailed = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('LỖI KẾT NỐI PROXY'), 'Phải báo lỗi proxy rõ ràng');
      assert.ok(msg.includes('KHÔNG tự động chuyển sang kết nối trực tiếp'), 'Phải xác nhận không fallback');
    }

    assert.strictEqual(launchFailed, true, 'Khởi chạy qua proxy chết phải thất bại, không được âm thầm kết nối trực tiếp');
    console.log('  ✔ Đảm bảo trình duyệt từ chối kết nối trực tiếp khi proxy lỗi.');

    // Dọn dẹp thư mục test profile nếu có
    if (fs.existsSync(testProfile)) {
      fs.rmSync(testProfile, { recursive: true, force: true });
    }
  }

  console.log('\n--- TẤT CẢ BÀI KIỂM TRA BROWSER ĐÃ VƯỢT QUA! ---');
}

runTests().catch((err) => {
  console.error('Lỗi khi chạy kiểm tra browser:', err);
  process.exit(1);
});
