import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { ProxyConfig } from '../config/types';
import { sanitizeUrl } from '../utils/sanitize';

export interface ScrapedProxyItem {
  alive: boolean;
  ip: string;
  port: number;
  protocol: string;
  proxy: string;
  timeout?: number;
  uptime?: number;
  ip_data?: {
    countryCode?: string;
    country?: string;
    city?: string;
  };
}

export interface ProxyScrapeResponse {
  shown_records?: number;
  total_records?: number;
  proxies?: ScrapedProxyItem[];
}

export interface FetchProxyOptions {
  country?: string;
  baseUrlTemplate?: string;
  cacheFilePath?: string;
  mockRawJson?: string;
  timeoutMs?: number;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export interface TestProxyOptions {
  timeoutMs?: number;
  testHost?: string;
  testPort?: number;
  protocol?: string;
}

export interface WorkingProxyResult {
  proxyConfig: ProxyConfig;
  testedCount: number;
  selectedProxyItem?: ScrapedProxyItem;
  source: 'api' | 'cache_file' | 'fallback_config';
}

export interface FindProxyOptions {
  maxTestCount?: number;
  testTimeoutMs?: number;
  fallbackProxy?: ProxyConfig;
  cacheFilePath?: string;
  mockRawJson?: string;
  baseUrlTemplate?: string;
  randomize?: boolean;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

/**
 * Đường dẫn mặc định tới file Downloads\data_proxy.txt (giữ tương thích ngược).
 * Lưu ý: Hiện tại hệ thống không còn lưu file này theo yêu cầu (hoạt động 100% in-memory).
 */
export function getDownloadsDataProxyPath(): string {
  const userHome = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(userHome, 'Downloads', 'data_proxy.txt');
}

/**
 * URL base mặc định của API ProxyScrape
 */
export const DEFAULT_PROXYSCRAPE_BASE_URL =
  // 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json&protocol=http,socks4,socks5%2Cus&timeout=800';
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json&protocol=http&country={country}%2Cus&timeout=800';

/**
 * Tạo URL gọi API từ template và mã nước
 */
export function buildProxyScrapeUrl(country: string, template: string = DEFAULT_PROXYSCRAPE_BASE_URL): string {
  const cleanCountry = country.trim().toLowerCase();
  return template.replace('{country}', encodeURIComponent(cleanCountry));
}

/**
 * Gửi HTTP GET request bằng module https của Node.js
 */
function fetchJsonViaHttps(url: string, timeoutMs: number = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ToolAutoChrome/1.0',
          Accept: 'application/json, text/plain, */*'
        }
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(rawData);
          } else {
            reject(new Error(`API ProxyScrape phản hồi HTTP ${res.statusCode}: ${rawData.slice(0, 150)}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Hết thời gian chờ phản hồi từ API ProxyScrape (${timeoutMs}ms)`));
    });
  });
}

/**
 * Kéo danh sách proxy mới từ API ProxyScrape hoàn toàn trong bộ nhớ (In-Memory).
 * Tuyệt đối không lưu trữ hay ghi file ra ổ đĩa (zero disk footprint).
 */
export async function fetchProxiesFromApi(
  country: string,
  options?: FetchProxyOptions
): Promise<ScrapedProxyItem[]> {
  const apiUrl = buildProxyScrapeUrl(country, options?.baseUrlTemplate);
  const logger = options?.logger;

  logger?.info?.(`[LẤY PROXY TỪ API] Đang kéo danh sách proxy mới (country=${country}) từ ProxyScrape...`);

  let jsonText = '';
  if (options?.mockRawJson) {
    jsonText = options.mockRawJson;
  } else {
    try {
      jsonText = await fetchJsonViaHttps(apiUrl, options?.timeoutMs || 8000);
      logger?.info?.(`[LẤY PROXY TỪ API] Đã tải thành công dữ liệu proxy từ API vào bộ nhớ (không lưu trữ file).`);
    } catch (apiErr) {
      throw new Error(`[LỖI KÉO PROXY TỪ API] Không thể tải dữ liệu từ API: ${(apiErr as Error).message}`);
    }
  }

  // Parse JSON trực tiếp trong RAM
  try {
    const data: ProxyScrapeResponse = JSON.parse(jsonText);
    if (!data.proxies || !Array.isArray(data.proxies)) {
      return [];
    }
    return data.proxies;
  } catch (parseErr) {
    throw new Error(`[LỖI PARSE PROXY] Dữ liệu proxy không đúng định dạng JSON: ${(parseErr as Error).message}`);
  }
}

/**
 * Kiểm tra proxy HTTP/HTTPS bằng phương thức HTTP CONNECT tới cổng 443 (HTTPS Tunneling).
 */
function testHttpProxy(
  proxyHost: string,
  proxyPort: number,
  options?: TestProxyOptions
): Promise<{ alive: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timeoutMs = options?.timeoutMs || 3500;
    const testHost = options?.testHost || 'httpbin.org';
    const testPort = options?.testPort || 443;

    let finished = false;
    const finish = (result: { alive: boolean; error?: string }) => {
      if (!finished) {
        finished = true;
        resolve(result);
      }
    };

    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${testHost}:${testPort}`,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'ToolAutoChrome/1.0'
      }
    });

    req.on('connect', (res, socket) => {
      socket.destroy();
      if (res.statusCode === 200) {
        finish({ alive: true });
      } else {
        finish({ alive: false, error: `Proxy trả về mã trạng thái HTTP CONNECT: ${res.statusCode}` });
      }
    });

    req.on('error', (err) => {
      finish({ alive: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ alive: false, error: `Hết thời gian chờ (${timeoutMs}ms)` });
    });

    req.end();
  });
}

/**
 * Kiểm tra proxy SOCKS5 bằng bắt tay (Handshake Greeting) qua socket TCP nhị phân:
 * Client gửi: VER=0x05, NMETHODS=1, METHOD=0x00 (No Authentication)
 * Server trả về: VER=0x05, METHOD=0x00 (Thành công, sẵn sàng)
 */
function testSocks5Proxy(
  proxyHost: string,
  proxyPort: number,
  options?: TestProxyOptions
): Promise<{ alive: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timeoutMs = options?.timeoutMs || 3500;
    const socket = new net.Socket();

    let finished = false;
    const finish = (result: { alive: boolean; error?: string }) => {
      if (!finished) {
        finished = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);

    socket.connect(proxyPort, proxyHost, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on('data', (data) => {
      if (data.length >= 2 && data[0] === 0x05 && data[1] === 0x00) {
        finish({ alive: true });
      } else {
        finish({ alive: false, error: `SOCKS5 phản hồi mã từ chối: ${data.toString('hex')}` });
      }
    });

    socket.on('error', (err) => {
      finish({ alive: false, error: err.message });
    });

    socket.on('timeout', () => {
      finish({ alive: false, error: `Hết thời gian chờ SOCKS5 (${timeoutMs}ms)` });
    });
  });
}

/**
 * Kiểm tra proxy SOCKS4 bằng gói tin kết nối (Connect Request) qua socket TCP nhị phân:
 * Client gửi: VN=0x04, CD=0x01 (CONNECT), PORT=80 (0x0050), IP=1.1.1.1 (0x01010101), USERID=0
 * Server trả về: 8 bytes, byte 1 là 0x5A (Request granted) hoặc byte 0 là 0
 */
function testSocks4Proxy(
  proxyHost: string,
  proxyPort: number,
  options?: TestProxyOptions
): Promise<{ alive: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timeoutMs = options?.timeoutMs || 3500;
    const socket = new net.Socket();

    let finished = false;
    const finish = (result: { alive: boolean; error?: string }) => {
      if (!finished) {
        finished = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);

    socket.connect(proxyPort, proxyHost, () => {
      socket.write(Buffer.from([0x04, 0x01, 0x00, 0x50, 0x01, 0x01, 0x01, 0x01, 0x00]));
    });

    socket.on('data', (data) => {
      if (data.length >= 2 && (data[1] === 0x5a || data[0] === 0x00)) {
        finish({ alive: true });
      } else {
        finish({ alive: false, error: `SOCKS4 phản hồi mã từ chối: ${data.toString('hex')}` });
      }
    });

    socket.on('error', (err) => {
      finish({ alive: false, error: err.message });
    });

    socket.on('timeout', () => {
      finish({ alive: false, error: `Hết thời gian chờ SOCKS4 (${timeoutMs}ms)` });
    });
  });
}

/**
 * Kiểm tra xem một proxy có kết nối được hay không theo đúng giao thức (HTTP, SOCKS5, SOCKS4).
 * - HTTP / HTTPS: Sử dụng HTTP CONNECT Tunneling tới cổng 443.
 * - SOCKS5: Sử dụng TCP Socket gửi SOCKS5 Handshake Greeting (VER=5, NO_AUTH).
 * - SOCKS4: Sử dụng TCP Socket gửi SOCKS4 Connect Request (VN=4, CONNECT).
 */
export async function testProxyConnection(
  proxyHost: string,
  proxyPort: number,
  options?: TestProxyOptions
): Promise<{ alive: boolean; error?: string; latencyMs?: number }> {
  const protocol = (options?.protocol || 'http').toLowerCase().replace('://', '').trim();
  const startTime = Date.now();

  let res: { alive: boolean; error?: string };
  try {
    if (protocol === 'socks5') {
      res = await testSocks5Proxy(proxyHost, proxyPort, options);
    } else if (protocol === 'socks4') {
      res = await testSocks4Proxy(proxyHost, proxyPort, options);
    } else {
      res = await testHttpProxy(proxyHost, proxyPort, options);
    }
  } catch (err) {
    res = { alive: false, error: (err as Error).message };
  }

  return { ...res, latencyMs: Date.now() - startTime };
}

/**
 * Hàm chung lấy proxy sống:
 * 1. Kéo mới proxy về từ API theo mã nước (country).
 * 2. Lọc và ưu tiên proxy đúng mã nước.
 * 3. Kiểm tra kết nối từng proxy:
 *    - MẶC ĐỊNH (randomize !== false): Bốc ngẫu nhiên số thứ tự trong tổng kết quả,
 *      không quét lần lượt từ trên xuống. Đảm bảo các luồng chạy song song hoặc các lần
 *      chạy lặp lại không bị chọn trùng proxy hay tranh chấp cùng một proxy.
 *    - TUẦN TỰ (randomize === false): Sắp xếp theo uptime cao nhất và duyệt lần lượt từ trên xuống.
 * 4. Nếu toàn bộ free proxy lỗi, fallback an toàn sang proxy cấu hình dự phòng (nếu có).
 */
export async function findWorkingProxy(
  country: string,
  options?: FindProxyOptions
): Promise<WorkingProxyResult> {
  const logger = options?.logger;
  const maxTestCount = options?.maxTestCount || 20;
  const testTimeoutMs = options?.testTimeoutMs || 3500;
  const normalizedCountry = country.trim().toUpperCase();
  const randomize = options?.randomize !== false;

  logger?.info?.(
    `[TÌM PROXY KHẢ DỤNG] Bắt đầu quy trình quét và tìm proxy hoạt động cho quốc gia [${normalizedCountry}]...`
  );

  let proxies: ScrapedProxyItem[] = [];
  let source: 'api' | 'cache_file' | 'fallback_config' = 'api';

  try {
    proxies = await fetchProxiesFromApi(country, {
      logger,
      baseUrlTemplate: options?.baseUrlTemplate,
      mockRawJson: options?.mockRawJson
    });
  } catch (fetchErr) {
    logger?.warn?.(`[CẢNH BÁO KÉO PROXY] ${(fetchErr as Error).message}`);
  }

  // Lọc proxy theo mã nước (ví dụ SG khi country=sg)
  const matchedCountryProxies = proxies.filter(
    (p) => p.ip_data?.countryCode?.toUpperCase() === normalizedCountry
  );
  const otherProxies = proxies.filter(
    (p) => p.ip_data?.countryCode?.toUpperCase() !== normalizedCountry
  );

  let testedCount = 0;

  if (randomize) {
    // =========================================================================
    // CHẾ ĐỘ NGẪU NHIÊN: Lấy ngẫu nhiên số thứ tự trong tổng kết quả, không quét từ trên xuống
    // =========================================================================
    logger?.info?.(
      `[DANH SÁCH PROXY] Tổng kết quả: ${proxies.length} proxy (khớp [${normalizedCountry}]: ${matchedCountryProxies.length}, khác: ${otherProxies.length}).\n` +
      `-> CHẾ ĐỘ KIỂM TRA: Bốc ngẫu nhiên số thứ tự trong tổng kết quả, không quét lần lượt từ trên xuống.`
    );

    interface CandidateItem {
      item: ScrapedProxyItem;
      originalIndex: number;
      totalInGroup: number;
      groupName: string;
    }

    // Nhóm ưu tiên: các proxy khớp quốc gia yêu cầu
    const matchedPool: CandidateItem[] = matchedCountryProxies.map((item, idx) => ({
      item,
      originalIndex: idx + 1,
      totalInGroup: matchedCountryProxies.length,
      groupName: normalizedCountry
    }));

    // Nhóm phụ: các proxy quốc gia khác
    const otherPool: CandidateItem[] = otherProxies.map((item, idx) => ({
      item,
      originalIndex: idx + 1,
      totalInGroup: otherProxies.length,
      groupName: 'Khác'
    }));

    while (testedCount < maxTestCount) {
      // Ưu tiên bốc ngẫu nhiên từ nhóm khớp quốc gia, nếu hết mới bốc ngẫu nhiên từ nhóm khác
      const activePool = matchedPool.length > 0 ? matchedPool : otherPool;
      if (activePool.length === 0) {
        break; // Đã kiểm tra hết tất cả proxy có trong kết quả
      }

      // Bốc ngẫu nhiên 1 vị trí trong activePool
      const randomPos = Math.floor(Math.random() * activePool.length);
      const candidate = activePool.splice(randomPos, 1)[0];

      testedCount++;
      const item = candidate.item;
      const proxyHost = item.ip;
      const proxyPort = item.port;
      const proto = (item.protocol || 'http').toLowerCase().trim();
      const serverUrl = `${proto}://${proxyHost}:${proxyPort}`;
      const itemCountry = item.ip_data?.countryCode || 'N/A';
      const uptime = item.uptime ? `${item.uptime.toFixed(1)}%` : 'N/A';

      logger?.info?.(
        `[KIỂM TRA PROXY ${testedCount}/${maxTestCount}] Đang test ngẫu nhiên vị trí #${candidate.originalIndex}/${candidate.totalInGroup} [${candidate.groupName}]: ${serverUrl} (${itemCountry}, Uptime: ${uptime})...`
      );

      const check = await testProxyConnection(proxyHost, proxyPort, {
        timeoutMs: testTimeoutMs,
        protocol: proto
      });

      if (check.alive) {
        logger?.info?.(
          `✔ [KẾT NỐI PROXY THÀNH CÔNG] Proxy ${serverUrl} (vị trí ngẫu nhiên #${candidate.originalIndex}, ${itemCountry}, độ trễ: ${check.latencyMs}ms) hoạt động tốt! Chọn làm proxy chính thức.`
        );

        const workingConfig: ProxyConfig = {
          enabled: true,
          server: serverUrl,
          username: '',
          password: '',
          bypass: ''
        };

        return {
          proxyConfig: workingConfig,
          testedCount,
          selectedProxyItem: item,
          source
        };
      } else {
        logger?.warn?.(
          `✖ [PROXY LỖI] Vị trí ngẫu nhiên #${candidate.originalIndex} (${serverUrl}) không kết nối được (${check.error || 'timeout'}). Đang thử với proxy tiếp theo (bốc ngẫu nhiên số thứ tự khác)...`
        );
      }
    }
  } else {
    // =========================================================================
    // CHẾ ĐỘ TUẦN TỰ (randomize = false): Sắp xếp theo uptime và quét lần lượt từ trên xuống
    // =========================================================================
    const sortFn = (a: ScrapedProxyItem, b: ScrapedProxyItem) => {
      const uptimeA = a.uptime ?? 0;
      const uptimeB = b.uptime ?? 0;
      if (uptimeB !== uptimeA) return uptimeB - uptimeA;
      return (a.timeout ?? 9999) - (b.timeout ?? 9999);
    };

    matchedCountryProxies.sort(sortFn);
    otherProxies.sort(sortFn);

    const candidateProxies = [...matchedCountryProxies, ...otherProxies].slice(0, maxTestCount);

    logger?.info?.(
      `[DANH SÁCH PROXY] Tìm thấy ${candidateProxies.length} ứng viên (khớp ${normalizedCountry}: ${matchedCountryProxies.length}). Bắt đầu kiểm tra kết nối tuần tự từ trên xuống...`
    );

    for (let i = 0; i < candidateProxies.length; i++) {
      const item = candidateProxies[i];
      testedCount++;
      const proxyHost = item.ip;
      const proxyPort = item.port;
      const proto = (item.protocol || 'http').toLowerCase().trim();
      const serverUrl = `${proto}://${proxyHost}:${proxyPort}`;
      const itemCountry = item.ip_data?.countryCode || 'N/A';
      const uptime = item.uptime ? `${item.uptime.toFixed(1)}%` : 'N/A';

      logger?.info?.(
        `[KIỂM TRA PROXY ${testedCount}/${candidateProxies.length}] Đang test ${serverUrl} (${itemCountry}, Uptime: ${uptime})...`
      );

      const check = await testProxyConnection(proxyHost, proxyPort, {
        timeoutMs: testTimeoutMs,
        protocol: proto
      });

      if (check.alive) {
        logger?.info?.(
          `✔ [KẾT NỐI PROXY THÀNH CÔNG] Proxy ${serverUrl} (${itemCountry}, độ trễ: ${check.latencyMs}ms) hoạt động tốt! Chọn làm proxy chính thức.`
        );

        const workingConfig: ProxyConfig = {
          enabled: true,
          server: serverUrl,
          username: '',
          password: '',
          bypass: ''
        };

        return {
          proxyConfig: workingConfig,
          testedCount,
          selectedProxyItem: item,
          source
        };
      } else {
        logger?.warn?.(
          `✖ [PROXY LỖI] ${serverUrl} không kết nối được (${check.error || 'timeout'}). Đang thử với proxy tiếp theo...`
        );
      }
    }
  }

  // Nếu duyệt hết mà không có free proxy nào sống -> kiểm tra fallback
  if (options?.fallbackProxy && options.fallbackProxy.server) {
    logger?.warn?.(
      `[FALLBACK PROXY DỰ PHÒNG] Đã kiểm tra ${testedCount} proxy nhưng đều không phản hồi.\n` +
      `  -> Chuyển sang sử dụng proxy cấu hình dự phòng: ${sanitizeUrl(options.fallbackProxy.server)}`
    );

    return {
      proxyConfig: options.fallbackProxy,
      testedCount,
      source: 'fallback_config'
    };
  }

  throw new Error(
    `[LỖI TẤT CẢ PROXY THẤT BẠI] Đã thử ${testedCount} proxy ngẫu nhiên cho quốc gia [${normalizedCountry}] nhưng không có proxy nào kết nối thành công.\n` +
    `Quy tắc an toàn: Dừng lại, tuyệt đối không tự động chuyển sang kết nối trực tiếp (IP máy thật).`
  );
}
