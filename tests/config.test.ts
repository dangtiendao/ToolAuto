import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { validateConfig, loadConfig, formatSafeConfig, getProjectRoot } from '../src/config';

console.log('--- BẮT ĐẦU KIỂM TRA MODULE CẤU HÌNH ---\n');

const projectRoot = getProjectRoot();

// ==========================================
// Test 1: Cấu hình hợp lệ
// ==========================================
console.log('1. Kiểm tra cấu hình hợp lệ:');
{
  const validRaw = {
    startUrl: 'https://example.com',
    profileDir: 'profiles/default',
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 15000,
    flowName: 'demo',
    proxy: {
      enabled: false,
      server: 'http://ignored-proxy:8080'
    }
  };

  const result = validateConfig(validRaw, projectRoot);
  assert.strictEqual(result.valid, true, 'Cấu hình hợp lệ phải trả về valid = true');
  assert.ok(result.config, 'Phải có object config');
  assert.strictEqual(result.config.startUrl, 'https://example.com/');
  assert.strictEqual(
    result.config.profileDir,
    path.resolve(projectRoot, 'profiles/default'),
    'profileDir tương đối phải được chuẩn hóa thành đường dẫn tuyệt đối theo thư mục gốc'
  );
  assert.strictEqual(result.config.navigationTimeoutMs, 30000);
  assert.strictEqual(result.config.actionTimeoutMs, 15000);
  assert.strictEqual(result.config.flowName, 'demo');
  assert.strictEqual(result.config.proxy.enabled, false);
  assert.strictEqual(
    result.config.proxy.server,
    undefined,
    'Khi proxy tắt, các thiết lập proxy còn lại phải bị bỏ qua'
  );

  console.log('  ✔ Kiểm tra cấu hình mặc định/hợp lệ thành công.');
}

// Kiểm tra với proxy được bật và thông tin xác thực từ môi trường
{
  const validWithProxy = {
    startUrl: 'http://localhost:3000',
    profileDir: 'profiles/proxy-user',
    navigationTimeoutMs: 20000,
    actionTimeoutMs: 10000,
    flowName: 'custom-flow',
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
  assert.strictEqual(result.config.proxy.server, 'http://proxy.corp.com:8080');
  assert.strictEqual(result.config.proxy.bypass, '<local>;*.corp.com');
  assert.strictEqual(result.config.proxy.username, 'proxy_test_user');
  assert.strictEqual(result.config.proxy.password, 'super_secret_password_123');

  // Kiểm tra an toàn: formatSafeConfig không làm lộ mật khẩu
  const safeOutput = formatSafeConfig(result.config);
  assert.strictEqual(
    JSON.stringify(safeOutput).includes('super_secret_password_123'),
    false,
    'formatSafeConfig tuyệt đối không được chứa mật khẩu thật'
  );
  assert.strictEqual(
    JSON.stringify(safeOutput).includes('proxy_test_user'),
    false,
    'formatSafeConfig phải che giấu username nhạy cảm'
  );

  console.log('  ✔ Kiểm tra proxy bật và bảo mật mật khẩu thành công.');
}

// ==========================================
// Test 2: Thiếu file cấu hình
// ==========================================
console.log('\n2. Kiểm tra khi thiếu file cấu hình:');
{
  const nonExistentPath = path.join(projectRoot, 'config', 'file-khong-ton-tai-12345.json');

  let errorOccurred = false;
  try {
    loadConfig(nonExistentPath, { exitOnError: false });
  } catch (err: unknown) {
    errorOccurred = true;
    const msg = (err as Error).message;
    assert.ok(
      msg.includes('Không tìm thấy file cấu hình'),
      'Thông báo lỗi phải nêu rõ không tìm thấy file cấu hình'
    );
    assert.ok(
      msg.includes('Copy-Item config/config.example.json config/config.json'),
      'Thông báo phải có hướng dẫn sao chép file mẫu'
    );
  }

  assert.strictEqual(errorOccurred, true, 'Thiếu file phải throw lỗi khi exitOnError = false');
  console.log('  ✔ Phát hiện thiếu file và hiển thị hướng dẫn khắc phục thành công.');
}

// ==========================================
// Test 3: Cấu hình không hợp lệ
// ==========================================
console.log('\n3. Kiểm tra các trường hợp cấu hình không hợp lệ:');

// 3.1: URL sai giao thức (ftp, file, chuỗi rác)
{
  const invalidUrl = {
    startUrl: 'ftp://ftp.example.com',
    profileDir: 'profiles/test',
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 15000
  };
  const res = validateConfig(invalidUrl, projectRoot);
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('giao thức http hoặc https')));
  console.log('  ✔ Phát hiện lỗi URL sai giao thức (ftp).');
}

// 3.2: Timeout không phải số nguyên dương (âm, 0, thập phân, chuỗi)
{
  const invalidTimeouts = [
    { nav: -5000, act: 10000, desc: 'timeout âm' },
    { nav: 0, act: 10000, desc: 'timeout bằng 0' },
    { nav: 3000.5, act: 10000, desc: 'timeout là số thập phân' },
    { nav: '30000' as unknown as number, act: 10000, desc: 'timeout là chuỗi' }
  ];

  for (const item of invalidTimeouts) {
    const res = validateConfig(
      {
        startUrl: 'https://example.com',
        profileDir: 'profiles/test',
        navigationTimeoutMs: item.nav,
        actionTimeoutMs: item.act
      },
      projectRoot
    );
    assert.strictEqual(res.valid, false, `Phải từ chối khi ${item.desc}`);
    assert.ok(res.errors.some((e) => e.includes('phải là số nguyên dương')));
  }
  console.log('  ✔ Phát hiện các lỗi timeout không hợp lệ (âm, 0, số thập phân, chuỗi).');
}

// 3.3: profileDir rỗng
{
  const emptyProfile = {
    startUrl: 'https://example.com',
    profileDir: '   ',
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 15000
  };
  const res = validateConfig(emptyProfile, projectRoot);
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('profileDir')));
  console.log('  ✔ Phát hiện lỗi profileDir để trống.');
}

// 3.4: Proxy bật nhưng server để trống
{
  const proxyWithoutServer = {
    startUrl: 'https://example.com',
    profileDir: 'profiles/test',
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 15000,
    proxy: {
      enabled: true,
      server: '   '
    }
  };
  const res = validateConfig(proxyWithoutServer, projectRoot);
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('proxy.server')));
  console.log('  ✔ Phát hiện lỗi proxy được bật nhưng server để trống.');
}

console.log('\n--- TẤT CẢ CÁC BÀI KIỂM TRA ĐÃ VƯỢT QUA THÀNH CÔNG! ---');
