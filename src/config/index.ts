import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { AppConfig, RawConfig, ValidationResult } from './types';

// Tải biến môi trường từ .env nếu có
dotenv.config();

/**
 * Xác định thư mục gốc của dự án (nơi chứa package.json).
 */
export function getProjectRoot(): string {
  let currentDir = __dirname;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return process.cwd();
}

/**
 * Kiểm tra và chuẩn hóa cấu hình từ dữ liệu thô.
 */
export function validateConfig(
  raw: unknown,
  projectRoot: string = getProjectRoot(),
  env: NodeJS.ProcessEnv = process.env
): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ['Nội dung cấu hình phải là một JSON object hợp lệ.']
    };
  }

  const rawConfig = raw as RawConfig;

  // 1. Kiểm tra startUrl (bắt buộc, chỉ dùng giao thức http hoặc https)
  let startUrl = '';
  if (typeof rawConfig.startUrl !== 'string' || !rawConfig.startUrl.trim()) {
    errors.push('Trường "startUrl" là bắt buộc và không được để trống.');
  } else {
    try {
      const parsedUrl = new URL(rawConfig.startUrl.trim());
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        errors.push(
          `"startUrl" phải sử dụng giao thức http hoặc https (hiện tại: "${parsedUrl.protocol}").`
        );
      } else {
        startUrl = parsedUrl.href;
      }
    } catch {
      errors.push(`"startUrl" không đúng định dạng URL: "${rawConfig.startUrl}".`);
    }
  }

  // 2. Kiểm tra profileDir (bắt buộc, không rỗng, chuẩn hóa đường dẫn tương đối theo project root)
  let profileDir = '';
  if (typeof rawConfig.profileDir !== 'string' || !rawConfig.profileDir.trim()) {
    errors.push('Trường "profileDir" là bắt buộc và không được để trống.');
  } else {
    const trimmedPath = rawConfig.profileDir.trim();
    profileDir = path.isAbsolute(trimmedPath)
      ? path.normalize(trimmedPath)
      : path.resolve(projectRoot, trimmedPath);
  }

  // 3. Kiểm tra navigationTimeoutMs (số nguyên dương)
  const navigationTimeoutMs = rawConfig.navigationTimeoutMs ?? 30000;
  if (
    typeof navigationTimeoutMs !== 'number' ||
    !Number.isInteger(navigationTimeoutMs) ||
    navigationTimeoutMs <= 0
  ) {
    errors.push(
      `"navigationTimeoutMs" phải là số nguyên dương (> 0). Nhận được: ${navigationTimeoutMs}`
    );
  }

  // 4. Kiểm tra actionTimeoutMs (số nguyên dương)
  const actionTimeoutMs = rawConfig.actionTimeoutMs ?? 15000;
  if (
    typeof actionTimeoutMs !== 'number' ||
    !Number.isInteger(actionTimeoutMs) ||
    actionTimeoutMs <= 0
  ) {
    errors.push(
      `"actionTimeoutMs" phải là số nguyên dương (> 0). Nhận được: ${actionTimeoutMs}`
    );
  }

  // 5. Kiểm tra flowName
  const flowName = typeof rawConfig.flowName === 'string' && rawConfig.flowName.trim()
    ? rawConfig.flowName.trim()
    : 'demo';

  // 6. Kiểm tra screenshotOnError (mặc định là true)
  const screenshotOnError = rawConfig.screenshotOnError !== false;

  // 7. Kiểm tra Proxy
  const rawProxy = rawConfig.proxy;
  const isProxyEnabled = rawProxy?.enabled === true;
  let proxyConfig: AppConfig['proxy'];

  if (isProxyEnabled) {
    if (!rawProxy?.server || typeof rawProxy.server !== 'string' || !rawProxy.server.trim()) {
      errors.push('Khi proxy được bật (proxy.enabled = true), "proxy.server" không được để trống.');
      proxyConfig = { enabled: true };
    } else {
      proxyConfig = {
        enabled: true,
        server: rawProxy.server.trim(),
        bypass: typeof rawProxy.bypass === 'string' ? rawProxy.bypass.trim() : undefined,
        // Thông tin xác thực CHỈ đọc từ biến môi trường
        username: env.PROXY_USERNAME?.trim() || undefined,
        password: env.PROXY_PASSWORD || undefined
      };
    }
  } else {
    // Khi proxy tắt, bỏ qua toàn bộ thiết lập proxy còn lại
    proxyConfig = {
      enabled: false
    };
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors
    };
  }

  return {
    valid: true,
    errors: [],
    config: {
      startUrl,
      profileDir,
      navigationTimeoutMs: navigationTimeoutMs as number,
      actionTimeoutMs: actionTimeoutMs as number,
      flowName,
      screenshotOnError,
      proxy: proxyConfig
    }
  };
}

/**
 * Đọc file config.json và trả về AppConfig đã được kiểm tra tính hợp lệ.
 * Nếu có lỗi hoặc thiếu file, thông báo chi tiết và thoát với mã lỗi khác 0 (hoặc throw lỗi nếu exitOnError=false).
 */
export function loadConfig(
  customConfigPath?: string,
  options: { exitOnError?: boolean } = { exitOnError: true }
): AppConfig {
  const projectRoot = getProjectRoot();
  const configPath = customConfigPath
    ? path.isAbsolute(customConfigPath)
      ? customConfigPath
      : path.resolve(projectRoot, customConfigPath)
    : path.resolve(projectRoot, 'config', 'config.json');

  const shouldExit = options.exitOnError !== false;

  // 1. Kiểm tra sự tồn tại của file cấu hình
  if (!fs.existsSync(configPath)) {
    const errorMessage =
      `[LỖI CẤU HÌNH] Không tìm thấy file cấu hình tại:\n  -> ${configPath}\n\n` +
      `Hướng dẫn khắc phục (PowerShell):\n` +
      `  1. Tạo file cấu hình từ mẫu có sẵn:\n` +
      `     Copy-Item config/config.example.json config/config.json\n` +
      `  2. (Tùy chọn) Tạo file biến môi trường để cấu hình proxy:\n` +
      `     Copy-Item .env.example .env\n` +
      `  3. Chỉnh sửa thông số trong config/config.json theo nhu cầu.`;

    if (shouldExit) {
      console.error(errorMessage);
      process.exit(1);
    }
    throw new Error(errorMessage);
  }

  // 2. Đọc và phân tích cú pháp JSON
  let rawJson: unknown;
  try {
    const rawContent = fs.readFileSync(configPath, 'utf-8');
    rawJson = JSON.parse(rawContent);
  } catch (err) {
    const syntaxErrorMessage =
      `[LỖI CẤU HÌNH] File cấu hình không đúng định dạng JSON hợp lệ:\n  -> ${configPath}\n` +
      `Chi tiết: ${(err as Error).message}`;

    if (shouldExit) {
      console.error(syntaxErrorMessage);
      process.exit(1);
    }
    throw new Error(syntaxErrorMessage);
  }

  // 3. Kiểm tra tính hợp lệ của cấu hình
  const validation = validateConfig(rawJson, projectRoot, process.env);
  if (!validation.valid || !validation.config) {
    const validationErrorMessage =
      `[LỖI CẤU HÌNH] Phát hiện các lỗi trong file cấu hình (${configPath}):\n` +
      validation.errors.map((err) => `  - ${err}`).join('\n');

    if (shouldExit) {
      console.error(validationErrorMessage);
      process.exit(1);
    }
    throw new Error(validationErrorMessage);
  }

  return validation.config;
}

/**
 * Trả về bản sao thông tin cấu hình an toàn (loại bỏ hoặc ẩn mật khẩu/thông tin xác thực) để hiển thị/ghi log.
 */
export function formatSafeConfig(config: AppConfig): Record<string, unknown> {
  return {
    startUrl: config.startUrl,
    profileDir: config.profileDir,
    navigationTimeoutMs: config.navigationTimeoutMs,
    actionTimeoutMs: config.actionTimeoutMs,
    flowName: config.flowName,
    screenshotOnError: config.screenshotOnError,
    proxy: config.proxy.enabled
      ? {
          enabled: true,
          server: config.proxy.server,
          bypass: config.proxy.bypass,
          hasCredentials: Boolean(config.proxy.username || config.proxy.password),
          username: config.proxy.username ? '***' : undefined
        }
      : {
          enabled: false
        }
  };
}

export * from './types';
