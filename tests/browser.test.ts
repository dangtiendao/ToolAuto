import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import {
  buildPlaywrightProxy,
  handleLaunchError,
  launchBrowser,
  closeBrowser,
  confirmProfileCreation,
  isCdpAvailable,
  BrowserManager
} from '../src/browser';
import { AppConfig } from '../src/config/types';

async function runTests(): Promise<void> {
  console.log('--- BẮT ĐẦU KIỂM TRA MODULE BROWSER & PROFILE (CDP & PERSISTENT) ---\n');

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

  const dummyUserDataDir = path.resolve(__dirname, '../profiles/dummy_user_data');
  const dummyConfig: AppConfig = {
    startUrl: 'https://example.com',
    profileDir: path.join(dummyUserDataDir, 'Default'),
    selectedProfile: {
      profileName: 'ToolMain',
      userDataDir: dummyUserDataDir,
      profileDirectory: 'Default',
      fullPath: path.join(dummyUserDataDir, 'Default'),
      cdpPort: 9222
    },
    navigationTimeoutMs: 10000,
    actionTimeoutMs: 5000,
    flowName: 'demo',
    screenshotOnError: true,
    proxy: { enabled: false }
  };

  // 2.1: Profile đang được sử dụng bởi tiến trình khác
  {
    const rawLockError = new Error(
      'browserType.launchPersistentContext: Opening in existing browser session. This usually means that the profile is already in use'
    );
    const friendlyErr = handleLaunchError(rawLockError, dummyConfig);
    assert.ok(friendlyErr.message.includes('[LỖI PROFILE]'), 'Phải gắn cờ lỗi profile');
    assert.ok(
      friendlyErr.message.includes(dummyUserDataDir),
      'Phải hiển thị rõ thư mục gốc userDataDir đang bị khóa'
    );
    assert.ok(
      friendlyErr.message.includes('ToolMain'),
      'Phải hiển thị tên định danh profileName'
    );
    assert.ok(
      friendlyErr.message.includes('tuyệt đối không tự động kill các tiến trình Chrome khác'),
      'Phải cam kết không tự kill tiến trình'
    );
    console.log('  ✔ Xử lý thông báo lỗi profile bị chiếm dụng chính xác với đầy đủ thông tin an toàn.');
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
  // Test 3: Xử lý Profile chưa tồn tại (Yêu cầu xác nhận, không âm thầm tạo mới)
  // ==========================================
  console.log('\n3. Kiểm tra xử lý profile chưa tồn tại:');
  {
    const uncreatedUserDataDir = path.resolve(__dirname, '../profiles/test_uncreated_data');
    const uncreatedFullPath = path.join(uncreatedUserDataDir, 'NewProfile');

    if (fs.existsSync(uncreatedUserDataDir)) {
      fs.rmSync(uncreatedUserDataDir, { recursive: true, force: true });
    }

    const uncreatedProfileConfig: AppConfig = {
      startUrl: 'https://example.com',
      profileDir: uncreatedFullPath,
      selectedProfile: {
        profileName: 'UncreatedProfile',
        userDataDir: uncreatedUserDataDir,
        profileDirectory: 'NewProfile',
        fullPath: uncreatedFullPath,
        cdpPort: 58888
      },
      navigationTimeoutMs: 5000,
      actionTimeoutMs: 5000,
      flowName: 'demo',
      screenshotOnError: false,
      proxy: { enabled: false }
    };

    let launchFailed = false;
    try {
      await launchBrowser(uncreatedProfileConfig, { autoConfirmNewProfile: false, fallbackToPersistentContext: true });
    } catch (err: unknown) {
      launchFailed = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI PROFILE CHƯA TỒN TẠI]'), 'Phải báo lỗi profile chưa tồn tại');
      assert.ok(msg.includes('UncreatedProfile'), 'Phải nêu rõ tên profile');
    }

    assert.strictEqual(launchFailed, true, 'Khởi chạy khi chưa xác nhận phải thất bại');
    assert.strictEqual(
      fs.existsSync(uncreatedFullPath),
      false,
      'Thư mục profile tuyệt đối không được tự ý tạo khi chưa xác nhận'
    );
    console.log('  ✔ Dừng an toàn và không âm thầm tạo profile mới khi chưa có xác nhận.');

    const rejectedConfirm = await confirmProfileCreation('TestProfile', uncreatedFullPath, {
      confirmNewProfileHandler: async () => false
    });
    assert.strictEqual(rejectedConfirm, false);

    const approvedConfirm = await confirmProfileCreation('TestProfile', uncreatedFullPath, {
      confirmNewProfileHandler: async () => true
    });
    assert.strictEqual(approvedConfirm, true);
    console.log('  ✔ Cơ chế confirmProfileCreation hoạt động chính xác.');
  }

  // ==========================================
  // Test 4: Thử nghiệm không tự động chuyển kết nối trực tiếp khi Proxy lỗi
  // ==========================================
  console.log('\n4. Kiểm tra không tự fallback khi proxy chết:');
  {
    const unreachableUserDataDir = path.resolve(__dirname, '../profiles/test_unreachable_data');
    const unreachableFullPath = path.join(unreachableUserDataDir, 'Default');

    if (!fs.existsSync(unreachableFullPath)) {
      fs.mkdirSync(unreachableFullPath, { recursive: true });
    }

    const unreachableProxyConfig: AppConfig = {
      startUrl: 'https://example.com',
      profileDir: unreachableFullPath,
      selectedProfile: {
        profileName: 'UnreachableProxyProfile',
        userDataDir: unreachableUserDataDir,
        profileDirectory: 'Default',
        fullPath: unreachableFullPath,
        cdpPort: 58889
      },
      navigationTimeoutMs: 5000,
      actionTimeoutMs: 5000,
      flowName: 'test',
      screenshotOnError: false,
      proxy: {
        enabled: true,
        server: 'http://127.0.0.1:59999' // Cổng không có service nào lắng nghe
      }
    };

    let launchFailed = false;
    try {
      const session = await launchBrowser(unreachableProxyConfig, { fallbackToPersistentContext: true });
      await closeBrowser(session.context);
    } catch (err: unknown) {
      launchFailed = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('LỖI KẾT NỐI PROXY'), 'Phải báo lỗi proxy rõ ràng');
      assert.ok(msg.includes('KHÔNG tự động chuyển sang kết nối trực tiếp'), 'Phải xác nhận không fallback');
    }

    assert.strictEqual(launchFailed, true, 'Khởi chạy qua proxy chết phải thất bại, không được âm thầm kết nối trực tiếp');
    console.log('  ✔ Đảm bảo trình duyệt từ chối kết nối trực tiếp khi proxy lỗi.');

    if (fs.existsSync(unreachableUserDataDir)) {
      try {
        fs.rmSync(unreachableUserDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {}
    }
  }

  // ==========================================
  // Test 5: Tái sử dụng profile và bảo toàn dữ liệu (Persistence Verification)
  // ==========================================
  console.log('\n5. Kiểm tra mở lại cùng profile và bảo toàn dữ liệu:');
  {
    const persistenceUserDataDir = path.resolve(__dirname, '../profiles/test_persistence_data');
    const persistenceProfileDirName = 'Default';
    const persistenceFullPath = path.join(persistenceUserDataDir, persistenceProfileDirName);

    if (fs.existsSync(persistenceUserDataDir)) {
      try {
        fs.rmSync(persistenceUserDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {}
    }

    const persistenceConfig: AppConfig = {
      startUrl: 'https://example.com',
      profileDir: persistenceFullPath,
      selectedProfile: {
        profileName: 'PersistenceTestProfile',
        userDataDir: persistenceUserDataDir,
        profileDirectory: persistenceProfileDirName,
        fullPath: persistenceFullPath,
        cdpPort: 58890
      },
      navigationTimeoutMs: 15000,
      actionTimeoutMs: 10000,
      flowName: 'demo',
      screenshotOnError: false,
      proxy: { enabled: false }
    };

    console.log('  -> Khởi chạy Phiên 1 để ghi dữ liệu lưu trữ...');
    const session1 = await launchBrowser(persistenceConfig, {
      autoConfirmNewProfile: true,
      fallbackToPersistentContext: true
    });
    assert.strictEqual(fs.existsSync(persistenceFullPath), true, 'Thư mục profile phải được tạo');

    await session1.page.evaluate(() => {
      localStorage.setItem('persistence_test_key', 'tool_auto_value_98765');
    });

    await closeBrowser(session1);
    console.log('  -> Đã đóng Phiên 1 an toàn.');

    console.log('  -> Khởi chạy Phiên 2 trên cùng profile để kiểm tra dữ liệu được giữ lại...');
    const session2 = await launchBrowser(persistenceConfig, {
      fallbackToPersistentContext: true
    });

    const retrievedValue = await session2.page.evaluate(() => {
      return localStorage.getItem('persistence_test_key');
    });

    assert.strictEqual(
      retrievedValue,
      'tool_auto_value_98765',
      'Dữ liệu localStorage phải được bảo toàn nguyên vẹn giữa các phiên khi dùng cùng profile'
    );

    await closeBrowser(session2);
    console.log('  -> Đã đóng Phiên 2 an toàn.');

    if (fs.existsSync(persistenceUserDataDir)) {
      try {
        fs.rmSync(persistenceUserDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {}
    }

    console.log('  ✔ Tái sử dụng profile và bảo toàn dữ liệu thử nghiệm thành công 100%.');
  }

  // ==========================================
  // Test 6: Kiểm tra hàm isCdpAvailable
  // ==========================================
  console.log('\n6. Kiểm tra hàm isCdpAvailable:');
  {
    const notAvailable = await isCdpAvailable(59998);
    assert.strictEqual(notAvailable, false, 'Cổng không mở phải trả về false');
    console.log('  ✔ isCdpAvailable kiểm tra chính xác trạng thái cổng.');
  }

  // ==========================================
  // Test 7: Kiểm tra BrowserManager với chế độ Incognito
  // ==========================================
  console.log('\n7. Kiểm tra BrowserManager với chế độ Incognito:');
  {
    const incognitoConfig: AppConfig = {
      startUrl: 'https://example.com',
      profileDir: '',
      selectedProfile: {
        profileName: 'Incognito',
        userDataDir: '',
        profileDirectory: 'Incognito',
        fullPath: '',
        cdpPort: 9222
      },
      navigationTimeoutMs: 15000,
      actionTimeoutMs: 10000,
      flowName: 'test-incognito',
      screenshotOnError: false,
      initialConnectionMode: 'direct',
      proxy: { enabled: false },
      phoneMode: 'mock',
      incognito: true
    };

    const manager = new BrowserManager(incognitoConfig);
    assert.strictEqual(manager.getConnectionMode(), 'direct');
    const session = await manager.initSession();
    assert.strictEqual(session.isIncognito, true, 'Phiên khởi chạy phải có cờ isIncognito = true');
    assert.ok(session.browser, 'Phiên incognito phải có browser instance');
    assert.ok(session.page, 'Phiên incognito phải có page instance');
    const initialPage = session.page;
    assert.strictEqual(initialPage.isClosed(), false);

    const page2 = await manager.newPage('tab_incognito_2');
    assert.strictEqual(page2.isClosed(), false);
    assert.notStrictEqual(page2, initialPage, 'Tab mới phải khác với tab ban đầu');

    await manager.close();
    assert.strictEqual(initialPage.isClosed(), true, 'Initial page phải được đóng sau khi manager.close()');
    assert.strictEqual(page2.isClosed(), true, 'Tab mới phải được đóng sau khi manager.close()');
    console.log('  ✔ Khởi chạy phiên Incognito, mở tab mới và đóng an toàn thành công.');
  }

  console.log('\n--- TẤT CẢ BÀI KIỂM TRA BROWSER ĐÃ VƯỢT QUA! ---');
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Lỗi khi chạy kiểm tra browser:', err);
    process.exit(1);
  });
