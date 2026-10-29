import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
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
  waitForProfileFormReady,
  inputFirstName,
  inputLastName,
  selectBirthYear,
  submitProfileBirthday,
  waitForMetaSecurityPageReady,
  findInteractiveButtonWithSpanText,
  selectSmsOrWhatsAppOption,
  inputPhoneNumberOnTabC,
  confirmAndClickNextButton,
  waitForVerificationCodeAndCloseDialog,
  yopmailMuseFlow
} from '../src/flows/yopmail-muse.flow';
import {
  readPhoneNumbersFromFile,
  selectRandomPhone,
  maskPhoneNumber,
  isPhoneEquivalent
} from '../src/utils/phone';
import { getFlow, getFlowOrThrow } from '../src/flows';
import { FlowContext } from '../src/runner/types';
import { runFlow } from '../src/runner';
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
  // Test 3: Kiểm tra Đăng ký Flow trong Registry (18 bước tuần tự mở rộng)
  // ==========================================
  console.log('\n3. Kiểm tra Flow Registry với luồng yopmail-muse mở rộng (18 bước):');
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
    'tabB-submit-otp',
    'tabB-wait-profile-form',
    'tabB-input-first-name',
    'tabB-input-last-name',
    'tabB-select-year',
    'tabB-submit-profile',
    'tabC-open-meta-security',
    'tabC-click-two-factor',
    'tabC-click-start',
    'tabC-select-sms-whatsapp',
    'tabC-click-continue',
    'tabC-input-phone',
    'tabC-confirm-and-next',
    'tabC-verify-and-close-dialog'
  ]);
  console.log(`  ✔ Luồng đã đăng ký thành công với 18 bước tuần tự: [${stepIds.join(', ')}].`);

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

  // ==========================================
  // Test 11: Kiểm tra chờ form thông tin sẵn sàng (waitForProfileFormReady)
  // ==========================================
  console.log('\n11. Kiểm tra chờ form thông tin cá nhân sẵn sàng:');
  {
    // 11.1: Thành công khi input[aria-label="First name"] hiển thị và editable
    const mockPageFormReady: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai - Profile',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const loc = await waitForProfileFormReady({
      page: mockPageFormReady,
      stepName: 'tabB-wait-profile-form',
      timeoutMs: 1000
    });
    assert.ok(loc, 'Phải tìm thấy input First name');
    console.log('  ✔ Chờ form thông tin sẵn sàng bằng điều kiện DOM thành công.');

    // 11.2: Timeout ném lỗi và không tự bấm lại nút xác nhận OTP
    const mockPageFormTimeout: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: () => ({ count: async () => 0 })
    };

    let timeoutThrew = false;
    try {
      await waitForProfileFormReady({
        page: mockPageFormTimeout,
        stepName: 'tabB-wait-profile-form',
        timeoutMs: 300
      });
    } catch (err) {
      timeoutThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI CHỜ FORM THÔNG TIN]'), 'Phải báo lỗi tại bước chờ form thông tin');
      assert.ok(msg.includes('KHÔNG tự động bấm lại nút xác nhận OTP'), 'Phải cam kết không tự bấm lại nút OTP');
    }
    assert.strictEqual(timeoutThrew, true, 'Phải ném lỗi khi form không xuất hiện');
    console.log('  ✔ Timeout form ném lỗi dừng luồng tại bước chờ form và không tự bấm lại OTP.');
  }

  // ==========================================
  // Test 12: Kiểm tra nhập First name: "Dang" (inputFirstName)
  // ==========================================
  console.log('\n12. Kiểm tra nhập First name "Dang":');
  {
    let clicked = false;
    let storedValue = '';

    const mockPageFirstName: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {
                clicked = true;
              },
              fill: async (val: string) => {
                storedValue = val;
              },
              inputValue: async () => storedValue
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await inputFirstName({
      page: mockPageFirstName,
      stepName: 'tabB-input-first-name',
      firstName: 'Dang',
      timeoutMs: 1000
    });

    assert.strictEqual(clicked, true, 'Phải click vào ô input');
    assert.strictEqual(storedValue, 'Dang', 'Giá trị phải đúng bằng "Dang"');
    console.log('  ✔ Nhập First name "Dang" và xác minh giá trị thành công.');

    // 12.2: Lỗi không khớp giá trị -> dừng không chuyển bước
    const mockPageFirstNameMismatch: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              fill: async () => {},
              inputValue: async () => 'SaiTen'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let mismatchThrew = false;
    try {
      await inputFirstName({
        page: mockPageFirstNameMismatch,
        stepName: 'tabB-input-first-name',
        firstName: 'Dang',
        timeoutMs: 500
      });
    } catch (err) {
      mismatchThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI GIÁ TRỊ FIRST NAME]'));
      assert.ok(msg.includes('không chuyển sang bước tiếp theo'));
    }
    assert.strictEqual(mismatchThrew, true, 'Phải ném lỗi khi giá trị không khớp');
    console.log('  ✔ Dừng luồng và không chuyển bước khi First name không khớp.');
  }

  // ==========================================
  // Test 13: Kiểm tra nhập Last name: "Dao" (inputLastName)
  // ==========================================
  console.log('\n13. Kiểm tra nhập Last name "Dao":');
  {
    let clicked = false;
    let storedValue = '';

    const mockPageLastName: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="Last name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {
                clicked = true;
              },
              fill: async (val: string) => {
                storedValue = val;
              },
              inputValue: async () => storedValue
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await inputLastName({
      page: mockPageLastName,
      stepName: 'tabB-input-last-name',
      lastName: 'Dao',
      timeoutMs: 1000
    });

    assert.strictEqual(clicked, true, 'Phải click vào ô input');
    assert.strictEqual(storedValue, 'Dao', 'Giá trị phải đúng bằng "Dao"');
    console.log('  ✔ Nhập Last name "Dao" và xác minh giá trị thành công.');

    // 13.2: Lỗi không khớp giá trị -> dừng không chuyển bước
    const mockPageLastNameMismatch: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="Last name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              fill: async () => {},
              inputValue: async () => 'SaiHo'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let mismatchThrew = false;
    try {
      await inputLastName({
        page: mockPageLastNameMismatch,
        stepName: 'tabB-input-last-name',
        lastName: 'Dao',
        timeoutMs: 500
      });
    } catch (err) {
      mismatchThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI GIÁ TRỊ LAST NAME]'));
      assert.ok(msg.includes('không chuyển sang bước tiếp theo'));
    }
    assert.strictEqual(mismatchThrew, true, 'Phải ném lỗi khi giá trị không khớp');
    console.log('  ✔ Dừng luồng và không chuyển bước khi Last name không khớp.');
  }

  // ==========================================
  // Test 14: Kiểm tra chọn Year 2000 (selectBirthYear)
  // ==========================================
  console.log('\n14. Kiểm tra chọn Year 2000 qua select[aria-label="Year"]:');
  {
    let selectedOptionVal = '';

    // 14.1: Thẻ select HTML gốc hợp lệ
    const mockPageYearValid: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'select[aria-label="Year"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              evaluate: async () => 'select',
              locator: (subSel: string) => {
                if (subSel === 'option[value="2000"]') {
                  return {
                    count: async () => 1,
                    first: () => ({
                      innerText: async () => '2000'
                    })
                  };
                }
                return { count: async () => 0 };
              },
              selectOption: async (opt: { value: string }) => {
                selectedOptionVal = opt.value;
              },
              inputValue: async () => selectedOptionVal
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await selectBirthYear({
      page: mockPageYearValid,
      stepName: 'tabB-select-year',
      yearValue: '2000',
      timeoutMs: 1000
    });

    assert.strictEqual(selectedOptionVal, '2000', 'Giá trị đã chọn phải là 2000');
    console.log('  ✔ Chọn option value="2000" với selectOption() và xác minh thành công.');

    // 14.2: Thiếu option value="2000"
    const mockPageMissingOption: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'select[aria-label="Year"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              evaluate: async () => 'select',
              locator: () => ({ count: async () => 0 }) // Không có option 2000
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let missingOptionThrew = false;
    try {
      await selectBirthYear({
        page: mockPageMissingOption,
        stepName: 'tabB-select-year',
        yearValue: '2000',
        timeoutMs: 500
      });
    } catch (err) {
      missingOptionThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI OPTION YEAR]'));
      assert.ok(msg.includes('không có option "option[value="2000"]"'));
    }
    assert.strictEqual(missingOptionThrew, true, 'Phải ném lỗi khi thiếu option 2000');
    console.log('  ✔ Ném lỗi dừng luồng khi selectbox không có option value="2000".');

    // 14.3: Select bị disabled
    const mockPageDisabledSelect: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'select[aria-label="Year"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => false // Disabled
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let disabledThrew = false;
    try {
      await selectBirthYear({
        page: mockPageDisabledSelect,
        stepName: 'tabB-select-year',
        yearValue: '2000',
        timeoutMs: 500
      });
    } catch (err) {
      disabledThrew = true;
      assert.ok((err as Error).message.includes('[LỖI SELECT YEAR]'));
    }
    assert.strictEqual(disabledThrew, true);
    console.log('  ✔ Ném lỗi dừng luồng khi selectbox Year bị vô hiệu hóa.');

    // 14.4: Không phải select HTML gốc và không xác định được cấu trúc chắc chắn
    const mockPageNonSelectUnknown: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'select[aria-label="Year"]') return { count: async () => 0 };
        if (sel === '[aria-label="Year"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              evaluate: async () => 'div', // Thẻ div lạ
              getAttribute: async () => null
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let nonSelectThrew = false;
    try {
      await selectBirthYear({
        page: mockPageNonSelectUnknown,
        stepName: 'tabB-select-year',
        yearValue: '2000',
        timeoutMs: 500
      });
    } catch (err) {
      nonSelectThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI CẤU TRÚC ĐIỀU KHIỂN YEAR]'));
      assert.ok(msg.includes('Không gọi selectOption() lên div/button'));
    }
    assert.strictEqual(nonSelectThrew, true);
    console.log('  ✔ Từ chối gọi selectOption lên div/button khi cấu trúc không xác định chắc chắn.');
  }

  // ==========================================
  // Test 15: Kiểm tra nút tiếp tục (submitProfileBirthday)
  // ==========================================
  console.log('\n15. Kiểm tra nút tiếp tục login_birthday_continue_click:');
  {
    let clickCount = 0;
    let loggedMessages: string[] = [];

    const mockLogger: any = {
      info: (msg: string) => loggedMessages.push(msg),
      warn: () => {},
      error: () => {},
      stepResult: () => {}
    };

    // 15.1: Thực hiện thành công khi đủ 3 điều kiện và nút enabled
    const mockPageSubmitSuccess: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') {
          return { inputValue: async () => 'Dang' };
        }
        if (sel === 'input[aria-label="Last name"]') {
          return { inputValue: async () => 'Dao' };
        }
        if (sel.includes('Year')) {
          return { inputValue: async () => '2000' };
        }
        if (sel === '[data-pel-click="login_birthday_continue_click"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                clickCount++;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await submitProfileBirthday({
      page: mockPageSubmitSuccess,
      stepName: 'tabB-submit-profile',
      timeoutMs: 1000,
      logger: mockLogger
    });

    assert.strictEqual(clickCount, 1, 'Nút tiếp tục phải được bấm ĐÚNG MỘT LẦN');
    assert.ok(
      loggedMessages.some((m) => m.includes('Đã nhập Dang, Dao, chọn năm 2000 và bấm tiếp tục.')),
      'Phải thông báo đúng thông điệp theo yêu cầu'
    );
    console.log('  ✔ Bấm nút tiếp tục đúng một lần và ghi nhận thông điệp chuẩn xác.');

    // 15.2: Kiểm tra khi First name / Last name / Year chưa đúng -> từ chối bấm
    const mockPageWrongField: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') {
          return { inputValue: async () => 'WrongName' };
        }
        return { inputValue: async () => '' };
      }
    };

    let wrongFieldThrew = false;
    try {
      await submitProfileBirthday({
        page: mockPageWrongField,
        stepName: 'tabB-submit-profile',
        timeoutMs: 500
      });
    } catch (err) {
      wrongFieldThrew = true;
      assert.ok((err as Error).message.includes('[LỖI XÁC MINH TRƯỚC BẤM TIẾP TỤC]'));
    }
    assert.strictEqual(wrongFieldThrew, true);
    console.log('  ✔ Từ chối bấm tiếp tục nếu First name, Last name hoặc Year chưa khớp.');

    // 15.3: Nút tiếp tục bị vô hiệu hóa (disabled) -> không force click, báo lỗi
    const mockPageBtnDisabled: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') return { inputValue: async () => 'Dang' };
        if (sel === 'input[aria-label="Last name"]') return { inputValue: async () => 'Dao' };
        if (sel.includes('Year')) return { inputValue: async () => '2000' };
        if (sel.includes('Month')) return { count: async () => 1 }; // Form yêu cầu thêm Month
        if (sel === '[data-pel-click="login_birthday_continue_click"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => false // Disabled!
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let btnDisabledThrew = false;
    try {
      await submitProfileBirthday({
        page: mockPageBtnDisabled,
        stepName: 'tabB-submit-profile',
        timeoutMs: 500
      });
    } catch (err) {
      btnDisabledThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI NÚT TIẾP TỤC BỊ VÔ HIỆU HÓA]'));
      assert.ok(msg.includes('Không dùng force: true'));
      assert.ok(msg.includes('Month'), 'Phải chỉ ra trường còn thiếu Month');
    }
    assert.strictEqual(btnDisabledThrew, true);
    console.log('  ✔ Từ chối force click khi nút tiếp tục bị vô hiệu hóa và chỉ rõ trường thiếu.');
  }

  // ==========================================
  // Test 16: Kiểm tra selector mơ hồ (nhiều hơn 1 phần tử hiển thị)
  // ==========================================
  console.log('\n16. Kiểm tra xử lý selector mơ hồ (nhiều hơn 1 phần tử hiển thị):');
  {
    const mockPageAmbiguous: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') {
          return {
            count: async () => 2, // 2 phần tử hiển thị!
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let ambThrew = false;
    try {
      await inputFirstName({
        page: mockPageAmbiguous,
        stepName: 'tabB-input-first-name',
        timeoutMs: 500
      });
    } catch (err) {
      ambThrew = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI SELECTOR]'));
      assert.ok(msg.includes('khớp 2 phần tử hiển thị'));
    }
    assert.strictEqual(ambThrew, true);
    console.log('  ✔ Từ chối dùng .first() và dừng luồng khi selector mơ hồ.');
  }

  // ==========================================
  // Test 17: Thực thi toàn bộ 10 bước của yopmail-muse qua Sequential Runner
  // ==========================================
  console.log('\n17. Kiểm tra thực thi toàn bộ luồng 10 bước qua Sequential Runner:');
  {
    let tabAEntered = false;
    let tabBCreated = false;
    let continueBtnClicked = false;
    let formValues: Record<string, string> = {};

    const mockTabA: any = {
      isClosed: () => false,
      title: async () => 'YOPmail',
      goto: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      bringToFront: async () => {},
      locator: (sel: string) => {
        if (sel === 'input.ycptinput') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              fill: async () => {},
              inputValue: async () => 'mockmailbox123',
              press: async () => {
                tabAEntered = true;
              }
            })
          };
        }
        if (sel === 'button#refresh') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === 'button.lm') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              locator: () => ({
                count: async () => 1,
                first: () => ({
                  innerText: async () => 'Muse.ai Login OTP'
                })
              })
            })
          };
        }
        return { count: async () => 0 };
      },
      frames: () => [
        {
          name: () => 'ifinbox',
          locator: (sel: string) => {
            if (sel === 'button.lm') {
              return {
                count: async () => 1,
                nth: () => ({
                  isVisible: async () => true,
                  isEnabled: async () => true,
                  click: async () => {},
                  locator: () => ({
                    count: async () => 1,
                    first: () => ({
                      innerText: async () => 'Muse.ai Login OTP'
                    })
                  })
                })
              };
            }
            return { count: async () => 0 };
          }
        },
        {
          name: () => 'ifmail',
          evaluate: async () => ['654321'],
          locator: (sel: string) => {
            if (sel.includes('letter-spacing: 2px') || sel === 'div') {
              return {
                count: async () => 1,
                nth: () => ({
                  isVisible: async () => true,
                  getAttribute: async (attr: string) => (attr === 'style' ? 'font-size: 24px; letter-spacing: 2px; padding: 16px;' : ''),
                  innerText: async () => '654321'
                })
              };
            }
            return { count: async () => 0 };
          }
        }
      ],
      frame: (opts: any) => {
        const name = typeof opts === 'string' ? opts : opts?.name;
        if (name === 'ifmail') {
          return {
            name: () => 'ifmail',
            evaluate: async () => ['654321'],
            locator: (sel: string) => ({
              count: async () => 1,
              nth: () => ({
                isVisible: async () => true,
                getAttribute: async (attr: string) => (attr === 'style' ? 'font-size: 24px; letter-spacing: 2px; padding: 16px;' : ''),
                innerText: async () => '654321'
              })
            })
          };
        }
        return null;
      }
    };

    const mockTabB: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      goto: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      bringToFront: async () => {},
      evaluate: async () => 'input',
      locator: (sel: string) => {
        if (sel === 'input[data-slot="input"]' || sel === 'input[aria-label="Email"]') {
          const item = {
            isVisible: async () => true,
            isEditable: async () => true,
            isEnabled: async () => true,
            fill: async () => {},
            inputValue: async () => 'mockmailbox123@yopmail.com'
          };
          return {
            count: async () => 1,
            nth: () => item,
            first: () => item
          };
        }
        if (
          sel === '[data-pel-click="login_contact_continue_click"]' ||
          sel === '[data-pel-click="login_submit_click"]'
        ) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === '[data-slot="pin-digit"]') {
          return {
            count: async () => 1,
            nth: () => ({ isVisible: async () => true }),
            first: () => ({
              evaluate: async () => 'input',
              fill: async () => {},
              inputValue: async () => '654321'
            })
          };
        }
        if (sel === '[data-pel-click="login_otp_confirm_click"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === 'input[aria-label="First name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              fill: async (v: string) => {
                formValues['firstName'] = v;
              },
              inputValue: async () => formValues['firstName'] || 'Dang'
            }),
            inputValue: async () => formValues['firstName'] || 'Dang'
          };
        }
        if (sel === 'input[aria-label="Last name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              fill: async (v: string) => {
                formValues['lastName'] = v;
              },
              inputValue: async () => formValues['lastName'] || 'Dao'
            }),
            inputValue: async () => formValues['lastName'] || 'Dao'
          };
        }
        if (sel === 'select[aria-label="Year"]' || sel.includes('Year')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              evaluate: async () => 'select',
              locator: () => ({
                count: async () => 1,
                first: () => ({ innerText: async () => '2000' })
              }),
              selectOption: async () => {
                formValues['year'] = '2000';
              },
              inputValue: async () => formValues['year'] || '2000'
            }),
            inputValue: async () => formValues['year'] || '2000'
          };
        }
        if (sel === '[data-pel-click="login_birthday_continue_click"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                continueBtnClicked = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let newPageCount = 0;
    let tabCCreated = false;
    let tabCClickedTwoFactor = false;
    let tabCClickedStart = false;
    let tabCSelectedSms = false;
    let tabCClickedContinue = false;
    let tabCPhoneEntered = '';
    let tabCClickedNext = false;
    let tabCClosedDialog = false;

    const mockTabC: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      goto: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      bringToFront: async () => {},
      evaluate: async () => 'div',
      locator: (sel: string) => {
        if (sel === '[aria-label="Xác thực 2 yếu tố"]') {
          const item = {
            isVisible: async () => true,
            isEnabled: async () => true,
            click: async () => {
              tabCClickedTwoFactor = true;
            }
          };
          return {
            count: async () => 1,
            nth: () => item,
            first: () => item
          };
        }
        if (sel === '[role="dialog"]' || sel === 'div[aria-modal="true"]') {
          return {
            count: async () => 1,
            nth: () => mockTabC
          };
        }
        if (sel === '[aria-label="SMS hoặc WhatsApp"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              evaluate: async () => 'div',
              getAttribute: async (attr: string) => (attr === 'aria-checked' ? 'true' : ''),
              locator: () => ({ count: async () => 0 }),
              click: async () => {
                tabCSelectedSms = true;
              }
            })
          };
        }
        if (sel === 'span') {
          return {
            count: async () => 3,
            filter: (filterOpts: { hasText?: RegExp }) => {
              const regex = filterOpts?.hasText;
              const matches: string[] = [];
              if (regex?.test('Bắt đầu')) matches.push('Bắt đầu');
              if (regex?.test('Tiếp tục')) matches.push('Tiếp tục');
              if (regex?.test('Tiếp')) matches.push('Tiếp');

              return {
                count: async () => matches.length,
                nth: (idx: number) => {
                  const matchedText = matches[idx] || '';
                  return {
                    isVisible: async () => true,
                    innerText: async () => matchedText,
                    textContent: async () => matchedText,
                    locator: () => ({
                      count: async () => 1,
                      first: () => ({
                        isVisible: async () => true,
                        isEnabled: async () => true,
                        click: async () => {
                          if (matchedText === 'Bắt đầu') tabCClickedStart = true;
                          if (matchedText === 'Tiếp tục') tabCClickedContinue = true;
                          if (matchedText === 'Tiếp') tabCClickedNext = true;
                        }
                      })
                    })
                  };
                }
              };
            },
            nth: (i: number) => {
              const texts = ['Bắt đầu', 'Tiếp tục', 'Tiếp'];
              const text = texts[i] || '';
              return {
                isVisible: async () => true,
                innerText: async () => text,
                textContent: async () => text,
                locator: () => ({
                  count: async () => 1,
                  first: () => ({
                    isVisible: async () => true,
                    isEnabled: async () => true,
                    click: async () => {
                      if (text === 'Bắt đầu') tabCClickedStart = true;
                      if (text === 'Tiếp tục') tabCClickedContinue = true;
                      if (text === 'Tiếp') tabCClickedNext = true;
                    }
                  })
                })
              };
            }
          };
        }
        if (sel === 'input[type="tel"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              fill: async (v: string) => {
                tabCPhoneEntered = v;
              },
              inputValue: async () => tabCPhoneEntered
            })
          };
        }
        if (sel.includes('Nhập mã xác nhận')) {
          return {
            count: async () => 1,
            first: () => ({
              isVisible: async () => !tabCClosedDialog
            }),
            nth: () => ({
              isVisible: async () => !tabCClosedDialog
            })
          };
        }
        if (sel === '[aria-label="Đóng"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => !tabCClosedDialog,
              isEnabled: async () => true,
              click: async () => {
                tabCClosedDialog = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      },
      getByRole: (role: string, opts?: any) => {
        if (role === 'button') {
          const name = opts?.name;
          if (name === 'Bắt đầu' || name === 'Tiếp tục' || name === 'Tiếp') {
            return {
              count: async () => 1,
              nth: () => ({
                isVisible: async () => true,
                isEnabled: async () => true,
                click: async () => {
                  if (name === 'Bắt đầu') tabCClickedStart = true;
                  if (name === 'Tiếp tục') tabCClickedContinue = true;
                  if (name === 'Tiếp') tabCClickedNext = true;
                }
              })
            };
          }
        }
        return { count: async () => 0 };
      }
    };

    const mockBrowserContext: any = {
      newPage: async () => {
        newPageCount++;
        if (newPageCount === 1) {
          return mockTabA;
        }
        if (newPageCount === 2) {
          tabBCreated = true;
          return mockTabB;
        }
        tabCCreated = true;
        return mockTabC;
      }
    };

    mockTabA.context = () => mockBrowserContext;
    mockTabB.context = () => mockBrowserContext;
    mockTabC.context = () => mockBrowserContext;

    const fullTestContext: FlowContext = {
      page: mockTabA,
      config: {
        startUrl: 'https://example.com',
        profileDir: 'profiles/test',
        selectedProfile: {
          profileName: 'test',
          userDataDir: 'profiles/test',
          profileDirectory: 'Default',
          fullPath: 'profiles/test/Default',
          cdpPort: 9222
        },
        navigationTimeoutMs: 10000,
        actionTimeoutMs: 5000,
        flowName: 'yopmail-muse',
        screenshotOnError: false,
        initialConnectionMode: 'direct',
        proxy: { enabled: false },
        phoneNumbersFile: path.resolve(projectRoot, 'phone-numbers.example.txt'),
        phoneMode: 'mock'
      },
      runId: 'test-full-18-steps-run',
      logger: dummyLogger,
      data: {
        mailboxName: 'mockmailbox123',
        emailAddress: 'mockmailbox123@yopmail.com'
      }
    };

    const flowResult = await runFlow(yopmailMuseFlow, fullTestContext, projectRoot);

    assert.strictEqual(flowResult.status, 'success', 'Luồng 18 bước phải chạy thành công');
    assert.strictEqual(flowResult.completedSteps.length, 18, 'Phải hoàn thành đủ 18 bước tuần tự');
    assert.strictEqual(continueBtnClicked, true, 'Nút tiếp tục trên TabB phải được bấm');
    assert.strictEqual(tabCCreated, true, 'TabC phải được tạo trong cùng browser context');
    assert.strictEqual(tabCClickedTwoFactor, true, 'Phải click Xác thực 2 yếu tố trên TabC');
    assert.strictEqual(tabCClickedStart, true, 'Phải click Bắt đầu trên TabC');
    assert.strictEqual(tabCSelectedSms, true, 'Phải chọn SMS hoặc WhatsApp trên TabC');
    assert.strictEqual(tabCClickedContinue, true, 'Phải click Tiếp tục trên TabC');
    assert.ok(tabCPhoneEntered.length >= 7, 'Phải nhập số điện thoại hợp lệ');
    assert.strictEqual(tabCClickedNext, true, 'Phải click Tiếp trên TabC');
    assert.strictEqual(tabCClosedDialog, true, 'Phải click Đóng dialog sau khi màn hình mã xác nhận hiển thị');
    console.log('  ✔ Toàn bộ 18 bước của luồng yopmail-muse đã chạy tuần tự qua Sequential Runner thành công 100%.');
  }

  // ==========================================
  // Test 18: Đọc TXT có UTF-8 BOM, CRLF, dòng trống và dòng trùng lặp
  // ==========================================
  console.log('\n18. Kiểm tra đọc TXT có UTF-8 BOM, CRLF, dòng trống và trùng lặp:');
  {
    const scratchDir = path.resolve(projectRoot, 'tests', 'scratch');
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }

    const testFilePath = path.join(scratchDir, 'test-bom-crlf-phones.txt');
    // Nội dung có BOM \uFEFF, CRLF \r\n, khoảng trắng và dòng trùng
    const testContent = '\uFEFF  +84901234567  \r\n\r\n0987654321\r\n  +84901234567  \r\n+84912345678\r\n\r\n';
    fs.writeFileSync(testFilePath, testContent, 'utf-8');

    const result = readPhoneNumbersFromFile(testFilePath);

    assert.strictEqual(result.length, 3, 'Phải lọc đúng 3 số duy nhất');
    assert.strictEqual(result[0], '+84901234567', 'Số thứ nhất bảo toàn dấu + và trim khoảng trắng');
    assert.strictEqual(result[1], '0987654321', 'Số thứ hai bảo toàn số 0 ở đầu');
    assert.strictEqual(result[2], '+84912345678', 'Số thứ ba');
    console.log('  ✔ Đọc file UTF-8 với BOM, CRLF, loại bỏ dòng trống và dòng trùng thành công.');
  }

  // ==========================================
  // Test 19: Bảo toàn dấu + và số 0 ở đầu dưới dạng chuỗi
  // ==========================================
  console.log('\n19. Kiểm tra bảo toàn dấu + và số 0 ở đầu dạng string:');
  {
    const scratchDir = path.resolve(projectRoot, 'tests', 'scratch');
    const testFilePath = path.join(scratchDir, 'test-preserve-prefix.txt');
    fs.writeFileSync(testFilePath, '+1234567890\n009876543210\n0123456789\n', 'utf-8');

    const result = readPhoneNumbersFromFile(testFilePath);
    assert.strictEqual(typeof result[0], 'string');
    assert.strictEqual(result[0], '+1234567890', 'Bảo toàn dấu + ở đầu');
    assert.strictEqual(result[1], '009876543210', 'Bảo toàn nhiều số 0 ở đầu');
    assert.strictEqual(result[2], '0123456789', 'Bảo toàn số 0 ở đầu');
    console.log('  ✔ Bảo toàn kiểu string, dấu + và các số 0 ở đầu thành công 100%.');
  }

  // ==========================================
  // Test 20: Xử lý thiếu file, file rỗng, và dòng không hợp lệ
  // ==========================================
  console.log('\n20. Kiểm tra xử lý thiếu file, file rỗng, và dòng không hợp lệ:');
  {
    const scratchDir = path.resolve(projectRoot, 'tests', 'scratch');

    // 20.1: Thiếu file
    let missingThrew = false;
    try {
      readPhoneNumbersFromFile(path.join(scratchDir, 'non-existent-phone-file.txt'));
    } catch (err) {
      missingThrew = true;
      assert.ok((err as Error).message.includes('[LỖI FILE SỐ ĐIỆN THOẠI]'));
    }
    assert.strictEqual(missingThrew, true, 'Phải ném lỗi khi thiếu file');

    // 20.2: File rỗng
    const emptyFilePath = path.join(scratchDir, 'test-empty-phones.txt');
    fs.writeFileSync(emptyFilePath, '   \n\r\n   ', 'utf-8');
    let emptyThrew = false;
    try {
      readPhoneNumbersFromFile(emptyFilePath);
    } catch (err) {
      emptyThrew = true;
      assert.ok((err as Error).message.includes('rỗng hoặc không chứa số điện thoại'));
    }
    assert.strictEqual(emptyThrew, true, 'Phải ném lỗi khi file rỗng');

    // 20.3: Dòng không hợp lệ (chứa chữ cái hoặc ký tự lạ)
    const invalidFilePath = path.join(scratchDir, 'test-invalid-phones.txt');
    fs.writeFileSync(invalidFilePath, '+84901234567\n0987abc321\n', 'utf-8');
    let invalidThrew = false;
    try {
      readPhoneNumbersFromFile(invalidFilePath);
    } catch (err) {
      invalidThrew = true;
      assert.ok((err as Error).message.includes('[LỖI ĐỊNH DẠNG SỐ ĐIỆN THOẠI]'));
    }
    assert.strictEqual(invalidThrew, true, 'Phải ném lỗi khi có dòng không hợp lệ');

    console.log('  ✔ Xử lý thiếu file, file rỗng và dữ liệu không hợp lệ an toàn, dừng luồng.');
  }

  // ==========================================
  // Test 21: Chọn đúng một số ngẫu nhiên và bảo toàn số trong bộ nhớ
  // ==========================================
  console.log('\n21. Kiểm tra chọn ngẫu nhiên đúng 1 số và bảo toàn số:');
  {
    const phoneList = ['+84901111111', '+84902222222', '+84903333333'];
    const chosen = selectRandomPhone(phoneList);
    assert.ok(phoneList.includes(chosen), 'Số được chọn phải nằm trong danh sách');

    const chosen2 = selectRandomPhone(phoneList);
    assert.ok(phoneList.includes(chosen2));

    console.log(`  ✔ Chọn ngẫu nhiên đúng một số ("${maskPhoneNumber(chosen)}") thành công.`);
  }

  // ==========================================
  // Test 22: Phân biệt nút chứa span "Tiếp" với nút chứa span "Tiếp tục"
  // ==========================================
  console.log('\n22. Kiểm tra phân biệt chính xác nút chứa "Tiếp" vs "Tiếp tục":');
  {
    let clickedButton = '';

    const mockPageButtons: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === 'span') {
          return {
            count: async () => 2,
            filter: (opts: { hasText?: RegExp }) => {
              const regex = opts?.hasText;
              const matches: string[] = [];
              if (regex?.test('Tiếp tục')) matches.push('Tiếp tục');
              if (regex?.test('Tiếp')) matches.push('Tiếp');

              return {
                count: async () => matches.length,
                nth: (i: number) => {
                  const txt = matches[i];
                  return {
                    isVisible: async () => true,
                    innerText: async () => txt,
                    textContent: async () => txt,
                    locator: () => ({
                      count: async () => 1,
                      first: () => ({
                        isVisible: async () => true,
                        isEnabled: async () => true,
                        click: async () => {
                          clickedButton = txt;
                        }
                      })
                    })
                  };
                }
              };
            }
          };
        }
        return { count: async () => 0 };
      },
      getByRole: () => ({ count: async () => 0 })
    };

    // 22.1: Tìm nút "Tiếp" -> Phải bấm nút chứa "Tiếp", KHÔNG bấm "Tiếp tục"
    const nextBtn = await findInteractiveButtonWithSpanText({
      page: mockPageButtons,
      targetText: 'Tiếp',
      tabName: 'TabC',
      stepName: 'test-button-tiep',
      timeoutMs: 1000
    });
    await nextBtn.click();
    assert.strictEqual(clickedButton, 'Tiếp', 'Phải bấm đúng nút "Tiếp"');

    // 22.2: Tìm nút "Tiếp tục" -> Phải bấm nút chứa "Tiếp tục"
    const continueBtn = await findInteractiveButtonWithSpanText({
      page: mockPageButtons,
      targetText: 'Tiếp tục',
      tabName: 'TabC',
      stepName: 'test-button-tiep-tuc',
      timeoutMs: 1000
    });
    await continueBtn.click();
    assert.strictEqual(clickedButton, 'Tiếp tục', 'Phải bấm đúng nút "Tiếp tục"');

    console.log('  ✔ Phân biệt chính xác giữa span "Tiếp" và span "Tiếp tục", không bấm nhầm.');
  }

  // ==========================================
  // Test 23: Mock mode không gửi mã thật; Live mode dừng khi chưa xác nhận
  // ==========================================
  console.log('\n23. Kiểm tra chế độ chạy Mock vs Live:');
  {
    let nextClickedInMock = false;
    const mockPageNext: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === 'span') {
          return {
            count: async () => 1,
            filter: () => ({
              count: async () => 1,
              nth: () => ({
                isVisible: async () => true,
                innerText: async () => 'Tiếp',
                textContent: async () => 'Tiếp',
                locator: () => ({
                  count: async () => 1,
                  first: () => ({
                    isVisible: async () => true,
                    isEnabled: async () => true,
                    click: async () => {
                      nextClickedInMock = true;
                    }
                  })
                })
              })
            })
          };
        }
        return { count: async () => 0 };
      },
      getByRole: () => ({ count: async () => 0 })
    };

    // 23.1: Mock mode không đòi hỏi terminal TTY
    await confirmAndClickNextButton({
      page: mockPageNext,
      stepName: 'tabC-confirm-and-next',
      phone: '+84901234567',
      phoneMode: 'mock',
      timeoutMs: 1000
    });
    assert.strictEqual(nextClickedInMock, true, 'Mock mode click Tiếp mà không gửi SMS thật');

    // 23.2: Live mode dừng khi không có xác nhận
    let liveThrew = false;
    try {
      await confirmAndClickNextButton({
        page: mockPageNext,
        stepName: 'tabC-confirm-and-next',
        phone: '+84901234567',
        phoneMode: 'live',
        timeoutMs: 100
      });
    } catch (err) {
      liveThrew = true;
      assert.ok((err as Error).message.includes('[HỦY BỎ BẢO MẬT LIVE MODE]'));
    }
    assert.strictEqual(liveThrew, true, 'Live mode phải dừng an toàn khi người dùng chưa xác nhận');

    console.log('  ✔ Mock mode không gửi mã thật; Live mode dừng an toàn khi thiếu xác nhận.');
  }

  // ==========================================
  // Test 24: Nhập số điện thoại, kiểm tra isPhoneEquivalent
  // ==========================================
  console.log('\n24. Kiểm tra so sánh số tương đương (tự định dạng) và nhập số:');
  {
    assert.strictEqual(isPhoneEquivalent('+84 90 123 4567', '+84901234567'), true);
    assert.strictEqual(isPhoneEquivalent('+84-90-123-4567', '+84901234567'), true);
    assert.strictEqual(isPhoneEquivalent('(090) 123 4567', '0901234567'), true);
    assert.strictEqual(isPhoneEquivalent('+84901111111', '+84902222222'), false);

    let enteredVal = '';
    const mockPageTel: any = {
      isClosed: () => false,
      title: async () => 'Test Title',
      locator: (sel: string) => {
        if (sel === 'input[type="tel"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              fill: async (val: string) => {
                enteredVal = val;
              },
              inputValue: async () => enteredVal
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await inputPhoneNumberOnTabC({
      page: mockPageTel,
      stepName: 'tabC-input-phone',
      phone: '+84901234567',
      timeoutMs: 1000
    });
    assert.strictEqual(enteredVal, '+84901234567', 'Giá trị nhập phải khớp');
    console.log('  ✔ Kiểm tra số điện thoại tương đương và nhập input[type="tel"] thành công.');
  }

  // ==========================================
  // Test 25: Màn hình "Nhập mã xác nhận" hiển thị rồi mới bấm nút Đóng
  // ==========================================
  console.log('\n25. Kiểm tra chỉ bấm Đóng sau khi màn hình mã xác nhận hiển thị:');
  {
    // 25.1: Màn hình không xuất hiện -> ném lỗi timeout và KHÔNG bấm Đóng
    const mockPageNoCodeScreen: any = {
      isClosed: () => false,
      locator: () => ({ count: async () => 0 })
    };

    let noCodeThrew = false;
    try {
      await waitForVerificationCodeAndCloseDialog({
        page: mockPageNoCodeScreen,
        stepName: 'tabC-verify-and-close-dialog',
        timeoutMs: 400
      });
    } catch (err) {
      noCodeThrew = true;
      assert.ok((err as Error).message.includes('[LỖI MÀN HÌNH MÃ XÁC NHẬN]'));
    }
    assert.strictEqual(noCodeThrew, true, 'Phải ném lỗi khi màn hình mã xác nhận không xuất hiện');

    // 25.2: Màn hình xuất hiện -> bấm nút Đóng thành công
    let closeBtnClicked = false;
    let isDialogOpen = true;

    const mockPageValidCodeScreen: any = {
      isClosed: () => false,
      title: async () => 'Test Title',
      locator: (sel: string) => {
        if (sel.includes('Nhập mã xác nhận')) {
          return {
            count: async () => 1,
            first: () => ({ isVisible: async () => isDialogOpen }),
            nth: () => ({ isVisible: async () => isDialogOpen })
          };
        }
        if (sel === '[aria-label="Đóng"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => isDialogOpen,
              isEnabled: async () => true,
              click: async () => {
                closeBtnClicked = true;
                isDialogOpen = false;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await waitForVerificationCodeAndCloseDialog({
      page: mockPageValidCodeScreen,
      stepName: 'tabC-verify-and-close-dialog',
      timeoutMs: 1000
    });

    assert.strictEqual(closeBtnClicked, true, 'Nút Đóng phải được bấm đúng một lần');
    assert.strictEqual(isDialogOpen, false, 'Dialog phải được đóng');
    console.log('  ✔ Màn hình "Nhập mã xác nhận" hiển thị rồi mới bấm Đóng thành công.');
  }

  // ==========================================
  // Test 26: Bảo vệ bảo mật (masking số điện thoại trong log)
  // ==========================================
  console.log('\n26. Kiểm tra che số điện thoại (masking) an toàn:');
  {
    const masked1 = maskPhoneNumber('+84901234567');
    assert.strictEqual(masked1, '+84****567', 'Phải giữ 3 ký tự đầu và 3 ký tự cuối');
    assert.strictEqual(masked1.includes('901234'), false, 'Không bao giờ để lộ các số ở giữa');

    const masked2 = maskPhoneNumber('0987654321');
    assert.strictEqual(masked2, '098****321');
    assert.strictEqual(masked2.includes('7654'), false);

    console.log('  ✔ Che số điện thoại nhạy cảm thành công 100%, bảo vệ an toàn dữ liệu.');
  }

  console.log('\n--- TẤT CẢ BÀI KIỂM TRA YOPMAIL-MUSE (MỞ RỘNG METAA 2FA) ĐÃ VƯỢT QUA! ---');
}

runTests().catch((err) => {
  console.error('Lỗi khi chạy kiểm tra yopmail-muse:', err);
  process.exit(1);
});
