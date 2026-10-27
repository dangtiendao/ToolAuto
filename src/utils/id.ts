/**
 * Tạo một runId duy nhất cho mỗi lượt chạy, có thứ tự thời gian và an toàn cho tên file.
 * Định dạng: YYYYMMDD-HHmmss-xxxx (ví dụ: 20261027-221530-ab12)
 */
export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');

  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomSuffix = Math.random().toString(36).substring(2, 6);

  return `${dateStr}-${randomSuffix}`;
}
