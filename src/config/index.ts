import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  AppConfig,
  RawConfig,
  ValidationResult,
  ProfileDefinition,
  BrowserProfilesConfig,
  SelectedProfile
} from './types';

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
 * Lấy thư mục dữ liệu mặc định của Google Chrome trên Windows.
 */
export function getDefaultChromeUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData =
    env.LOCALAPPDATA ||
    (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '');
  return localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : '';
}

/**
 * Kiểm tra xem một đường dẫn có trỏ vào thư mục dữ liệu cá nhân Chrome mặc định hay không.
 */
export function isForbiddenChromeUserDataDir(
  targetPath: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!targetPath || typeof targetPath !== 'string') {
    return false;
  }

  const normalizedSlash = targetPath.replace(/\\/g, '/').toLowerCase();
  if (
    normalizedSlash.includes('google/chrome/user data') ||
    normalizedSlash.includes('google/chrome/user_data')
  ) {
    return true;
  }

  const defaultChrome = getDefaultChromeUserDataDir(env);
  if (defaultChrome) {
    const personalChromeDir = path.normalize(defaultChrome).toLowerCase();
    const expanded = targetPath
      .replace(/%LOCALAPPDATA%/gi, env.LOCALAPPDATA || '')
      .replace(/%USERPROFILE%/gi, env.USERPROFILE || '');
    const normalizedTarget = path.normalize(path.resolve(expanded)).toLowerCase();

    if (normalizedTarget === personalChromeDir || normalizedTarget.startsWith(personalChromeDir + path.sep)) {
      return true;
    }
  }

  return false;
}

/**
 * Kiểm tra và chuẩn hóa cấu hình từ dữ liệu thô.
 */
export function validateConfig(
  raw: unknown,
  projectRoot: string = getProjectRoot(),
  env: NodeJS.ProcessEnv = process.env,
  options: { enforceUserDataDirIsolation?: boolean } = { enforceUserDataDirIsolation: false }
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

  // 2. Kiểm tra xung đột cấu hình profile (profileDir cũ vs browser mới)
  const incognito = rawConfig.incognito === true;
  if (rawConfig.incognito !== undefined && rawConfig.incognito !== null && typeof rawConfig.incognito !== 'boolean') {
    errors.push(`"incognito" phải là giá trị boolean (true hoặc false). Nhận được: ${typeof rawConfig.incognito}`);
  }

  const hasLegacyProfileDir =
    typeof rawConfig.profileDir === 'string' && rawConfig.profileDir.trim().length > 0;
  const hasNewBrowserConfig =
    rawConfig.browser !== undefined &&
    rawConfig.browser !== null &&
    typeof rawConfig.browser === 'object';

  if (hasLegacyProfileDir && hasNewBrowserConfig) {
    errors.push(
      '[XUNG ĐỘT CẤU HÌNH] Phát hiện đồng thời cả "profileDir" (cấu hình cũ) và "browser" (cấu hình mới theo tên profile).\n' +
      '  -> Hệ thống không tự ý chọn ngầm một giá trị để đảm bảo tính nhất quán.\n' +
      '  -> Hướng dẫn: Vui lòng xóa trường "profileDir" và chỉ sử dụng trường "browser" với danh sách "profiles" rõ ràng.'
    );
  }

  // 3. Xử lý và kiểm tra cấu hình Profile
  let selectedProfile: SelectedProfile | undefined;
  let browserConfig: BrowserProfilesConfig | undefined;
  let profileDir = '';

  if (hasNewBrowserConfig) {
    const rawBrowser = rawConfig.browser!;
    const rawProfiles = rawBrowser.profiles;

    const cdpPort =
      typeof rawBrowser.cdpPort === 'number' &&
      Number.isInteger(rawBrowser.cdpPort) &&
      rawBrowser.cdpPort > 0
        ? rawBrowser.cdpPort
        : 9222;

    const defaultBaseUserDataDir =
      typeof rawBrowser.userDataDir === 'string' && rawBrowser.userDataDir.trim()
        ? rawBrowser.userDataDir.trim()
        : getDefaultChromeUserDataDir(env);

    if (!rawProfiles || typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) {
      errors.push('Trường "browser.profiles" là bắt buộc và phải là một object định nghĩa danh sách các profile.');
    } else {
      const parsedProfiles: Record<string, ProfileDefinition> = {};
      const profileKeys = Object.keys(rawProfiles);

      if (profileKeys.length === 0) {
        errors.push('Trường "browser.profiles" phải chứa ít nhất một cấu hình profile.');
      }

      for (const pName of profileKeys) {
        const rawDef = rawProfiles[pName];
        if (!rawDef || typeof rawDef !== 'object' || Array.isArray(rawDef)) {
          errors.push(`Profile "${pName}" phải là một object chứa "profileDirectory" (và tùy chọn "userDataDir").`);
          continue;
        }

        // Kiểm tra userDataDir (nếu không có thì mặc định dùng defaultBaseUserDataDir)
        let normalizedUserDataDir = '';
        const userDefinedDir =
          typeof rawDef.userDataDir === 'string' && rawDef.userDataDir.trim()
            ? rawDef.userDataDir.trim()
            : defaultBaseUserDataDir;

        if (!userDefinedDir) {
          errors.push(`"userDataDir" của profile "${pName}" không xác định được đường dẫn hợp lệ.`);
        } else {
          // Mở rộng biến môi trường nếu có
          const expanded = userDefinedDir
            .replace(/%LOCALAPPDATA%/gi, env.LOCALAPPDATA || '')
            .replace(/%USERPROFILE%/gi, env.USERPROFILE || '');

          normalizedUserDataDir = path.isAbsolute(expanded)
            ? path.normalize(expanded)
            : path.resolve(projectRoot, expanded);

          if (options.enforceUserDataDirIsolation && isForbiddenChromeUserDataDir(normalizedUserDataDir, env)) {
            errors.push(
              `[BẢO MẬT PROFILE] Profile "${pName}" có "userDataDir" trỏ vào thư mục dữ liệu Chrome cá nhân mặc định:\n` +
              `  -> ${normalizedUserDataDir}\n` +
              `Vui lòng cấu hình "userDataDir" trỏ đến thư mục riêng biệt dành cho tool.`
            );
          }
        }

        // Kiểm tra profileDirectory (phải là tên thư mục con trực tiếp)
        let normalizedProfileDirName = '';
        if (typeof rawDef.profileDirectory !== 'string' || !rawDef.profileDirectory.trim()) {
          errors.push(`"profileDirectory" của profile "${pName}" là bắt buộc và không được để trống.`);
        } else {
          const trimmedPDir = rawDef.profileDirectory.trim();
          if (
            trimmedPDir.includes('/') ||
            trimmedPDir.includes('\\') ||
            trimmedPDir.includes('..') ||
            trimmedPDir === '.' ||
            path.isAbsolute(trimmedPDir)
          ) {
            errors.push(
              `"profileDirectory" của profile "${pName}" ("${trimmedPDir}") không hợp lệ: phải là tên một thư mục con trực tiếp (ví dụ: "Default", "Profile 1", "Profile 2"), không được chứa ký tự phân cách ("/" hoặc "\\"), không được chứa ".." và không được là đường dẫn tuyệt đối.`
            );
          } else {
            normalizedProfileDirName = trimmedPDir;
          }
        }

        if (normalizedUserDataDir && normalizedProfileDirName) {
          parsedProfiles[pName] = {
            userDataDir: normalizedUserDataDir,
            profileDirectory: normalizedProfileDirName
          };
        }
      }

      // Kiểm tra profileName
      if (typeof rawBrowser.profileName !== 'string' || !rawBrowser.profileName.trim()) {
        errors.push('Trường "browser.profileName" là bắt buộc để chọn profile cần sử dụng.');
      } else {
        const selectedName = rawBrowser.profileName.trim();
        const availableNames = Object.keys(parsedProfiles);

        if (!parsedProfiles[selectedName]) {
          errors.push(
            `[LỖI CẤU HÌNH] profileName "${selectedName}" không tồn tại trong danh sách "profiles".\n` +
            `  -> Các profile khả dụng: [${availableNames.join(', ')}].\n` +
            `  -> Hệ thống tuyệt đối không tự ý chuyển sang profile khác.`
          );
        } else {
          browserConfig = {
            profileName: selectedName,
            cdpPort,
            userDataDir: defaultBaseUserDataDir,
            profiles: parsedProfiles
          };
          const selectedDef = parsedProfiles[selectedName];
          selectedProfile = {
            profileName: selectedName,
            userDataDir: selectedDef.userDataDir!,
            profileDirectory: selectedDef.profileDirectory,
            fullPath: path.join(selectedDef.userDataDir!, selectedDef.profileDirectory),
            cdpPort
          };
          profileDir = selectedProfile.fullPath;
        }
      }
    }
  } else if (hasLegacyProfileDir) {
    const trimmedPath = (rawConfig.profileDir as string).trim();
    const resolvedPath = path.isAbsolute(trimmedPath)
      ? path.normalize(trimmedPath)
      : path.resolve(projectRoot, trimmedPath);

    profileDir = resolvedPath;
    selectedProfile = {
      profileName: 'legacy',
      userDataDir: path.dirname(resolvedPath),
      profileDirectory: path.basename(resolvedPath),
      fullPath: resolvedPath,
      cdpPort: 9222
    };
  } else if (incognito) {
    selectedProfile = {
      profileName: 'Incognito',
      userDataDir: '',
      profileDirectory: 'Incognito',
      fullPath: '',
      cdpPort: 9222
    };
    profileDir = '';
  } else {
    errors.push(
      'Cấu hình thiếu thông tin profile: Vui lòng định nghĩa khối "browser" với "profileName" và "profiles".'
    );
  }

  // 4. Kiểm tra navigationTimeoutMs (số nguyên dương)
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

  // 5. Kiểm tra actionTimeoutMs (số nguyên dương)
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

  // 6. Kiểm tra flowName
  const flowName =
    typeof rawConfig.flowName === 'string' && rawConfig.flowName.trim()
      ? rawConfig.flowName.trim()
      : 'demo';

  // 7. Kiểm tra screenshotOnError (mặc định là true)
  const screenshotOnError = rawConfig.screenshotOnError !== false;

  // 8. Kiểm tra initialConnectionMode và proxyCheckUrl
  let initialConnectionMode: 'direct' | 'proxy';
  if (rawConfig.initialConnectionMode !== undefined && rawConfig.initialConnectionMode !== null) {
    if (rawConfig.initialConnectionMode !== 'direct' && rawConfig.initialConnectionMode !== 'proxy') {
      errors.push(
        `"initialConnectionMode" không hợp lệ: "${rawConfig.initialConnectionMode}". Giá trị hợp lệ là "direct" hoặc "proxy".`
      );
      initialConnectionMode = 'direct';
    } else {
      initialConnectionMode = rawConfig.initialConnectionMode;
    }
  } else {
    // Mặc định: nếu cấu hình proxy.enabled = true thì khởi đầu bằng proxy, ngược lại là direct
    initialConnectionMode = rawConfig.proxy?.enabled === true ? 'proxy' : 'direct';
  }

  let proxyCheckUrl: string | undefined;
  if (rawConfig.proxyCheckUrl !== undefined && rawConfig.proxyCheckUrl !== null) {
    if (typeof rawConfig.proxyCheckUrl !== 'string' || !rawConfig.proxyCheckUrl.trim()) {
      errors.push('"proxyCheckUrl" không được để trống nếu được chỉ định.');
    } else {
      try {
        const parsedCheckUrl = new URL(rawConfig.proxyCheckUrl.trim());
        if (parsedCheckUrl.protocol !== 'http:' && parsedCheckUrl.protocol !== 'https:') {
          errors.push(
            `"proxyCheckUrl" phải sử dụng giao thức http hoặc https (hiện tại: "${parsedCheckUrl.protocol}").`
          );
        } else {
          proxyCheckUrl = parsedCheckUrl.href;
        }
      } catch {
        errors.push(`"proxyCheckUrl" không đúng định dạng URL: "${rawConfig.proxyCheckUrl}".`);
      }
    }
  }

  // 9. Kiểm tra Proxy
  const rawProxy = rawConfig.proxy;
  const isProxyExplicitlyEnabled = rawProxy?.enabled === true;
  const isInitialProxy = initialConnectionMode === 'proxy';
  let proxyConfig: AppConfig['proxy'];

  const proxyServer =
    typeof rawProxy?.server === 'string' && rawProxy.server.trim()
      ? rawProxy.server.trim()
      : undefined;
  const proxyBypass =
    typeof rawProxy?.bypass === 'string' && rawProxy.bypass.trim()
      ? rawProxy.bypass.trim()
      : undefined;
  const proxyUsername = env.PROXY_USERNAME?.trim() || undefined;
  const proxyPassword = env.PROXY_PASSWORD || undefined;

  if (isProxyExplicitlyEnabled || isInitialProxy) {
    if (!proxyServer) {
      errors.push('Khi proxy được bật (proxy.enabled = true), "proxy.server" không được để trống.');
      proxyConfig = {
        enabled: true,
        server: '',
        bypass: proxyBypass,
        username: proxyUsername,
        password: proxyPassword
      };
    } else {
      proxyConfig = {
        enabled: true,
        server: proxyServer,
        bypass: proxyBypass,
        username: proxyUsername,
        password: proxyPassword
      };
    }
  } else {
    // Chế độ direct: giữ nguyên cấu hình server/bypass nếu người dùng đã nhập, không xóa cấu hình
    proxyConfig = {
      enabled: false,
      server: proxyServer,
      bypass: proxyBypass,
      username: proxyUsername,
      password: proxyPassword
    };
  }

  // 10. Kiểm tra phoneMode và phoneNumbersFile
  let phoneMode: 'mock' | 'live' = 'mock';
  if (rawConfig.phoneMode !== undefined && rawConfig.phoneMode !== null) {
    if (rawConfig.phoneMode !== 'mock' && rawConfig.phoneMode !== 'live') {
      errors.push(
        `"phoneMode" không hợp lệ: "${rawConfig.phoneMode}". Giá trị hợp lệ là "mock" hoặc "live" (mặc định là "mock").`
      );
    } else {
      phoneMode = rawConfig.phoneMode;
    }
  }

  let phoneNumbersFile: string | undefined;
  if (rawConfig.phoneNumbersFile !== undefined && rawConfig.phoneNumbersFile !== null) {
    if (typeof rawConfig.phoneNumbersFile !== 'string' || !rawConfig.phoneNumbersFile.trim()) {
      errors.push('"phoneNumbersFile" phải là một chuỗi đường dẫn file hợp lệ.');
    } else {
      const trimmedFile = rawConfig.phoneNumbersFile.trim();
      phoneNumbersFile = path.isAbsolute(trimmedFile)
        ? path.normalize(trimmedFile)
        : path.resolve(projectRoot, trimmedFile);
    }
  }

  if (errors.length > 0 || !selectedProfile) {
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
      browser: browserConfig,
      selectedProfile,
      navigationTimeoutMs: navigationTimeoutMs as number,
      actionTimeoutMs: actionTimeoutMs as number,
      flowName,
      screenshotOnError,
      initialConnectionMode,
      proxyCheckUrl,
      proxy: proxyConfig,
      phoneNumbersFile,
      phoneMode,
      incognito
    }
  };
}

/**
 * Đọc file config.json và trả về AppConfig đã được kiểm tra tính hợp lệ.
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

  if (!fs.existsSync(configPath)) {
    const errorMessage =
      `[LỖI CẤU HÌNH] Không tìm thấy file cấu hình tại:\n  -> ${configPath}\n\n` +
      `Hướng dẫn khắc phục (PowerShell):\n` +
      `  1. Tạo file cấu hình từ mẫu có sẵn:\n` +
      `     Copy-Item config/config.example.json config/config.json\n` +
      `  2. Chỉnh sửa thông số trong config/config.json theo nhu cầu.`;

    if (shouldExit) {
      console.error(errorMessage);
      process.exit(1);
    }
    throw new Error(errorMessage);
  }

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
 * Trả về bản sao thông tin cấu hình an toàn để hiển thị/ghi log.
 */
export function formatSafeConfig(config: AppConfig): Record<string, unknown> {
  return {
    startUrl: config.startUrl,
    profileDir: config.profileDir,
    browser: config.browser
      ? {
          profileName: config.browser.profileName,
          cdpPort: config.selectedProfile.cdpPort,
          selectedProfile: {
            userDataDir: config.selectedProfile.userDataDir,
            profileDirectory: config.selectedProfile.profileDirectory,
            fullPath: config.selectedProfile.fullPath
          },
          availableProfiles: Object.keys(config.browser.profiles)
        }
      : undefined,
    navigationTimeoutMs: config.navigationTimeoutMs,
    actionTimeoutMs: config.actionTimeoutMs,
    flowName: config.flowName,
    screenshotOnError: config.screenshotOnError,
    initialConnectionMode: config.initialConnectionMode,
    proxyCheckUrl: config.proxyCheckUrl,
    proxy: config.proxy.enabled
      ? {
          enabled: true,
          server: config.proxy.server,
          bypass: config.proxy.bypass,
          hasCredentials: Boolean(config.proxy.username || config.proxy.password),
          username: config.proxy.username ? '***' : undefined
        }
      : {
          enabled: false,
          server: config.proxy.server,
          bypass: config.proxy.bypass,
          hasCredentials: Boolean(config.proxy.username || config.proxy.password),
          username: config.proxy.username ? '***' : undefined
        },
    phoneMode: config.phoneMode,
    phoneNumbersFile: config.phoneNumbersFile,
    incognito: Boolean(config.incognito)
  };
}

export * from './types';
