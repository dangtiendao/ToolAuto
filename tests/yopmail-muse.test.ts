import * as assert from 'assert';
import {
  generateMailboxName,
  getYopmailMuseState,
  checkCaptchaOrVerification,
  waitForSingleMatchingElement,
  isValidOtpCode,
  matchesOtpDivStyle,
  enterOtpIntoTabB,
  waitForSingleMatchingMailItem,
  dismissPopupIfPresent,
  yopmailMuseFlow
} from '../src/flows/yopmail-muse.flow';
import { getFlow, getFlowOrThrow } from '../src/flows';
import { FlowContext } from '../src/runner/types';
import { Logger } from '../src/utils/logger';
import { getProjectRoot } from '../src/config';

async function runTests(): Promise<void> {
  console.log('--- BẮT ĐẦU KIỂM TRA LUỒNG YOPMAIL-MUSE (MỞ RỘNG OTP) ---\n');

  // ==========================================
  // Test 1: Kiểm tra bộ sinh chuỗi mailboxName
  // ==========================================
  console.log('1. Kiểm tra bộ sinh chuỗi generateMailboxName:');
  const ITERATIONS = 10000;
  const lengthsSeen = new Set<number>();

  for (let i = 0; i < ITERATIONS; i++) {
    const name = generateMailboxName();

    assert.ok(
      name.length >= 10 && name.length <= 14,
      `Độ dài phải từ 10 đến 14 ký tự. Thực tế: ${name.length} ("${name}")`
    );
    lengthsSeen.add(name.length);

    assert.strictEqual(
      /^[a-z0-9]+$/.test(name),
      true,
      `Chuỗi chỉ được chứa chữ thường và số: "${name}"`
    );

    assert.strictEqual(
      /[a-z]/.test(name),
      true,
      `Chuỗi bắt buộc chứa ít nhất một chữ cái: "${name}"`
    );

    assert.strictEqual(
      /[0-9]/.test(name),
      true,
      `Chuỗi bắt buộc chứa ít nhất một chữ số: "${name}"`
    );
  }

  for (let len = 10; len <= 14; len++) {
    assert.ok(
      lengthsSeen.has(len),
      `Bộ sinh chuỗi phải bao phủ độ dài ${len}. Các độ dài đã thấy: ${Array.from(lengthsSeen).join(', ')}`
    );
  }

  console.log(`  ✔ Đã kiểm tra ${ITERATIONS} chuỗi ngẫu nhiên:`);
  console.log('    - 100% đạt độ dài từ 10 đến 14 ký tự.');
  console.log('    - 100% chỉ gồm chữ thường a-z và chữ số 0-9.');
  console.log('    - 100% chứa ít nhất một chữ cái và một chữ số.');
  console.log(`    - Phủ đầy đủ tất cả độ dài: [${Array.from(lengthsSeen).sort().join(', ')}].`);

  // ==========================================
  // Test 2: Kiểm tra email trên TabB dùng đúng mailboxName của TabA
  // ==========================================
  console.log('\n2. Kiểm tra tính nhất quán email giữa TabA và TabB:');
  const projectRoot = getProjectRoot();
  const dummyLogger = new Logger('test-yopmail-muse', projectRoot);
  const mockContext: FlowContext = {
    page: {} as any,
    config: {
      startUrl: 'https://example.com',
      profileDir: 'profiles/test',
      navigationTimeoutMs: 10000,
      actionTimeoutMs: 5000,
      flowName: 'yopmail-muse',
      screenshotOnError: true,
      proxy: { enabled: false }
    },
    runId: 'test-run-123',
    logger: dummyLogger,
    data: {}
  };

  const state1 = getYopmailMuseState(mockContext);
  assert.ok(state1.mailboxName, 'Phải có mailboxName');
  assert.ok(state1.emailAddress, 'Phải có emailAddress');
  assert.strictEqual(
    state1.emailAddress,
    `${state1.mailboxName}@yopmail.com`,
    'emailAddress phải bằng mailboxName + "@yopmail.com"'
  );

  const state2 = getYopmailMuseState(mockContext);
  assert.strictEqual(
    state2.mailboxName,
    state1.mailboxName,
    'mailboxName không được sinh lại khi chuyển bước/chuyển tab'
  );
  assert.strictEqual(
    state2.emailAddress,
    state1.emailAddress,
    'emailAddress trên TabB phải dùng đúng chuỗi đã tạo cho TabA'
  );
  console.log('  ✔ mailboxName và emailAddress được lưu trong shared state của luồng, sinh đúng 1 lần và đồng nhất 100% giữa TabA và TabB.');

  // ==========================================
  // Test 3: Kiểm tra Đăng ký Flow trong Registry (5 bước tuần tự)
  // ==========================================
  console.log('\n3. Kiểm tra Flow Registry với luồng yopmail-muse mở rộng:');
  const foundFlow = getFlow('yopmail-muse');
  assert.ok(foundFlow, 'Phải tìm thấy luồng yopmail-muse trong registry');
  assert.strictEqual(foundFlow?.name, 'yopmail-muse');

  const foundViaOrThrow = getFlowOrThrow('yopmail-muse');
  assert.strictEqual(foundViaOrThrow.name, 'yopmail-muse');

  const stepIds = yopmailMuseFlow.steps.map((s) => s.id);
  assert.deepStrictEqual(stepIds, [
    'generate-mailbox',
    'tabA-yopmail',
    'tabB-muse',
    'tabA-extract-otp',
    'tabB-submit-otp'
  ]);
  console.log(`  ✔ Luồng đã đăng ký thành công với 5 bước tuần tự: [${stepIds.join(', ')}].`);

  // ==========================================
  // Test 4: Kiểm tra định dạng OTP 6 chữ số và bảo toàn số 0 ở đầu
  // ==========================================
  console.log('\n4. Kiểm tra định dạng OTP và bảo toàn số 0 ở đầu:');
  assert.strictEqual(isValidOtpCode('012345'), true, 'Mã bắt đầu bằng 0 phải hợp lệ');
  assert.strictEqual(isValidOtpCode('000000'), true, 'Mã toàn số 0 phải hợp lệ');
  assert.strictEqual(isValidOtpCode('987654'), true, 'Mã 6 chữ số thường phải hợp lệ');
  assert.strictEqual(isValidOtpCode('01234'), false, 'Mã 5 chữ số phải bị từ chối');
  assert.strictEqual(isValidOtpCode('0123456'), false, 'Mã 7 chữ số phải bị từ chối');
  assert.strictEqual(isValidOtpCode('01234a'), false, 'Mã chứa chữ cái phải bị từ chối');
  assert.strictEqual(isValidOtpCode(' 012345 '), false, 'Mã chứa khoảng trắng phải bị từ chối');
  assert.strictEqual(isValidOtpCode(123456 as any), false, 'OTP phải là kiểu string để bảo toàn số 0 ở đầu');
  console.log('  ✔ Kiểm tra định dạng ^[0-9]{6}$ và bảo toàn số 0 ở đầu bằng string thành công.');

  // ==========================================
  // Test 5: Kiểm tra nhận diện div chứa OTP theo thuộc tính kiểu dáng đặc trưng
  // ==========================================
  console.log('\n5. Kiểm tra nhận diện div chứa OTP theo kiểu dáng đặc trưng:');
  const exactStyle =
    'font-size: 24px; font-weight: 400; background: rgba(241, 244, 247, 1); color: rgba(28, 43, 51, 1); border-radius: 4px; letter-spacing: 2px; padding: 16px';
  assert.strictEqual(matchesOtpDivStyle(exactStyle), true, 'Chuỗi style chuẩn phải khớp');

  // Đảo thứ tự style, viết hoa/viết thường
  const disorderedStyle =
    'LETTER-SPACING: 2PX; padding: 16px; BORDER-RADIUS: 4PX; background: #f1f4f7; font-size: 24px; color: #1c2b33; font-weight: 400;';
  assert.strictEqual(matchesOtpDivStyle(disorderedStyle), true, 'Style đảo thứ tự và định dạng hex vẫn phải nhận diện chính xác');

  // Computed style
  const compStyle = {
    fontSize: '24px',
    letterSpacing: '2px',
    borderRadius: '4px',
    padding: '16px',
    backgroundColor: 'rgb(241, 244, 247)',
    color: 'rgb(28, 43, 51)'
  };
  assert.strictEqual(matchesOtpDivStyle('', compStyle), true, 'Computed style phải nhận diện chính xác');

  // Div không liên quan
  const irrelevantStyle = 'font-size: 14px; color: #000000; margin: 10px; display: block;';
  assert.strictEqual(matchesOtpDivStyle(irrelevantStyle), false, 'Div không liên quan phải bị loại trừ');
  console.log('  ✔ Nhận diện div chứa OTP theo các thuộc tính đặc trưng không phụ thuộc thứ tự thành công.');

  // ==========================================
  // Test 6: Kiểm tra lọc và chọn duy nhất thư Muse.ai trong hộp thư
  // ==========================================
  console.log('\n6. Kiểm tra xử lý danh sách thư (button.lm):');
  {
    // Trường hợp có 2 thư nhưng chỉ 1 thư của Muse
    const mockPageFiltered: any = {
      isClosed: () => false,
      title: async () => 'YOPmail',
      frame: () => null,
      frames: () => [],
      locator: (sel: string) => {
        if (sel === 'button.lm') {
          return {
            count: async () => 2,
            nth: (i: number) => ({
              isVisible: async () => true,
              innerText: async () => (i === 0 ? 'Spam Service: Promo 50%' : 'Muse.ai: Verification code for your account')
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const selected = await waitForSingleMatchingMailItem({
      page: mockPageFiltered,
      tabName: 'TabA',
      stepName: 'tabA-extract-otp',
      timeoutMs: 500
    });
    assert.ok(selected, 'Phải tìm được thư Muse');
    const txt = await selected.innerText();
    assert.ok(txt.includes('Muse.ai'), 'Phải chọn đúng thư của Muse.ai');
    console.log('  ✔ Lọc thư Muse.ai chính xác khi có nhiều thư khác nhau trong hộp thư.');
  }

  {
    // Trường hợp có 2 thư đều của Muse -> Phải dừng và báo lỗi, không tự dùng .first()
    const mockPageDuplicateMuse: any = {
      isClosed: () => false,
      title: async () => 'YOPmail',
      frame: () => null,
      frames: () => [],
      locator: (sel: string) => {
        if (sel === 'button.lm') {
          return {
            count: async () => 2,
            nth: () => ({
              isVisible: async () => true,
              innerText: async () => 'Muse.ai: Login code'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let duplicateThrew = false;
    try {
      await waitForSingleMatchingMailItem({
        page: mockPageDuplicateMuse,
        tabName: 'TabA',
        stepName: 'tabA-extract-otp',
        timeoutMs: 500
      });
    } catch (err: unknown) {
      duplicateThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI THƯ TRÙNG LẶP]'), 'Phải báo lỗi trùng lặp thư');
      assert.ok(msg.includes('.first()'), 'Phải cam kết không dùng .first() tùy tiện');
    }
    assert.strictEqual(duplicateThrew, true, 'Phải dừng khi có nhiều thư trùng lặp');
    console.log('  ✔ Từ chối dùng .first() khi có nhiều thư Muse trùng lặp.');
  }

  // ==========================================
  // Test 7: Kiểm tra các trường hợp nhập OTP trên TabB
  // ==========================================
  console.log('\n7. Kiểm tra các trường hợp nhập OTP trên TabB:');
  const testOtp = '048291';

  // 7.1: Trường hợp pin-digit là 6 ô input riêng
  {
    const inputValues: string[] = ['', '', '', '', '', ''];
    const mockPage6Inputs: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === '[data-slot="pin-digit"]') {
          return {
            count: async () => 6,
            nth: (i: number) => ({
              isVisible: async () => true,
              evaluate: async () => 'input',
              fill: async (val: string) => {
                inputValues[i] = val;
              },
              inputValue: async () => inputValues[i]
            }),
            first: () => ({
              evaluate: async () => 'input'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await enterOtpIntoTabB({
      page: mockPage6Inputs,
      otpCode: testOtp,
      timeoutMs: 500
    });
    assert.strictEqual(inputValues.join(''), testOtp, 'Ghép 6 ô input phải đúng bằng OTP đã truyền');
    console.log('  ✔ Nhập OTP vào 6 ô input riêng biệt chính xác.');
  }

  // 7.2: Trường hợp pin-digit là 6 div hiển thị và có 1 input ẩn (sr-only / one-time-code) trong nhóm
  {
    let filledVal = '';
    const mockPageGroupInput: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === '[data-slot="pin-digit"]') {
          return {
            count: async () => 6,
            nth: () => ({
              isVisible: async () => true
            }),
            first: () => ({
              evaluate: async () => 'div',
              locator: () => ({
                locator: () => ({
                  count: async () => 1,
                  first: () => ({
                    fill: async (v: string) => {
                      filledVal = v;
                    },
                    inputValue: async () => filledVal
                  })
                })
              })
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await enterOtpIntoTabB({
      page: mockPageGroupInput,
      otpCode: testOtp,
      timeoutMs: 500
    });
    assert.strictEqual(filledVal, testOtp, 'Input thực sự trong nhóm phải nhận toàn bộ OTP');
    console.log('  ✔ Xác định input thuộc cùng nhóm khi pin-digit là div hiển thị thành công.');
  }

  // 7.3: Trường hợp kiểm tra giá trị sau khi nhập không khớp -> Dừng và ném lỗi
  {
    const mockPageMismatch: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === '[data-slot="pin-digit"]') {
          return {
            count: async () => 1,
            nth: () => ({ isVisible: async () => true }),
            first: () => ({
              evaluate: async () => 'input',
              fill: async () => {},
              inputValue: async () => '999999' // Trả về sai
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let mismatchThrew = false;
    try {
      await enterOtpIntoTabB({
        page: mockPageMismatch,
        otpCode: testOtp,
        timeoutMs: 500
      });
    } catch (err: unknown) {
      mismatchThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI KIỂM TRA MÃ NHẬP]'), 'Phải báo lỗi kiểm tra không khớp');
      assert.ok(msg.includes('không bấm xác nhận'), 'Phải cam kết không bấm xác nhận');
    }
    assert.strictEqual(mismatchThrew, true, 'Phải dừng khi giá trị kiểm tra không khớp');
    console.log('  ✔ Từ chối bấm xác nhận và dừng ngay khi giá trị ô nhập không khớp OTP.');
  }

  // ==========================================
  // Test 8: Kiểm tra phát hiện và đóng popup với id="dismiss-button"
  // ==========================================
  console.log('\n8. Kiểm tra tự động phát hiện và đóng popup id="dismiss-button":');

  // 8.1: Khi có id="dismiss-button" hiển thị trên trang chính
  {
    let clickedMain = false;
    const mockPageMainDismiss: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel.includes('dismiss-button')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              click: async () => {
                clickedMain = true;
              },
              dispatchEvent: async () => {},
              evaluate: async () => {}
            })
          };
        }
        return { count: async () => 0 };
      },
      frames: () => []
    };

    const result = await dismissPopupIfPresent(mockPageMainDismiss, dummyLogger, { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
    assert.strictEqual(result, true, 'Phải trả về true khi đã đóng popup');
    assert.strictEqual(clickedMain, true, 'Phải click id="dismiss-button" trên trang chính');
    console.log('  ✔ Phát hiện và click id="dismiss-button" trên trang chính thành công.');
  }

  // 8.2: Khi có id="dismiss-button" hiển thị trong một iframe (Google Vignette ad)
  {
    let clickedFrame = false;
    const mockFrame: any = {
      name: () => 'ad_iframe',
      url: () => 'https://googleads.g.doubleclick.net/...',
      locator: (sel: string) => {
        if (sel.includes('dismiss-button')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              click: async () => {
                clickedFrame = true;
              },
              dispatchEvent: async () => {},
              evaluate: async () => {}
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const mockPageFrameDismiss: any = {
      isClosed: () => false,
      locator: () => ({ count: async () => 0 }),
      frames: () => [mockFrame]
    };

    const result = await dismissPopupIfPresent(mockPageFrameDismiss, dummyLogger, { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
    assert.strictEqual(result, true, 'Phải trả về true khi đã đóng popup trong frame');
    assert.strictEqual(clickedFrame, true, 'Phải click id="dismiss-button" trong iframe');
    console.log('  ✔ Phát hiện và click id="dismiss-button" trong iframe (Google Vignette) thành công.');
  }

  // 8.3: Khi không có popup hoặc id="dismiss-button" không hiển thị -> Không làm gì, trả về false, không ném lỗi
  {
    const mockPageNoDismiss: any = {
      isClosed: () => false,
      locator: () => ({ count: async () => 0 }),
      frames: () => []
    };

    const result = await dismissPopupIfPresent(mockPageNoDismiss, dummyLogger, { flow: 'yopmail-muse', step: 'tabA-extract-otp' });
    assert.strictEqual(result, false, 'Phải trả về false khi không có popup');
    console.log('  ✔ Tiếp tục an toàn khi không có popup ("nếu có, sau đó thực hiện tiếp").');
  }

  // 8.4: Khi page đã đóng -> Trả về false an toàn
  {
    const mockPageClosed: any = {
      isClosed: () => true
    };
    const result = await dismissPopupIfPresent(mockPageClosed);
    assert.strictEqual(result, false, 'Phải trả về false an toàn khi page đã đóng');
    console.log('  ✔ Xử lý an toàn khi page đã đóng.');
  }

  // ==========================================
  // Test 9: Kiểm tra cơ chế retry làm mới hộp thư (retry 3 lần, mỗi lần cách nhau 5s)
  // ==========================================
  console.log('\n9. Kiểm tra cơ chế retry làm mới hộp thư (retry 3 lần, mỗi lần cách nhau 5 giây):');

  // 9.1: Khi thư xuất hiện ở lần retry thứ 2
  {
    let currentEmailCount = 0;
    const retryCalls: number[] = [];

    const mockPageRetry: any = {
      isClosed: () => false,
      title: async () => 'YOPmail',
      frame: () => null,
      frames: () => [],
      locator: (sel: string) => {
        if (sel === 'button.lm') {
          return {
            count: async () => currentEmailCount,
            nth: () => ({
              isVisible: async () => true,
              innerText: async () => 'Muse.ai: Verification code'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const mailItem = await waitForSingleMatchingMailItem({
      page: mockPageRetry,
      tabName: 'TabA',
      stepName: 'tabA-extract-otp',
      maxRetries: 3,
      retryIntervalMs: 50, // Dùng 50ms trong unit test để chạy nhanh
      onRetry: async (retryIndex: number) => {
        retryCalls.push(retryIndex);
        if (retryIndex === 2) {
          // Xuất hiện thư ở lần retry thứ 2
          currentEmailCount = 1;
        }
      }
    });

    assert.ok(mailItem, 'Phải tìm thấy thư khi thư xuất hiện ở lần retry thứ 2');
    assert.strictEqual(retryCalls.length, 2, 'Phải retry đúng 2 lần trước khi thấy thư');
    assert.deepStrictEqual(retryCalls, [1, 2], 'Các lần retry phải theo thứ tự [1, 2]');
    console.log('  ✔ Thư xuất hiện ở lần retry thứ 2 được nhận diện thành công.');
  }

  // 9.2: Khi sau 3 lần retry vẫn không có thư -> Ném lỗi timeout rõ ràng
  {
    const retryCalls: number[] = [];

    const mockPageEmpty: any = {
      isClosed: () => false,
      title: async () => 'YOPmail',
      frame: () => null,
      frames: () => [],
      locator: () => ({ count: async () => 0 })
    };

    let retryExhaustedThrew = false;
    try {
      await waitForSingleMatchingMailItem({
        page: mockPageEmpty,
        tabName: 'TabA',
        stepName: 'tabA-extract-otp',
        maxRetries: 3,
        retryIntervalMs: 50,
        onRetry: async (retryIndex: number) => {
          retryCalls.push(retryIndex);
        }
      });
    } catch (err: unknown) {
      retryExhaustedThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI TIMEOUT]'), 'Phải báo lỗi timeout');
      assert.ok(msg.includes('retry 3 lần'), 'Phải thông báo đã retry 3 lần');
      assert.ok(msg.includes('cách nhau'), 'Phải thông báo khoảng thời gian cách nhau giữa các lần');
    }

    assert.strictEqual(retryExhaustedThrew, true, 'Phải ném lỗi khi hết 3 lần retry');
    assert.strictEqual(retryCalls.length, 3, 'Phải thực hiện đầy đủ 3 lần retry');
    assert.deepStrictEqual(retryCalls, [1, 2, 3], 'Các lần retry phải là [1, 2, 3]');
    console.log('  ✔ Ném lỗi timeout và dừng an toàn sau đúng 3 lần retry không có thư.');
  }

  // 9.3: Khi thư có sẵn ngay lần đầu -> Không gọi retry
  {
    const retryCalls: number[] = [];

    const mockPageImmediate: any = {
      isClosed: () => false,
      title: async () => 'YOPmail',
      frame: () => null,
      frames: () => [],
      locator: (sel: string) => {
        if (sel === 'button.lm') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              innerText: async () => 'Muse.ai: Verification code'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const mailItem = await waitForSingleMatchingMailItem({
      page: mockPageImmediate,
      tabName: 'TabA',
      stepName: 'tabA-extract-otp',
      maxRetries: 3,
      retryIntervalMs: 50,
      onRetry: async (retryIndex: number) => {
        retryCalls.push(retryIndex);
      }
    });

    assert.ok(mailItem, 'Phải tìm thấy thư ngay lập tức');
    assert.strictEqual(retryCalls.length, 0, 'Không được gọi retry khi đã có thư sẵn');
    console.log('  ✔ Lấy thư ngay lập tức ở lần đầu mà không cần retry.');
  }

  // ==========================================
  // Test 10: Kiểm tra chuyển tiêu điểm sang TabB trên UI sau khi lấy mã OTP
  // ==========================================
  console.log('\n10. Kiểm tra chuyển tiêu điểm sang TabB trên UI sau khi lấy mã OTP:');
  {
    let tabBBroughtToFront = false;
    let tabBWindowFocused = false;

    const mockTabB: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      bringToFront: async () => {
        tabBBroughtToFront = true;
      },
      evaluate: async (fn: any) => {
        tabBWindowFocused = true;
        return 'input';
      },
      locator: (sel: string) => {
        if (sel === '[data-slot="pin-digit"]') {
          return {
            count: async () => 1,
            nth: () => ({ isVisible: async () => true }),
            first: () => ({
              evaluate: async () => 'input',
              fill: async () => {},
              inputValue: async () => '123456'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await enterOtpIntoTabB({
      page: mockTabB,
      otpCode: '123456',
      timeoutMs: 500
    });

    assert.strictEqual(tabBBroughtToFront, true, 'TabB phải được đưa lên foreground bằng bringToFront');
    assert.strictEqual(tabBWindowFocused, true, 'TabB phải được focus window');
    console.log('  ✔ TabB được chuyển tiêu điểm chính (bringToFront & focus) trên UI thành công.');
  }

  console.log('\n--- TẤT CẢ BÀI KIỂM TRA YOPMAIL-MUSE (MỞ RỘNG OTP) ĐÃ VƯỢT QUA! ---');
}

runTests().catch((err) => {
  console.error('Lỗi khi chạy kiểm tra yopmail-muse:', err);
  process.exit(1);
});
