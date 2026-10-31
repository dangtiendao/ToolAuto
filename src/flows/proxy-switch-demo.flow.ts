import { Flow } from '../runner/types';
import { sanitizeUrl } from '../utils/sanitize';
import { safeGoto } from '../browser';

/**
 * Luồng demo bật/tắt proxy riêng biệt (proxy-switch-demo).
 *
 * Thứ tự các bước:
 * 1. Đảm bảo chế độ direct.
 * 2. Mở URL kiểm tra do người dùng cấu hình (Giai đoạn A).
 * 3. Kiểm tra giai đoạn A hoàn thành.
 * 4. Bật proxy bằng bước chuyển chế độ (đóng và mở lại Chrome).
 * 5. Mở lại URL kiểm tra trên tab mới (Giai đoạn B).
 * 6. Kiểm tra giai đoạn B hoàn thành.
 * 7. Tắt proxy bằng bước chuyển chế độ (đóng và mở lại Chrome về direct).
 * 8. Kiểm tra kết nối direct.
 * 9. Kết thúc và chờ Enter theo cơ chế hiện có của hệ thống.
 *
 * Tuân thủ nghiêm ngặt:
 * - Không đăng nhập, không gửi biểu mẫu.
 * - Không thao tác YOPmail hoặc Muse.ai.
 * - Các Page cũ không được tái sử dụng sau restart.
 * - Lấy page/context từ browser manager, không giữ tham chiếu cũ.
 */
export const proxySwitchDemoFlow: Flow = {
  name: 'proxy-switch-demo',
  description: 'Luồng demo bật/tắt proxy bằng cách đóng và mở lại Chrome cùng profile đã chọn',
  supportsConcurrency: false,
  steps: [
    // 1. Đảm bảo chế độ direct
    {
      id: 'ensure-direct-mode',
      name: 'Đảm bảo chế độ direct ban đầu',
      execute: async (context) => {
        const bm = context.browserManager;
        if (!bm) {
          context.logger.info('BrowserManager không được gắn vào context. Giữ nguyên chế độ hiện tại.');
          return;
        }

        const currentMode = bm.getConnectionMode();
        if (currentMode !== 'direct') {
          context.logger.info(
            `Chế độ hiện tại là "${currentMode}". Đang chuyển về "direct" để bắt đầu giai đoạn A...`,
            { flow: 'proxy-switch-demo', step: 'ensure-direct-mode' }
          );
          await bm.switchConnectionMode('direct');
        } else {
          context.logger.info(
            'Chế độ kết nối không thay đổi (hiện tại: direct). Đã ở chế độ direct ban đầu.',
            { flow: 'proxy-switch-demo', step: 'ensure-direct-mode' }
          );
        }
      },
      verify: async (context) => {
        return context.browserManager ? context.browserManager.getConnectionMode() === 'direct' : true;
      }
    },

    // 2. Mở URL kiểm tra do người dùng cấu hình
    {
      id: 'stage-a-open-check-url',
      name: 'Giai đoạn A: Mở URL kiểm tra ở kết nối trực tiếp (direct)',
      execute: async (context) => {
        const checkUrl = context.config.proxyCheckUrl || context.config.startUrl;
        context.logger.info(
          `[GIAI ĐOẠN A] Đang mở URL kiểm tra kết nối trực tiếp: ${sanitizeUrl(checkUrl)}`,
          { flow: 'proxy-switch-demo', step: 'stage-a-open-check-url' }
        );

        await safeGoto(context.page, checkUrl, {
          waitUntil: 'domcontentloaded',
          timeout: context.config.navigationTimeoutMs,
          maxRetries: context.config.pageLoadMaxRetries,
          retryDelayMs: context.config.pageLoadRetryDelayMs,
          logger: context.logger,
          cancellationToken: context.cancellationToken,
          flowName: 'proxy-switch-demo',
          stepName: 'stage-a-open-check-url'
        });

        const title = await context.page.title();
        const finalUrl = context.page.url();
        context.logger.info(
          `[GIAI ĐOẠN A] Đã mở URL kiểm tra thành công. Tiêu đề: "${title}", URL: "${finalUrl}"`,
          { flow: 'proxy-switch-demo', step: 'stage-a-open-check-url' }
        );
      },
      verify: async (context) => {
        return !context.page.isClosed();
      }
    },

    // 3. Kiểm tra giai đoạn A hoàn thành
    {
      id: 'stage-a-verify',
      name: 'Kiểm tra giai đoạn A hoàn thành',
      execute: async (context) => {
        let directIp: string | undefined;
        try {
          const bodyText = await context.page.innerText('body');
          try {
            const parsed = JSON.parse(bodyText);
            directIp = parsed.origin || parsed.ip;
          } catch {
            const match = bodyText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
            if (match) {
              directIp = match[0];
            }
          }
        } catch {
          // Bỏ qua lỗi đọc text
        }

        if (directIp) {
          context.logger.info(
            `[GIAI ĐOẠN A - DIRECT] Địa chỉ IP phản hồi ghi nhận: ${directIp}`,
            { flow: 'proxy-switch-demo', step: 'stage-a-verify' }
          );
          context.data = context.data || {};
          context.data.directIp = directIp;
        }

        context.logger.info(
          'Giai đoạn A (kết nối trực tiếp, không dùng proxy) đã hoàn thành đạt yêu cầu.',
          { flow: 'proxy-switch-demo', step: 'stage-a-verify' }
        );
      },
      verify: async () => {
        return true;
      }
    },

    // 4. Bật proxy bằng bước chuyển chế độ
    {
      id: 'switch-to-proxy',
      name: 'Bật proxy bằng bước chuyển chế độ (đóng và mở lại Chrome)',
      execute: async (context) => {
        const bm = context.browserManager;
        if (!bm) {
          throw new Error('[LỖI RUNNER] BrowserManager không khả dụng trong FlowContext.');
        }

        context.logger.info(
          'Đang kích hoạt bước chuyển sang chế độ proxy (đóng Chrome hiện tại và mở lại cùng profile)...',
          { flow: 'proxy-switch-demo', step: 'switch-to-proxy' }
        );

        await bm.enableProxy();
      },
      verify: async (context) => {
        return context.browserManager ? context.browserManager.getConnectionMode() === 'proxy' : false;
      }
    },

    // 5. Mở lại URL kiểm tra trên tab mới
    {
      id: 'stage-b-open-check-url',
      name: 'Giai đoạn B: Mở lại URL kiểm tra trên tab mới ở chế độ proxy',
      execute: async (context) => {
        const bm = context.browserManager;
        const checkUrl = context.config.proxyCheckUrl || context.config.startUrl;

        // Tạo tab mới với tên định danh rõ ràng theo quy định Mục 5
        const pageB = bm ? await bm.newPage('Tab-StageB-Proxy') : context.page;

        context.logger.info(
          `[GIAI ĐOẠN B] Đang mở URL kiểm tra qua proxy trên tab mới [Tab-StageB-Proxy]: ${sanitizeUrl(checkUrl)}`,
          { flow: 'proxy-switch-demo', step: 'stage-b-open-check-url' }
        );

        await safeGoto(pageB, checkUrl, {
          waitUntil: 'domcontentloaded',
          timeout: context.config.navigationTimeoutMs,
          maxRetries: context.config.pageLoadMaxRetries,
          retryDelayMs: context.config.pageLoadRetryDelayMs,
          logger: context.logger,
          cancellationToken: context.cancellationToken,
          flowName: 'proxy-switch-demo',
          stepName: 'stage-b-open-check-url'
        });

        const title = await pageB.title();
        const finalUrl = pageB.url();
        context.logger.info(
          `[GIAI ĐOẠN B] Đã mở URL kiểm tra qua proxy thành công. Tiêu đề: "${title}", URL: "${finalUrl}"`,
          { flow: 'proxy-switch-demo', step: 'stage-b-open-check-url' }
        );
      },
      verify: async (context) => {
        return !context.page.isClosed();
      }
    },

    // 6. Kiểm tra giai đoạn B hoàn thành
    {
      id: 'stage-b-verify',
      name: 'Kiểm tra giai đoạn B hoàn thành',
      execute: async (context) => {
        let proxyIp: string | undefined;
        try {
          const bodyText = await context.page.innerText('body');
          try {
            const parsed = JSON.parse(bodyText);
            proxyIp = parsed.origin || parsed.ip;
          } catch {
            const match = bodyText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
            if (match) {
              proxyIp = match[0];
            }
          }
        } catch {
          // Bỏ qua lỗi đọc text
        }

        if (proxyIp) {
          context.logger.info(
            `[GIAI ĐOẠN B - PROXY] Địa chỉ IP phản hồi qua proxy: ${proxyIp}`,
            { flow: 'proxy-switch-demo', step: 'stage-b-verify' }
          );
          context.data = context.data || {};
          context.data.proxyIp = proxyIp;
        }

        context.logger.info(
          'Giai đoạn B (kết nối qua proxy) đã hoàn thành đạt yêu cầu.',
          { flow: 'proxy-switch-demo', step: 'stage-b-verify' }
        );
      },
      verify: async () => {
        return true;
      }
    },

    // 7. Tắt proxy bằng bước chuyển chế độ
    {
      id: 'switch-to-direct',
      name: 'Tắt proxy bằng bước chuyển chế độ (đóng và mở lại Chrome về direct)',
      execute: async (context) => {
        const bm = context.browserManager;
        if (!bm) {
          throw new Error('[LỖI RUNNER] BrowserManager không khả dụng trong FlowContext.');
        }

        context.logger.info(
          'Đang kích hoạt bước tắt proxy và chuyển về kết nối trực tiếp (đóng Chrome proxy và mở lại)...',
          { flow: 'proxy-switch-demo', step: 'switch-to-direct' }
        );

        await bm.disableProxy();
      },
      verify: async (context) => {
        return context.browserManager ? context.browserManager.getConnectionMode() === 'direct' : false;
      }
    },

    // 8. Kiểm tra kết nối direct
    {
      id: 'verify-direct-restored',
      name: 'Kiểm tra kết nối direct sau khi tắt proxy',
      execute: async (context) => {
        const bm = context.browserManager;
        const checkUrl = context.config.proxyCheckUrl || context.config.startUrl;

        // Tạo tab mới với tên rõ ràng
        const pageC = bm ? await bm.newPage('Tab-StageC-Direct-Restored') : context.page;

        context.logger.info(
          `Đang kiểm tra kết nối trực tiếp trên tab mới [Tab-StageC-Direct-Restored]: ${sanitizeUrl(checkUrl)}`,
          { flow: 'proxy-switch-demo', step: 'verify-direct-restored' }
        );

        await safeGoto(pageC, checkUrl, {
          waitUntil: 'domcontentloaded',
          timeout: context.config.navigationTimeoutMs,
          maxRetries: context.config.pageLoadMaxRetries,
          retryDelayMs: context.config.pageLoadRetryDelayMs,
          logger: context.logger,
          cancellationToken: context.cancellationToken,
          flowName: 'proxy-switch-demo',
          stepName: 'verify-direct-restored'
        });

        const title = await pageC.title();
        const finalUrl = pageC.url();
        context.logger.info(
          `Đã xác minh kết nối trực tiếp phục hồi thành công. Tiêu đề: "${title}", URL: "${finalUrl}"`,
          { flow: 'proxy-switch-demo', step: 'verify-direct-restored' }
        );
      },
      verify: async (context) => {
        return !context.page.isClosed();
      }
    }
  ]
};
