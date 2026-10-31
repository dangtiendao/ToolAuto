import * as fs from 'fs';

/**
 * Che giấu số điện thoại để hiển thị an toàn trên terminal hoặc log.
 * Giữ 3 ký tự đầu và 3 ký tự cuối (hoặc 2 ký tự với số ngắn), phần giữa thay bằng dấu sao.
 * Tuyệt đối không bao giờ trả về nguyên vẹn toàn bộ số điện thoại nếu độ dài > 4.
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    return '[SỐ TRỐNG]';
  }

  const clean = phone.trim();
  const len = clean.length;

  if (len <= 4) {
    return '***';
  }

  if (len <= 7) {
    return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
  }

  return `${clean.slice(0, 3)}****${clean.slice(-3)}`;
}

/**
 * Đọc file danh sách số điện thoại (TXT) bằng Node.js với các tiêu chí nghiêm ngặt:
 * - Hỗ trợ UTF-8 và UTF-8 with BOM (\uFEFF).
 * - Hỗ trợ cả xuống dòng Windows CRLF (\r\n) và Unix LF (\n).
 * - Trim khoảng trắng đầu/cuối, loại bỏ các dòng trống.
 * - Giữ nguyên dạng string, bảo toàn dấu "+" và số 0 ở đầu.
 * - Loại bỏ các dòng trùng sau khi trim.
 * - Không tự thêm mã quốc gia hoặc thay đổi nội dung số.
 * - Dừng và báo rõ nếu thiếu file, file rỗng hoặc định dạng không hợp lệ.
 */
export function readPhoneNumbersFromFile(filePath: string): string[] {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(
      '[LỖI FILE SỐ ĐIỆN THOẠI] Đường dẫn file danh sách số điện thoại không được để trống (phoneNumbersFile).'
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[LỖI FILE SỐ ĐIỆN THOẠI] Không tìm thấy file danh sách số điện thoại tại đường dẫn:\n  -> ${filePath}`
    );
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `[LỖI FILE SỐ ĐIỆN THOẠI] Không thể đọc file tại "${filePath}": ${(err as Error).message}`
    );
  }

  // Loại bỏ BOM UTF-8 nếu có
  const cleanContent = rawContent.replace(/^\uFEFF/, '');

  // Tách dòng theo cả CRLF và LF
  const rawLines = cleanContent.split(/\r?\n/);
  const validPhones: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const line = rawLines[i].trim();

    // Bỏ qua dòng trống
    if (!line) continue;

    // Kiểm tra định dạng: chỉ cho phép bắt đầu bằng dấu + (nếu có) và theo sau là các chữ số (từ 7 đến 15 số)
    // Bảo toàn dạng string, không chuyển sang kiểu số để giữ nguyên số 0 ở đầu
    const phoneRegex = /^\+?[0-9]{7,15}$/;
    if (!phoneRegex.test(line)) {
      throw new Error(
        `[LỖI ĐỊNH DẠNG SỐ ĐIỆN THOẠI] Dòng ${lineNumber} trong file "${filePath}" chứa dữ liệu không hợp lệ.\n` +
        `  -> Dữ liệu: "${maskPhoneNumber(line)}"\n` +
        `  -> Yêu cầu: Mỗi dòng chỉ chứa một số điện thoại (từ 7 đến 15 chữ số, có thể bắt đầu bằng dấu "+").\n` +
        `  -> Hệ thống không tự ý sửa đổi hoặc thêm mã quốc gia.`
      );
    }

    // Loại bỏ dòng trùng lặp
    if (!seen.has(line)) {
      seen.add(line);
      validPhones.push(line);
    }
  }

  if (validPhones.length === 0) {
    throw new Error(
      `[LỖI FILE SỐ ĐIỆN THOẠI] File danh sách số điện thoại tại "${filePath}" rỗng hoặc không chứa số điện thoại hợp lệ nào.`
    );
  }

  return validPhones;
}

/**
 * Chọn ngẫu nhiên đúng 1 số điện thoại từ danh sách đã kiểm tra tính hợp lệ.
 */
export function selectRandomPhone(phoneNumbers: string[]): string {
  if (!phoneNumbers || phoneNumbers.length === 0) {
    throw new Error('[LỖI CHỌN SỐ ĐIỆN THOẠI] Danh sách số điện thoại rỗng, không thể chọn số.');
  }

  const randomIndex = Math.floor(Math.random() * phoneNumbers.length);
  return phoneNumbers[randomIndex];
}

/**
 * Kiểm tra tính tương đương giữa số đã nhập trên giao diện và số gốc,
 * hỗ trợ trường hợp UI tự động định dạng (thêm khoảng trắng, dấu gạch nối, dấu ngoặc).
 */
export function isPhoneEquivalent(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;

  const normalize = (val: string) => val.replace(/[\s\-\(\)\.]/g, '').trim();
  const nActual = normalize(actual);
  const nExpected = normalize(expected);
  if (nActual === nExpected) return true;

  // Hỗ trợ trường hợp một bên có +84 / 84 và một bên là 0 ở đầu (định dạng Việt Nam)
  const toVnLocal = (v: string) => {
    if (v.startsWith('+84')) return '0' + v.slice(3);
    if (v.startsWith('84') && v.length >= 11) return '0' + v.slice(2);
    return v;
  };

  const toDigitsOnly = (v: string) => {
    const local = toVnLocal(v);
    return local.startsWith('0') ? local.slice(1) : local;
  };

  if (toVnLocal(nActual) === toVnLocal(nExpected)) return true;
  if (toDigitsOnly(nActual) === toDigitsOnly(nExpected)) return true;

  return false;
}
