import { ProxyConfig } from '../config/types';
import { PlaywrightProxyOptions } from './types';

const SUPPORTED_PROTOCOLS = ['http', 'https', 'socks5', 'socks4'];

/**
 * Xây dựng và kiểm tra đối tượng cấu hình proxy cho Playwright / Chromium.
 * Hỗ trợ các giao thức proxy phổ biến: http, https, socks5, socks4.
 */
export function buildPlaywrightProxy(proxyConfig: ProxyConfig): PlaywrightProxyOptions {
  let server = proxyConfig.server?.trim() || '';
  if (!server) {
    throw new Error(
      '[LỖI PROXY] Cấu hình proxy đang được bật (proxy.enabled = true) nhưng "proxy.server" bị trống.'
    );
  }

  // Nếu server chưa có scheme giao thức (ví dụ: host:port), tự động chuẩn hóa sang http://
  if (!/^([a-zA-Z0-9+.-]+):\/\//.test(server)) {
    server = `http://${server}`;
  }

  // Kiểm tra scheme giao thức
  const schemeMatch = server.match(/^([a-zA-Z0-9+.-]+):\/\//);
  if (schemeMatch) {
    const protocol = schemeMatch[1].toLowerCase();
    if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
      throw new Error(
        `[LỖI PROXY] Giao thức "${protocol}://" không được Playwright hỗ trợ.\n` +
        `Playwright chỉ hỗ trợ các giao thức proxy: ${SUPPORTED_PROTOCOLS.map((p) => p + '://').join(', ')}.\n` +
        `Hệ thống từ chối chạy để tránh kết nối sai lệch hoặc rò rỉ dữ liệu ngoài ý muốn.`
      );
    }
  }

  const options: PlaywrightProxyOptions = {
    server
  };

  if (proxyConfig.bypass && proxyConfig.bypass.trim()) {
    options.bypass = proxyConfig.bypass.trim();
  }

  if (proxyConfig.username) {
    options.username = proxyConfig.username;
  }

  if (proxyConfig.password) {
    options.password = proxyConfig.password;
  }

  return options;
}
