import * as fs from 'fs';
import * as path from 'path';

export interface SaveEmailOptions {
  /** Đường dẫn file output (tuyệt đối hoặc tương đối). Mặc định: 'output/emails.txt' */
  filePath?: string;
  /** Thư mục gốc dự án để resolve đường dẫn tương đối */
  projectRoot?: string;
  /** Cho phép ghi trùng lặp email nếu đã có trong danh sách. Mặc định: false */
  allowDuplicates?: boolean;
  /** Logger để ghi nhận thông tin */
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

// Mutex dạng Promise Chain để bảo vệ ghi file an toàn khi chạy đa luồng/worker đồng thời
let writeMutex = Promise.resolve();

/**
 * Lưu địa chỉ email vào danh sách file txt output.
 * Tự động tạo thư mục nếu chưa tồn tại, chuẩn hóa dòng và ngăn chặn trùng lặp mặc định.
 * 
 * @param email Địa chỉ email cần lưu
 * @param options Tùy chọn đường dẫn, logger, cấu hình trùng lặp
 * @returns Đường dẫn tuyệt đối của file đã lưu
 */
export async function saveEmailToOutputFile(
  email: string,
  options?: SaveEmailOptions
): Promise<string> {
  if (!email || typeof email !== 'string' || !email.trim()) {
    throw new Error('[LỖI LƯU EMAIL] Địa chỉ email cần lưu không được để trống.');
  }

  const trimmedEmail = email.trim();
  const rootDir = options?.projectRoot || process.cwd();
  const targetPath = options?.filePath?.trim() || path.join('output', 'emails.txt');
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(rootDir, targetPath);

  // Đảm bảo thao tác ghi diễn ra tuần tự an toàn tránh xung đột đa tiến trình/worker
  return new Promise<string>((resolve, reject) => {
    writeMutex = writeMutex.then(async () => {
      try {
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          await fs.promises.mkdir(dir, { recursive: true });
        }

        let existingLines: string[] = [];
        let fileExists = false;

        if (fs.existsSync(resolvedPath)) {
          fileExists = true;
          const content = await fs.promises.readFile(resolvedPath, 'utf-8');
          existingLines = content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        }

        // Kiểm tra trùng lặp nếu allowDuplicates = false (mặc định)
        if (!options?.allowDuplicates && fileExists) {
          const alreadyExists = existingLines.some(
            (line) => line.toLowerCase() === trimmedEmail.toLowerCase()
          );
          if (alreadyExists) {
            options?.logger?.info?.(
              `[OUTPUT EMAIL] Email "${trimmedEmail}" đã tồn tại trong danh sách: ${resolvedPath}. Không ghi trùng lặp.`,
              { email: trimmedEmail, file: resolvedPath }
            );
            resolve(resolvedPath);
            return;
          }
        }

        // Thêm ký tự xuống dòng phù hợp
        const lineToAppend = `${trimmedEmail}\n`;
        await fs.promises.appendFile(resolvedPath, lineToAppend, 'utf-8');

        const logMsg = `✔ [LƯU OUTPUT EMAIL] Đã lưu email "${trimmedEmail}" vào danh sách txt output: ${resolvedPath}`;
        options?.logger?.info?.(logMsg, { email: trimmedEmail, file: resolvedPath });
        console.log(logMsg);

        resolve(resolvedPath);
      } catch (err) {
        options?.logger?.error?.(
          `[LỖI LƯU EMAIL] Không thể ghi email vào file "${resolvedPath}": ${(err as Error).message}`,
          { email: trimmedEmail, file: resolvedPath }
        );
        reject(err);
      }
    });
  });
}

/**
 * Đọc toàn bộ danh sách email từ file output txt.
 * 
 * @param filePath Đường dẫn file txt output
 * @returns Mảng danh sách email hợp lệ
 */
export async function readOutputEmails(filePath: string): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
