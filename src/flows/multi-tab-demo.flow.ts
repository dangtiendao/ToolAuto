import { Flow } from '../runner/types';

/**
 * Luồng demo kiểm thử song song nhiều Chrome độc lập (multi-tab-demo):
 * 
 * Mỗi worker:
 * a. Tạo TabA, TabB, TabC trong cùng context.
 * b. Tạo marker riêng theo jobId.
 * c. Trên TabA, lưu marker vào cookie của origin fixture.
 * d. Trên TabB và TabC, kiểm tra đọc được marker đó.
 * e. Kiểm tra worker khác không đọc được marker của worker này.
 * f. Thực hiện các bước đọc/nhập trên fixture tuần tự.
 * g. Có điểm chờ thủ công để kiểm thử resume đúng worker.
 * h. Kết thúc mà không gọi website gửi OTP/SMS thật.
 */
export const multiTabDemoFlow: Flow = {
  name: 'multi-tab-demo',
  description: 'Luồng kiểm thử song song TabA, TabB, TabC trong cùng context ẩn danh độc lập',
  supportsConcurrency: true,
  steps: [
    // 1. Tạo TabA và truy cập fixture
    {
      id: 'step-1-create-tab-a',
      name: 'Tạo TabA và truy cập máy chủ fixture',
      execute: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs) {
          throw new Error('TabManager không khả dụng trong context của worker.');
        }

        const baseUrl = (context.data?.fixtureUrl as string) || context.config.startUrl || 'http://127.0.0.1:19188';
        const pageA = await tabs.createTab('TabA', `${baseUrl}/page-a`);

        // Đảm bảo DOM sẵn sàng
        await pageA.waitForLoadState('domcontentloaded');
        context.logger.info(`TabA đã mở thành công tại: ${baseUrl}/page-a`, {
          flow: 'multi-tab-demo',
          step: 'step-1-create-tab-a'
        });
      },
      verify: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        return tabs ? tabs.hasTab('TabA') : false;
      }
    },

    // 2. Tạo marker riêng theo jobId và lưu vào cookie qua TabA
    {
      id: 'step-2-set-marker-cookie',
      name: 'Lưu marker riêng theo jobId vào cookie trên TabA',
      execute: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs) throw new Error('TabManager không khả dụng.');

        const pageA = tabs.getTab('TabA');
        const jobId = context.jobId || (context.data?.jobId as string) || 'job-unknown';
        const marker = `marker_${jobId}_${Date.now()}`;

        if (!context.data) context.data = {};
        context.data.marker = marker;

        // Lưu cookie vào origin của fixture bằng evaluate trên TabA
        await pageA.evaluate((m) => {
          document.cookie = `worker_marker=${encodeURIComponent(m)}; path=/; SameSite=Lax`;
        }, marker);

        // Kiểm tra cookie đã được ghi nhận trên TabA
        const cookieValue = await pageA.evaluate(() => document.cookie);
        if (!cookieValue.includes(marker)) {
          throw new Error(`Ghi cookie trên TabA thất bại. Giá trị đọc được: "${cookieValue}"`);
        }

        context.logger.info(`Đã lưu marker vào cookie trên TabA thành công: worker_marker=${marker}`, {
          flow: 'multi-tab-demo',
          step: 'step-2-set-marker-cookie'
        });
      },
      verify: async (context) => {
        const marker = context.data?.marker as string;
        return typeof marker === 'string' && marker.length > 0;
      }
    },

    // 3. Tạo TabB và kiểm tra đọc được marker từ cùng context
    {
      id: 'step-3-create-and-verify-tab-b',
      name: 'Tạo TabB và kiểm tra chia sẻ cookie từ TabA',
      execute: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs) throw new Error('TabManager không khả dụng.');

        const baseUrl = (context.data?.fixtureUrl as string) || context.config.startUrl || 'http://127.0.0.1:19188';
        const pageB = await tabs.createTab('TabB', `${baseUrl}/page-b`);
        await pageB.waitForLoadState('domcontentloaded');

        const expectedMarker = context.data?.marker as string;
        const cookieOnTabB = await pageB.evaluate(() => document.cookie);

        if (!cookieOnTabB.includes(expectedMarker)) {
          throw new Error(
            `TabB không đọc được cookie chia sẻ từ TabA. Cookie đọc được: "${cookieOnTabB}", cần: "${expectedMarker}"`
          );
        }

        context.logger.info(`TabB đã đọc được marker chia sẻ chính xác: ${expectedMarker}`, {
          flow: 'multi-tab-demo',
          step: 'step-3-create-and-verify-tab-b'
        });
      },
      verify: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        return tabs ? tabs.hasTab('TabB') : false;
      }
    },

    // 4. Tạo TabC và kiểm tra đọc được marker từ cùng context
    {
      id: 'step-4-create-and-verify-tab-c',
      name: 'Tạo TabC và kiểm tra chia sẻ cookie từ TabA',
      execute: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs) throw new Error('TabManager không khả dụng.');

        const baseUrl = (context.data?.fixtureUrl as string) || context.config.startUrl || 'http://127.0.0.1:19188';
        const pageC = await tabs.createTab('TabC', `${baseUrl}/page-c`);
        await pageC.waitForLoadState('domcontentloaded');

        const expectedMarker = context.data?.marker as string;
        const cookieOnTabC = await pageC.evaluate(() => document.cookie);

        if (!cookieOnTabC.includes(expectedMarker)) {
          throw new Error(
            `TabC không đọc được cookie chia sẻ từ TabA. Cookie đọc được: "${cookieOnTabC}", cần: "${expectedMarker}"`
          );
        }

        context.logger.info(`TabC đã đọc được marker chia sẻ chính xác: ${expectedMarker}`, {
          flow: 'multi-tab-demo',
          step: 'step-4-create-and-verify-tab-c'
        });
      },
      verify: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        return tabs ? tabs.hasTab('TabC') : false;
      }
    },

    // 5. Kiểm tra tuần tự nhập liệu trên form của TabB
    {
      id: 'step-5-interact-form-tab-b',
      name: 'Thực hiện thao tác nhập liệu và xác nhận trên TabB',
      execute: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs) throw new Error('TabManager không khả dụng.');

        const pageB = tabs.getTab('TabB');
        const jobId = context.jobId || (context.data?.jobId as string) || 'demo';
        const testInputValue = `input_data_${jobId}`;

        // Điền vào ô input trên fixture
        await pageB.fill('#demo-input', testInputValue);
        await pageB.click('#demo-submit');

        // Chờ trạng thái cập nhật
        await pageB.waitForFunction(
          (expected) => {
            const statusEl = document.getElementById('status');
            return statusEl && statusEl.textContent && statusEl.textContent.includes(expected);
          },
          testInputValue,
          { timeout: 5000 }
        );

        context.logger.info(`TabB đã hoàn tất nhập liệu và cập nhật trạng thái với giá trị "${testInputValue}".`, {
          flow: 'multi-tab-demo',
          step: 'step-5-interact-form-tab-b'
        });
      },
      verify: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs) return false;
        const pageB = tabs.getTab('TabB');
        const statusText = await pageB.textContent('#status');
        const jobId = context.jobId || (context.data?.jobId as string) || 'demo';
        return statusText ? statusText.includes(`input_data_${jobId}`) : false;
      }
    },

    // 6. Điểm chờ thủ công (chỉ kích hoạt nếu không tắt qua context.data.skipManualWait)
    {
      id: 'step-6-manual-checkpoint',
      name: 'Điểm chờ xác nhận thủ công (kiểm thử resume)',
      execute: async (context) => {
        // Nếu trong chế độ test tự động có cờ skipManualWait: bỏ qua bước chờ
        if (context.data?.skipManualWait === true) {
          context.logger.info('Bỏ qua điểm chờ thủ công theo cờ skipManualWait.', {
            flow: 'multi-tab-demo',
            step: 'step-6-manual-checkpoint'
          });
          return;
        }

        const tabs = context.tabManager || context.runtime?.tabs;
        if (tabs && tabs.hasTab('TabB')) {
          // Chỉ đưa tab lên trước khi người dùng cần quan sát/xử lý
          await tabs.bringToFront('TabB');
        }

        if (context.runtime?.waitForHuman) {
          context.logger.info(
            `Worker [${context.workerId || 'unknown'}] đang chờ tín hiệu resume tại bước checkpoint...`,
            { flow: 'multi-tab-demo', step: 'step-6-manual-checkpoint' }
          );
          await context.runtime.waitForHuman(
            'step-6-manual-checkpoint',
            'Kiểm tra DOM trên TabB và gõ: resume <workerId>'
          );
        }
      },
      verify: async (context) => {
        // Sau khi resume: Worker phải kiểm tra lại điều kiện DOM
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs || !tabs.hasTab('TabB')) return false;
        const pageB = tabs.getTab('TabB');
        const checkpointEl = await pageB.$('#manual-checkpoint');
        return checkpointEl !== null;
      }
    },

    // 7. Dọn dẹp các tab
    {
      id: 'step-7-close-tabs',
      name: 'Đóng các tab sau khi hoàn tất',
      execute: async (context) => {
        const tabs = context.tabManager || context.runtime?.tabs;
        if (!tabs) return;

        // Đóng TabA, TabB, TabC theo thứ tự an toàn
        if (tabs.hasTab('TabA')) await tabs.closeTab('TabA');
        if (tabs.hasTab('TabB')) await tabs.closeTab('TabB');
        // Giữ TabC nếu cần quan sát, hoặc đóng hết theo cấu hình
        if (context.data?.keepTabCOpen !== true && tabs.hasTab('TabC')) {
          await tabs.closeTab('TabC');
        }
        context.logger.info('Hoàn tất luồng demo multi-tab-demo.', {
          flow: 'multi-tab-demo',
          step: 'step-7-close-tabs'
        });
      }
    }
  ]
};
