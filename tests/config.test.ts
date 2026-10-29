import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import {
  validateConfig,
  loadConfig,
  formatSafeConfig,
  getProjectRoot,
  isForbiddenChromeUserDataDir
} from '../src/config';

console.log('--- BẮT ĐẦU KIỂM TRA MODULE CẤU HÌNH (PROFILE THEO TÊN) ---\n');

const projectRoot = getProjectRoot();

// ==========================================
// Test 1: Cấu hình profile theo tên hợp lệ
// ==========================================
console.log('1. Kiểm tra cấu hình profile theo tên hợp lệ:');
{
  const validRaw = {
    startUrl: 'https://example.com',
    browser: {
      profileName: 'ToolMain',
      profiles: {
        ToolMain: {
          userDataDir: 'profiles/UserData',
          profileDirectory: 'Default'
        },
        ToolSecondary: {
          userDataDir: 'profiles/SecondaryData',
          profileDirectory: 'Profile 1'
        }
      }
    },
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 15000,
    flowName: 'yopmail-muse',
    proxy: {
      enabled: false,
      server: 'http://ignored-proxy:8080'
    }
  };

  const result = validateConfig(validRaw, projectRoot);
  assert.strictEqual(result.valid, true, 'Cấu hình hợp lệ phải trả về valid = true');
  assert.ok(result.config, 'Phải có object config');
  assert.strictEqual(result.config.startUrl, 'https://example.com/');
  assert.ok(result.config.browser, 'Phải có browser config');
  assert.strictEqual(result.config.browser.profileName, 'ToolMain');
  assert.strictEqual(result.config.selectedProfile.profileName, 'ToolMain');
  assert.strictEqual(
    result.config.selectedProfile.userDataDir,
    path.resolve(projectRoot, 'profiles/UserData'),
    'userDataDir tương đối phải được chuẩn hóa theo thư mục gốc dự án'
  );
  assert.strictEqual(result.config.selectedProfile.profileDirectory, 'Default');
  assert.strictEqual(
    result.config.selectedProfile.fullPath,
    path.join(path.resolve(projectRoot, 'profiles/UserData'), 'Default')
  );
  assert.strictEqual(
    result.config.profileDir,
    result.config.selectedProfile.fullPath,
    'profileDir phải tương đương với fullPath để đảm bảo tương thích ngược'
  );
  assert.strictEqual(result.config.navigationTimeoutMs, 30000);
  assert.strictEqual(result.config.actionTimeoutMs, 15000);
  assert.strictEqual(result.config.flowName, 'yopmail-muse');
  assert.strictEqual(result.config.proxy.enabled, false);

  console.log('  ✔ Kiểm tra cấu hình profile theo tên hợp lệ thành công.');
}

// ==========================================
// Test 2: Chọn profile khác trong danh sách (ToolSecondary)
// ==========================================
console.log('\n2. Kiểm tra chọn profile thứ hai (ToolSecondary):');
{
  const validSecondary = {
    startUrl: 'https://example.com',
    browser: {
      profileName: 'ToolSecondary',
      profiles: {
        ToolMain: {
          userDataDir: 'profiles/UserData',
          profileDirectory: 'Default'
        },
        ToolSecondary: {
          userDataDir: 'D:\\ChromeTool\\SecondaryData',
          profileDirectory: 'Profile 1'
        }
      }
    }
  };

  const result = validateConfig(validSecondary, projectRoot);
  assert.strictEqual(result.valid, true);
  assert.ok(result.config);
  assert.strictEqual(result.config.selectedProfile.profileName, 'ToolSecondary');
  assert.strictEqual(result.config.selectedProfile.profileDirectory, 'Profile 1');
  assert.strictEqual(
    result.config.selectedProfile.userDataDir,
    path.normalize('D:\\ChromeTool\\SecondaryData')
  );

  console.log('  ✔ Chọn profile thứ hai (ToolSecondary) với đường dẫn tuyệt đối thành công.');
}

// ==========================================
// Test 3: Proxy bật và bảo mật dữ liệu an toàn (formatSafeConfig)
// ==========================================
console.log('\n3. Kiểm tra proxy bật và định dạng log an toàn:');
{
  const validWithProxy = {
    startUrl: 'http://localhost:3000',
    browser: {
      profileName: 'ToolMain',
      profiles: {
        ToolMain: {
          userDataDir: 'profiles/UserData',
          profileDirectory: 'Default'
        }
      }
    },
    proxy: {
      enabled: true,
      server: 'http://proxy.corp.com:8080',
      bypass: '<local>;*.corp.com'
    }
  };

  const mockEnv: NodeJS.ProcessEnv = {
    PROXY_USERNAME: 'proxy_test_user',
    PROXY_PASSWORD: 'super_secret_password_123'
  };

  const result = validateConfig(validWithProxy, projectRoot, mockEnv);
  assert.strictEqual(result.valid, true);
  assert.ok(result.config);
  assert.strictEqual(result.config.proxy.enabled, true);
  assert.strictEqual(result.config.proxy.username, 'proxy_test_user');
  assert.strictEqual(result.config.proxy.password, 'super_secret_password_123');

  const safeOutput = formatSafeConfig(result.config);
  assert.strictEqual(
    JSON.stringify(safeOutput).includes('super_secret_password_123'),
    false,
    'formatSafeConfig không được chứa mật khẩu thật'
  );
  assert.strictEqual(
    JSON.stringify(safeOutput).includes('proxy_test_user'),
    false,
    'formatSafeConfig phải che giấu username nhạy cảm'
  );

  console.log('  ✔ Kiểm tra proxy bật và bảo mật mật khẩu thành công.');
}

// ==========================================
// Test 4: Thiếu file cấu hình
// ==========================================
console.log('\n4. Kiểm tra khi thiếu file cấu hình:');
{
  const nonExistentPath = path.join(projectRoot, 'config', 'file-khong-ton-tai-12345.json');

  let errorOccurred = false;
  try {
    loadConfig(nonExistentPath, { exitOnError: false });
  } catch (err: unknown) {
    errorOccurred = true;
    const msg = (err as Error).message;
    assert.ok(msg.includes('Không tìm thấy file cấu hình'));
    assert.ok(msg.includes('Copy-Item config/config.example.json config/config.json'));
  }

  assert.strictEqual(errorOccurred, true);
  console.log('  ✔ Phát hiện thiếu file và hiển thị hướng dẫn khắc phục thành công.');
}

// ==========================================
// Test 5: profileName không tồn tại trong profiles
// ==========================================
console.log('\n5. Kiểm tra profileName không tồn tại:');
{
  const missingProfile = {
    startUrl: 'https://example.com',
    browser: {
      profileName: 'UnknownProfile',
      profiles: {
        ToolMain: {
          userDataDir: 'profiles/UserData',
          profileDirectory: 'Default'
        },
        ToolSecondary: {
          userDataDir: 'profiles/SecondaryData',
          profileDirectory: 'Default'
        }
      }
    }
  };

  const res = validateConfig(missingProfile, projectRoot);
  assert.strictEqual(res.valid, false, 'Phải từ chối khi profileName không tồn tại');
  assert.ok(
    res.errors.some((e) => e.includes('UnknownProfile')),
    'Phải nêu rõ tên profileName bị thiếu'
  );
  assert.ok(
    res.errors.some((e) => e.includes('ToolMain') && e.includes('ToolSecondary')),
    'Phải liệt kê danh sách các profile khả dụng'
  );
  assert.ok(
    res.errors.some((e) => e.includes('tuyệt đối không tự ý chuyển sang profile khác')),
    'Phải cam kết không tự động fallback sang profile khác'
  );
  console.log('  ✔ Từ chối profileName không tồn tại và liệt kê danh sách khả dụng thành công.');
}

// ==========================================
// Test 6: profileDirectory chứa ký tự phân cách hoặc đường dẫn vượt thư mục (..)
// ==========================================
console.log('\n6. Kiểm tra profileDirectory không hợp lệ (.., slash, backslash, đường dẫn tuyệt đối):');
{
  const invalidProfileDirectories = [
    '..',
    '../other',
    'sub/dir',
    'sub\\dir',
    'C:\\AbsPath',
    '/root/path',
    '.'
  ];

  for (const badPDir of invalidProfileDirectories) {
    const raw = {
      startUrl: 'https://example.com',
      browser: {
        profileName: 'TestBadDir',
        profiles: {
          TestBadDir: {
            userDataDir: 'profiles/UserData',
            profileDirectory: badPDir
          }
        }
      }
    };

    const res = validateConfig(raw, projectRoot);
    assert.strictEqual(res.valid, false, `Phải từ chối profileDirectory: "${badPDir}"`);
    assert.ok(
      res.errors.some((e) => e.includes('profileDirectory') && e.includes('thư mục con trực tiếp')),
      `Lỗi phải nêu rõ profileDirectory phải là thư mục con trực tiếp cho "${badPDir}"`
    );
  }
  console.log('  ✔ Từ chối profileDirectory chứa "..", slash, backslash hoặc đường dẫn tuyệt đối.');
}

// ==========================================
// Test 7: Cấm trỏ vào Chrome User Data cá nhân mặc định (%LOCALAPPDATA%\Google\Chrome\User Data)
// ==========================================
console.log('\n7. Kiểm tra nghiêm cấm dùng Chrome User Data cá nhân mặc định:');
{
  const mockLocalAppData = 'C:\\Users\\TestUser\\AppData\\Local';
  const mockEnv: NodeJS.ProcessEnv = {
    LOCALAPPDATA: mockLocalAppData
  };

  const forbiddenPaths = [
    'C:\\Users\\TestUser\\AppData\\Local\\Google\\Chrome\\User Data',
    'c:\\users\\testuser\\appdata\\local\\google\\chrome\\user data',
    'C:\\Users\\TestUser\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
    'C:\\Users\\TestUser\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 1',
    '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
    'C:/Users/TestUser/AppData/Local/Google/Chrome/User Data'
  ];

  for (const forbiddenPath of forbiddenPaths) {
    const raw = {
      startUrl: 'https://example.com',
      browser: {
        profileName: 'DangerousProfile',
        profiles: {
          DangerousProfile: {
            userDataDir: forbiddenPath,
            profileDirectory: 'Default'
          }
        }
      }
    };

    const res = validateConfig(raw, projectRoot, mockEnv, { enforceUserDataDirIsolation: true });
    assert.strictEqual(res.valid, false, `Phải từ chối đường dẫn cá nhân: ${forbiddenPath}`);
    assert.ok(
      res.errors.some((e) => e.includes('[BẢO MẬT PROFILE]') && e.includes('Chrome cá nhân mặc định')),
      `Phải cảnh báo bảo mật cho: ${forbiddenPath}`
    );
  }

  // Kiểm tra trực tiếp hàm isForbiddenChromeUserDataDir
  assert.strictEqual(
    isForbiddenChromeUserDataDir('C:\\Users\\TestUser\\AppData\\Local\\Google\\Chrome\\User Data', mockEnv),
    true
  );
  assert.strictEqual(
    isForbiddenChromeUserDataDir('D:\\ChromeTool\\UserData', mockEnv),
    false
  );
  assert.strictEqual(
    isForbiddenChromeUserDataDir('profiles/UserData', mockEnv),
    false
  );

  console.log('  ✔ Ngăn chặn tuyệt đối việc sử dụng Chrome User Data cá nhân mặc định thành công.');
}

// ==========================================
// Test 8: Phát hiện mâu thuẫn giữa profileDir cũ và browser mới
// ==========================================
console.log('\n8. Kiểm tra xung đột khi cả profileDir cũ và browser mới cùng tồn tại:');
{
  const conflictingRaw = {
    startUrl: 'https://example.com',
    profileDir: 'profiles/old_default',
    browser: {
      profileName: 'ToolMain',
      profiles: {
        ToolMain: {
          userDataDir: 'profiles/UserData',
          profileDirectory: 'Default'
        }
      }
    }
  };

  const res = validateConfig(conflictingRaw, projectRoot);
  assert.strictEqual(res.valid, false, 'Phải từ chối cấu hình xung đột');
  assert.ok(
    res.errors.some((e) => e.includes('[XUNG ĐỘT CẤU HÌNH]')),
    'Phải báo lỗi [XUNG ĐỘT CẤU HÌNH]'
  );
  assert.ok(
    res.errors.some((e) => e.toLowerCase().includes('không tự ý chọn ngầm một giá trị')),
    'Phải thông báo không tự ý chọn ngầm một giá trị'
  );
  console.log('  ✔ Báo lỗi cấu hình mâu thuẫn và hướng dẫn chuyển sang cấu hình mới thành công.');
}

// ==========================================
// Test 9: Tương thích ngược với profileDir cũ khi không có browser
// ==========================================
console.log('\n9. Kiểm tra tương thích ngược với cấu hình profileDir cũ:');
{
  const legacyRaw = {
    startUrl: 'https://example.com',
    profileDir: 'profiles/legacy_dir',
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 15000,
    flowName: 'demo'
  };

  const res = validateConfig(legacyRaw, projectRoot);
  assert.strictEqual(res.valid, true, 'Cấu hình cũ hợp lệ vẫn được hỗ trợ tương thích ngược');
  assert.ok(res.config);
  assert.strictEqual(
    res.config.profileDir,
    path.resolve(projectRoot, 'profiles/legacy_dir')
  );
  assert.strictEqual(res.config.selectedProfile.profileName, 'legacy');
  console.log('  ✔ Hỗ trợ tương thích ngược với cấu hình profileDir cũ thành công.');
}

// ==========================================
// Test 10: Kiểm tra các lỗi cơ bản khác (URL, Timeout, Proxy)
// ==========================================
console.log('\n10. Kiểm tra các lỗi cơ bản (URL, Timeout, Proxy server):');
{
  // 10.1: URL sai giao thức
  const badUrl = validateConfig({ startUrl: 'ftp://example.com', profileDir: 'profiles/t' }, projectRoot);
  assert.strictEqual(badUrl.valid, false);
  assert.ok(badUrl.errors.some((e) => e.includes('giao thức http hoặc https')));

  // 10.2: Timeout âm hoặc không phải số
  const badTimeout = validateConfig(
    {
      startUrl: 'https://example.com',
      profileDir: 'profiles/t',
      navigationTimeoutMs: -1
    },
    projectRoot
  );
  assert.strictEqual(badTimeout.valid, false);
  assert.ok(badTimeout.errors.some((e) => e.includes('phải là số nguyên dương')));

  // 10.3: Proxy bật nhưng server rỗng
  const badProxy = validateConfig(
    {
      startUrl: 'https://example.com',
      profileDir: 'profiles/t',
      proxy: { enabled: true, server: '' }
    },
    projectRoot
  );
  assert.strictEqual(badProxy.valid, false);
  assert.ok(badProxy.errors.some((e) => e.includes('proxy.server')));

  console.log('  ✔ Kiểm tra các lỗi URL, Timeout, Proxy thành công.');
}

// ==========================================
// Test 11: Kiểm tra cấu hình phoneMode và phoneNumbersFile
// ==========================================
console.log('\n11. Kiểm tra cấu hình phoneMode và phoneNumbersFile:');
{
  // 11.1: Mặc định phoneMode là "mock"
  const defaultMode = validateConfig(
    { startUrl: 'https://example.com', profileDir: 'profiles/t' },
    projectRoot
  );
  assert.strictEqual(defaultMode.valid, true);
  assert.strictEqual(defaultMode.config?.phoneMode, 'mock', 'Mặc định phoneMode phải là "mock"');

  // 11.2: Cấu hình phoneMode là "live"
  const liveMode = validateConfig(
    { startUrl: 'https://example.com', profileDir: 'profiles/t', phoneMode: 'live' },
    projectRoot
  );
  assert.strictEqual(liveMode.valid, true);
  assert.strictEqual(liveMode.config?.phoneMode, 'live');

  // 11.3: Cấu hình phoneMode không hợp lệ
  const invalidMode = validateConfig(
    { startUrl: 'https://example.com', profileDir: 'profiles/t', phoneMode: 'sandbox' },
    projectRoot
  );
  assert.strictEqual(invalidMode.valid, false);
  assert.ok(invalidMode.errors.some((e) => e.includes('"phoneMode" không hợp lệ')));

  // 11.4: Chuẩn hóa đường dẫn phoneNumbersFile
  const withFile = validateConfig(
    {
      startUrl: 'https://example.com',
      profileDir: 'profiles/t',
      phoneNumbersFile: 'data/phones.txt'
    },
    projectRoot
  );
  assert.strictEqual(withFile.valid, true);
  assert.strictEqual(
    withFile.config?.phoneNumbersFile,
    path.resolve(projectRoot, 'data/phones.txt')
  );

  // 11.5: formatSafeConfig có chứa phoneMode và phoneNumbersFile
  if (withFile.config) {
    const safe = formatSafeConfig(withFile.config);
    assert.strictEqual(safe.phoneMode, 'mock');
    assert.strictEqual(safe.phoneNumbersFile, path.resolve(projectRoot, 'data/phones.txt'));
  }

  console.log('  ✔ Kiểm tra phoneMode, phoneNumbersFile và formatSafeConfig thành công.');
}

// ==========================================
// Test 12: Kiểm tra cấu hình incognito
// ==========================================
console.log('\n12. Kiểm tra cấu hình incognito:');
{
  // 12.1: Mặc định incognito là false
  const defaultIncognito = validateConfig(
    { startUrl: 'https://example.com', profileDir: 'profiles/t' },
    projectRoot
  );
  assert.strictEqual(defaultIncognito.valid, true);
  assert.strictEqual(defaultIncognito.config?.incognito, false, 'Mặc định incognito phải là false');

  // 12.2: Bật incognito: true
  const incognitoOn = validateConfig(
    { startUrl: 'https://example.com', profileDir: 'profiles/t', incognito: true },
    projectRoot
  );
  assert.strictEqual(incognitoOn.valid, true);
  assert.strictEqual(incognitoOn.config?.incognito, true);

  // 12.3: Bật incognito: true không cần cấu hình profile
  const incognitoNoProfile = validateConfig(
    { startUrl: 'https://example.com', incognito: true },
    projectRoot
  );
  assert.strictEqual(incognitoNoProfile.valid, true);
  assert.strictEqual(incognitoNoProfile.config?.incognito, true);
  assert.strictEqual(incognitoNoProfile.config?.selectedProfile.profileName, 'Incognito');

  // 12.4: incognito không phải boolean
  const invalidIncognito = validateConfig(
    { startUrl: 'https://example.com', profileDir: 'profiles/t', incognito: 'yes' },
    projectRoot
  );
  assert.strictEqual(invalidIncognito.valid, false);
  assert.ok(invalidIncognito.errors.some((e) => e.includes('"incognito" phải là giá trị boolean')));

  // 12.5: formatSafeConfig có incognito
  if (incognitoOn.config) {
    const safe = formatSafeConfig(incognitoOn.config);
    assert.strictEqual(safe.incognito, true);
  }

  console.log('  ✔ Kiểm tra cấu hình incognito và formatSafeConfig thành công.');
}

console.log('\n--- TẤT CẢ CÁC BÀI KIỂM TRA CẤU HÌNH ĐÃ VƯỢT QUA THÀNH CÔNG! ---');
