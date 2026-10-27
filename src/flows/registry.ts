import { Flow } from '../runner/types';

const flowRegistry = new Map<string, Flow>();

/**
 * Đăng ký một luồng vào hệ thống.
 */
export function registerFlow(flow: Flow): void {
  if (!flow || !flow.name) {
    throw new Error('[LỖI REGISTRY] Luồng không hợp lệ hoặc thiếu tên luồng (name).');
  }
  flowRegistry.set(flow.name.toLowerCase().trim(), flow);
}

/**
 * Lấy luồng theo tên.
 */
export function getFlow(name: string): Flow | undefined {
  if (!name) return undefined;
  return flowRegistry.get(name.toLowerCase().trim());
}

/**
 * Lấy luồng theo tên hoặc ném lỗi nếu không tìm thấy.
 * Tuyệt đối không tự động dùng luồng khác (như demo) thay thế khi sai tên.
 */
export function getFlowOrThrow(name: string): Flow {
  const normalizedName = (name || '').toLowerCase().trim();
  const flow = flowRegistry.get(normalizedName);

  if (!flow) {
    const available = Array.from(flowRegistry.keys());
    throw new Error(
      `[LỖI REGISTRY] Không tìm thấy luồng có tên "${name}".\n` +
      `Các luồng hiện có trong hệ thống: [${available.join(', ')}].\n` +
      `Vui lòng kiểm tra lại trường "flowName" trong file config/config.json.`
    );
  }

  return flow;
}

/**
 * Danh sách tên các luồng đã đăng ký.
 */
export function listRegisteredFlows(): string[] {
  return Array.from(flowRegistry.keys());
}

/**
 * Xóa registry (dùng cho việc test hoặc reset).
 */
export function clearRegistry(): void {
  flowRegistry.clear();
}
