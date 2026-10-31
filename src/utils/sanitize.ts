/**
 * Loại bỏ thông tin xác thực (username:password) khỏi URL nếu có.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Nếu không phải URL hoàn chỉnh, dùng regex che các mẫu user:pass@
    return rawUrl.replace(/:\/\/([^:@]+):([^@]+)@/, '://***:***@');
  }
}

/**
 * Loại bỏ các trường nhạy cảm phổ biến (password, token, cookie, secret, authorization) khỏi thông điệp ghi log.
 */
export function sanitizeLogText(text: string): string {
  if (!text) return '';

  return text
    // Che Authorization headers (Bearer, Basic, v.v.)
    .replace(/(authorization\s*[:=]\s*)(bearer\s+[a-zA-Z0-9._~+/-]+=*|[^\s,;]+)/gi, '$1[REDACTED]')
    // Che cookie header
    .replace(/(cookie\s*[:=]\s*)([^;\r\n]+)/gi, '$1[REDACTED]')
    // Che password, secret, token, otp trong query string hoặc log
    .replace(/([?&](?:password|pass|token|secret|apiKey|access_token|otp|code)=)([^&#\s]+)/gi, '$1[REDACTED]')
    // Che các chuỗi user:pass trong url
    .replace(/:\/\/([^:@\s]+):([^@\s]+)@/g, '://[REDACTED]:[REDACTED]@');
}
