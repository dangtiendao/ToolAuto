import { Flow } from '../runner/types';

/**
 * Luồng tự động hóa demo:
 * - Sử dụng trang startUrl đã được mở sẵn bởi Browser Manager.
 * - Chờ DOM sẵn sàng.
 * - Đọc tiêu đề trang và URL thực tế.
 * - Ghi nhật ký kết quả an toàn.
 * - Tuyệt đối không click, không gõ phím, không gửi biểu mẫu.
 */
export const demoFlow: Flow = {
  name: 'demo',
  description: 'Luồng mẫu kiểm tra trạng thái DOM, đọc tiêu đề và URL của trang',
  supportsConcurrency: true,
  steps: [
    {
      id: 'wait-dom-ready',
      name: 'Chờ trạng thái DOM sẵn sàng',
      execute: async (context) => {
        await context.page.waitForLoadState('domcontentloaded');
      },
      verify: async (context) => {
        const readyState = await context.page.evaluate(() => document.readyState);
        return readyState === 'interactive' || readyState === 'complete';
      }
    },
    {
      id: 'read-page-info',
      name: 'Đọc tiêu đề và URL cuối cùng của trang',
      execute: async (context) => {
        const title = await context.page.title();
        const currentUrl = context.page.url();

        context.logger.info(`[KẾT QUẢ ĐỌC TRANG] Tiêu đề: "${title}"`, {
          flow: 'demo',
          step: 'read-page-info'
        });
        context.logger.info(`[KẾT QUẢ ĐỌC TRANG] URL thực tế: "${currentUrl}"`, {
          flow: 'demo',
          step: 'read-page-info'
        });
      },
      verify: async (context) => {
        const url = context.page.url();
        return typeof url === 'string' && url.length > 0;
      }
    }
  ]
};
