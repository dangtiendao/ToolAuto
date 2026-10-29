import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  getYopmailMuseState,
  isValidBasicEmail,
  isValidOtpCode,
  normalizeOtpWhitespace,
  extractOtpCode,
  fetchEmailFromTempMail,
  hasActualMailInList,
  waitForTempMailWithRefresh,
  findAndReadMuseMessageBody,
  extractOtpFromTempMail,
  enterOtpIntoTabB,
  waitForProfileFormReady,
  inputFirstName,
  inputLastName,
  selectBirthYear,
  submitProfileBirthday,
  waitForMuseWaitlistScreen,
  waitForMetaSecurityPageReady,
  findInteractiveButtonWithSpanText,
  selectSmsOrWhatsAppOption,
  inputPhoneNumberOnTabC,
  confirmAndClickNextButton,
  waitForVerificationCodeAndCloseDialog,
  clickContactInfoOnTabC,
  clickAddMobileNumberOnTabC,
  inputReenterPhoneOnTabC,
  clickNextSpanOnTabC,
  activateTabB,
  yopmailMuseFlow,
  generateMailboxName
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
  console.log('--- BẮT ĐẦU KIỂM TRA LUỒNG YOPMAIL-MUSE (TÍCH HỢP TEMP-MAIL) ---\n');
  const projectRoot = getProjectRoot();
  const dummyLogger = new Logger('test-tempmail-muse', projectRoot);

  // ==========================================
  // Test 1: Bấm random-button tải email mới, input#email ban đầu trống rồi được cập nhật
  // ==========================================
  console.log('1. Kiểm tra bấm random-button tải email mới, input#email ban đầu trống rồi được cập nhật:');
  {
    let readCount = 0;
    let copyClicked = false;
    let randomClicked = false;
    const expectedEmail = 'tempuser2026@ruutukf.com';

    const mockPageEmailDelayed: any = {
      isClosed: () => false,
      title: async () => 'Temp Mail',
      locator: (sel: string) => {
        if (sel === 'button[data-qa="random-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                randomClicked = true;
              }
            })
          };
        }
        if (sel === 'input#email') {
          return {
            count: async () => 1,
            first: () => ({
              isVisible: async () => true,
              inputValue: async () => {
                readCount++;
                // 2 lần đầu trả về chuỗi rỗng / đang tải, lần 3 trả về email thật
                if (readCount < 3) return '   ';
                return expectedEmail;
              }
            })
          };
        }
        if (sel === 'button[data-qa="copy-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                copyClicked = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const fetchedEmail = await fetchEmailFromTempMail({
      page: mockPageEmailDelayed,
      stepName: 'test-email-delayed',
      timeoutMs: 3000
    });

    assert.strictEqual(randomClicked, true, 'Nút random email phải được click trước khi đợi email');
    assert.strictEqual(fetchedEmail, expectedEmail, 'Email đọc được phải là email hợp lệ sau khi cập nhật');
    assert.strictEqual(copyClicked, true, 'Nút copy phải được bấm sau khi có email');
    assert.ok(readCount >= 3, 'Phải chờ qua các lần giá trị trống trước khi nhận email');
    console.log('  ✔ Bấm random-button tải email mới và đọc input#email thành công.');
  }

  // ==========================================
  // Test 2: Email được đọc và truyền nguyên vẹn sang TabB
  // ==========================================
  console.log('\n2. Kiểm tra email được đọc và truyền nguyên vẹn sang TabB (không đổi domain):');
  {
    const mockContext: FlowContext = {
      page: {} as any,
      config: {
        startUrl: 'https://example.com',
        navigationTimeoutMs: 10000,
        actionTimeoutMs: 5000,
        flowName: 'yopmail-muse',
        screenshotOnError: true,
        proxy: { enabled: false }
      },
      runId: 'test-email-pass-tabB',
      logger: dummyLogger,
      data: {}
    };

    const rawEmailFromTempMail = 'myaccount88@tempmail.io';
    const state = getYopmailMuseState(mockContext);
    state.emailAddress = rawEmailFromTempMail;

    // Giữ nguyên địa chỉ vào emailAddress, không tự sinh tên, không đổi domain, không nối "@yopmail.com"
    assert.strictEqual(state.emailAddress, rawEmailFromTempMail);
    assert.strictEqual(state.emailAddress.endsWith('@yopmail.com'), false);

    let filledEmailInTabB = '';
    const mockTabB: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[data-slot="input"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              fill: async (v: string) => {
                filledEmailInTabB = v;
              },
              inputValue: async () => filledEmailInTabB
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const inputLoc = mockTabB.locator('input[data-slot="input"]').nth(0);
    await inputLoc.fill(state.emailAddress);
    const actualVal = await inputLoc.inputValue();

    assert.strictEqual(actualVal, rawEmailFromTempMail, 'Giá trị điền vào TabB phải đúng 100% emailAddress đã đọc');
    console.log('  ✔ Email được đọc từ TabA và truyền nguyên vẹn sang TabB thành công.');
  }

  // ==========================================
  // Test 3: Click Copy không cần đọc clipboard
  // ==========================================
  console.log('\n3. Kiểm tra click Copy không phụ thuộc clipboard hệ thống:');
  {
    let copyClickCount = 0;
    let clipboardAccessed = false;
    let randomClickCount = 0;

    // Mock page không cấp quyền clipboard
    const mockPageCopyOnly: any = {
      isClosed: () => false,
      title: async () => 'Temp Mail',
      locator: (sel: string) => {
        if (sel === 'button[data-qa="random-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                randomClickCount++;
              }
            })
          };
        }
        if (sel === 'input#email') {
          return {
            count: async () => 1,
            first: () => ({
              isVisible: async () => true,
              inputValue: async () => 'independent_clip@ruutukf.com'
            })
          };
        }
        if (sel === 'button[data-qa="copy-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                copyClickCount++;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const email = await fetchEmailFromTempMail({
      page: mockPageCopyOnly,
      stepName: 'test-copy-no-clip',
      timeoutMs: 2000
    });

    assert.strictEqual(randomClickCount, 1, 'Nút random phải được click 1 lần');
    assert.strictEqual(copyClickCount, 1, 'Nút Copy phải được click đúng 1 lần');
    assert.strictEqual(clipboardAccessed, false, 'Tuyệt đối không đọc clipboard hệ thống');
    assert.strictEqual(email, 'independent_clip@ruutukf.com');
    console.log('  ✔ Click Copy đúng 1 lần không phụ thuộc việc đọc clipboard hệ thống.');
  }

  // ==========================================
  // Test 4: Danh sách có thư sẵn: không refresh
  // ==========================================
  console.log('\n4. Kiểm tra danh sách có thư sẵn: không thực hiện refresh:');
  {
    let refreshClicked = false;

    const mockPageHasMailImmediate: any = {
      isClosed: () => false,
      title: async () => 'Temp Mail',
      locator: (sel: string) => {
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              locator: () => ({ count: async () => 0 }),
              innerText: async () => 'Muse.ai Login OTP'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const locators = await waitForTempMailWithRefresh({
      page: mockPageHasMailImmediate,
      stepName: 'test-mail-immediate',
      cycleWaitMs: 100,
      onRefreshClick: async () => {
        refreshClicked = true;
      }
    });

    assert.strictEqual(locators.length, 1, 'Phải nhận diện được 1 thư có sẵn');
    assert.strictEqual(refreshClicked, false, 'Không được click refresh khi đã có thư sẵn');
    console.log('  ✔ Khi danh sách đã có thư thực tế, bỏ qua refresh hoàn toàn.');
  }

  // ==========================================
  // Test 5: Thư xuất hiện sau lần refresh 1, 2 hoặc 3
  // ==========================================
  console.log('\n5. Kiểm tra thư xuất hiện sau lần refresh 1, 2 hoặc 3:');
  {
    // 5.1: Thư xuất hiện sau lần refresh 1
    let emailCount1 = 0;
    const refreshCalls1: number[] = [];

    const mockPageRefresh1: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => emailCount1,
            nth: () => ({
              isVisible: async () => true,
              locator: () => ({ count: async () => 0 }),
              innerText: async () => 'Muse.ai verification'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const result1 = await waitForTempMailWithRefresh({
      page: mockPageRefresh1,
      stepName: 'test-refresh-1',
      cycleWaitMs: 50,
      onRefreshClick: async (count) => {
        refreshCalls1.push(count);
        if (count === 1) {
          emailCount1 = 1; // Xuất hiện thư sau refresh 1
        }
      }
    });

    assert.strictEqual(result1.length, 1);
    assert.strictEqual(refreshCalls1.length, 1, 'Phải refresh đúng 1 lần');
    console.log('  ✔ Thư xuất hiện sau lần refresh thứ 1 thành công.');

    // 5.2: Thư xuất hiện sau lần refresh 2
    let emailCount2 = 0;
    const refreshCalls2: number[] = [];

    const mockPageRefresh2: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => emailCount2,
            nth: () => ({
              isVisible: async () => true,
              locator: () => ({ count: async () => 0 }),
              innerText: async () => 'Muse.ai verification'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const result2 = await waitForTempMailWithRefresh({
      page: mockPageRefresh2,
      stepName: 'test-refresh-2',
      cycleWaitMs: 50,
      onRefreshClick: async (count) => {
        refreshCalls2.push(count);
        if (count === 2) {
          emailCount2 = 1; // Xuất hiện thư sau refresh 2
        }
      }
    });

    assert.strictEqual(result2.length, 1);
    assert.strictEqual(refreshCalls2.length, 2, 'Phải refresh đúng 2 lần');
    assert.deepStrictEqual(refreshCalls2, [1, 2]);
    console.log('  ✔ Thư xuất hiện sau lần refresh thứ 2 thành công.');

    // 5.3: Thư xuất hiện sau lần refresh 3 (trong khoảng chờ cuối)
    let emailCount3 = 0;
    const refreshCalls3: number[] = [];

    const mockPageRefresh3: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => emailCount3,
            nth: () => ({
              isVisible: async () => true,
              locator: () => ({ count: async () => 0 }),
              innerText: async () => 'Muse.ai verification'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const result3 = await waitForTempMailWithRefresh({
      page: mockPageRefresh3,
      stepName: 'test-refresh-3',
      cycleWaitMs: 50,
      onRefreshClick: async (count) => {
        refreshCalls3.push(count);
        if (count === 3) {
          emailCount3 = 1; // Xuất hiện thư sau refresh 3
        }
      }
    });

    assert.strictEqual(result3.length, 1);
    assert.strictEqual(refreshCalls3.length, 3, 'Phải refresh đúng 3 lần');
    assert.deepStrictEqual(refreshCalls3, [1, 2, 3]);
    console.log('  ✔ Thư xuất hiện sau lần refresh thứ 3 thành công.');
  }

  // ==========================================
  // Test 6: Thư tự xuất hiện trong thời gian chờ: không click thừa
  // ==========================================
  console.log('\n6. Kiểm tra thư tự xuất hiện trong thời gian chờ: không click thừa:');
  {
    let emailCount = 0;
    let refreshClicked = false;
    let pollCount = 0;

    const mockPageAutoAppear: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          pollCount++;
          if (pollCount >= 2) {
            emailCount = 1; // Thư tự xuất hiện trong khi đang chờ chu kỳ
          }
          return {
            count: async () => emailCount,
            nth: () => ({
              isVisible: async () => true,
              locator: () => ({ count: async () => 0 }),
              innerText: async () => 'Muse.ai Login'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const result = await waitForTempMailWithRefresh({
      page: mockPageAutoAppear,
      stepName: 'test-auto-appear',
      cycleWaitMs: 400,
      onRefreshClick: async () => {
        refreshClicked = true;
      }
    });

    assert.strictEqual(result.length, 1);
    assert.strictEqual(refreshClicked, false, 'Tuyệt đối không click refresh khi thư đã tự xuất hiện trong khoảng chờ');
    console.log('  ✔ Thư tự xuất hiện trong thời gian chờ: dừng refresh ngay và không click thừa.');
  }

  // ==========================================
  // Test 7: Hộp thư vẫn trống: tối đa 3 lần click
  // ==========================================
  console.log('\n7. Kiểm tra hộp thư vẫn trống: tối đa đúng 3 lần click rồi báo lỗi:');
  {
    const refreshClicks: number[] = [];

    const mockPageAlwaysEmpty: any = {
      isClosed: () => false,
      locator: () => ({ count: async () => 0 })
    };

    let exhaustedThrew = false;
    try {
      await waitForTempMailWithRefresh({
        page: mockPageAlwaysEmpty,
        stepName: 'test-exhausted',
        cycleWaitMs: 30,
        onRefreshClick: async (count) => {
          refreshClicks.push(count);
        }
      });
    } catch (err) {
      exhaustedThrew = true;
      const msg = (err as Error).message;
      assert.strictEqual(msg, 'Chưa nhận được thư sau tối đa 3 lần refresh', 'Thông báo lỗi phải chính xác theo yêu cầu');
    }

    assert.strictEqual(exhaustedThrew, true, 'Phải dừng luồng khi hết 3 lần refresh');
    assert.strictEqual(refreshClicks.length, 3, 'Chỉ được click tối đa đúng 3 lần');
    assert.deepStrictEqual(refreshClicks, [1, 2, 3]);
    console.log('  ✔ Khi hộp thư vẫn trống: click tối đa đúng 3 lần rồi báo "Chưa nhận được thư sau tối đa 3 lần refresh".');
  }

  // ==========================================
  // Test 8: Loading hoặc thông báo rỗng không được coi là thư
  // ==========================================
  console.log('\n8. Kiểm tra loading hoặc thông báo rỗng không được coi là thư:');
  {
    // Trường hợp 8.1: Phần tử chứa data-qa="loader" hoặc .animate-spin
    const mockPageSpinner: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              locator: (sub: string) => ({
                count: async () => (sub.includes('loader') ? 1 : 0)
              }),
              innerText: async () => ''
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const resSpinner = await hasActualMailInList(mockPageSpinner);
    assert.strictEqual(resSpinner.hasMail, false, 'Spinner/loader không được coi là thư');

    // Trường hợp 8.2: Thông báo "Không có tin nhắn" / "Đang chờ tin nhắn đến"
    const mockPageEmptyNotice: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              locator: () => ({ count: async () => 0 }),
              innerText: async () => 'Không có tin nhắn\nĐang chờ tin nhắn đến'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const resNotice = await hasActualMailInList(mockPageEmptyNotice);
    assert.strictEqual(resNotice.hasMail, false, 'Thông báo hộp thư trống không được coi là thư');
    console.log('  ✔ Loading, skeleton và thông báo hộp thư trống bị loại trừ chính xác.');
  }

  // ==========================================
  // Test 9: Danh sách có thư nhưng cần click để mở nội dung
  // ==========================================
  console.log('\n9. Kiểm tra danh sách có thư nhưng cần click để mở nội dung:');
  {
    let mailItemClicked = false;
    let messageBodyVisible = false;

    const mockMailItem: any = {
      isVisible: async () => true,
      innerText: async () => 'Muse.ai Login OTP Verification',
      click: async () => {
        mailItemClicked = true;
        messageBodyVisible = true; // Sau khi click, .message__body hiển thị
      }
    };

    const mockPageClickOpen: any = {
      isClosed: () => false,
      frames: () => [],
      locator: (sel: string) => {
        if (sel === '.message__body') {
          return {
            count: async () => (messageBodyVisible ? 1 : 0),
            nth: () => ({
              isVisible: async () => messageBodyVisible,
              innerText: async () => 'Mã xác nhận: 456789'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const bodyText = await findAndReadMuseMessageBody({
      page: mockPageClickOpen,
      mailLocators: [mockMailItem],
      stepName: 'test-click-open',
      timeoutMs: 1000
    });

    assert.strictEqual(mailItemClicked, true, 'Mục thư phải được click để mở nội dung');
    assert.ok(bodyText.includes('456789'), 'Nội dung đọc được phải chứa mã');
    console.log('  ✔ Danh sách có thư được click để mở nội dung và đọc .message__body thành công.');
  }

  // ==========================================
  // Test 10: OTP có số 0 ở đầu
  // ==========================================
  console.log('\n10. Kiểm tra OTP có số 0 ở đầu:');
  {
    const otp1 = extractOtpCode('Mã xác nhận 012345');
    assert.strictEqual(otp1, '012345');
    assert.strictEqual(typeof otp1, 'string');
    assert.strictEqual(isValidOtpCode(otp1), true);

    const otp2 = extractOtpCode('Mã xác nhận: 000000');
    assert.strictEqual(otp2, '000000');
    assert.strictEqual(typeof otp2, 'string');
    assert.strictEqual(isValidOtpCode(otp2), true);
    console.log('  ✔ Bảo toàn số 0 ở đầu dạng string ("012345", "000000") thành công.');
  }

  // ==========================================
  // Test 11: OTP xuống dòng sau "Mã xác nhận"
  // ==========================================
  console.log('\n11. Kiểm tra OTP xuống dòng sau "Mã xác nhận":');
  {
    const textWithNewline = 'Mã xác nhận\r\n089123';
    const otp = extractOtpCode(textWithNewline);
    assert.strictEqual(otp, '089123');

    const textWithColonNewline = 'Mã xác nhận:\n741258';
    const otp2 = extractOtpCode(textWithColonNewline);
    assert.strictEqual(otp2, '741258');

    const textWithDash = 'Mã xác nhận - 963852';
    const otp3 = extractOtpCode(textWithDash);
    assert.strictEqual(otp3, '963852');
    console.log('  ✔ Nhận diện mã OTP khi xuống dòng hoặc có dấu ":" hay "-" thành công.');
  }

  // ==========================================
  // Test 12: Chuỗi 7 chữ số không được chấp nhận
  // ==========================================
  console.log('\n12. Kiểm tra chuỗi 7 chữ số không được chấp nhận:');
  {
    let threw7Digits = false;
    try {
      extractOtpCode('Mã xác nhận 1234567');
    } catch (err) {
      threw7Digits = true;
      assert.ok((err as Error).message.includes('[LỖI TRÍCH XUẤT OTP]'));
    }
    assert.strictEqual(threw7Digits, true, 'Chuỗi 7 chữ số không được nhận diện thành OTP 6 số');

    let threw8Digits = false;
    try {
      extractOtpCode('Mã xác nhận: 01234567');
    } catch (err) {
      threw8Digits = true;
    }
    assert.strictEqual(threw8Digits, true, 'Chuỗi 8 chữ số cũng phải bị từ chối');
    console.log('  ✔ Từ chối chuỗi 7 chữ số hoặc dài hơn, không cắt bớt 6 số đầu.');
  }

  // ==========================================
  // Test 13: Thiếu mã hoặc nhiều mã khác nhau
  // ==========================================
  console.log('\n13. Kiểm tra thiếu mã hoặc nhiều mã khác nhau:');
  {
    // 13.1: Thiếu mã
    let threwNoCode = false;
    try {
      extractOtpCode('Xin chào bạn, không có mã OTP nào trong thư này');
    } catch (err) {
      threwNoCode = true;
      assert.ok((err as Error).message.includes('Không tìm thấy mã xác nhận'));
    }
    assert.strictEqual(threwNoCode, true);

    // 13.2: Nhiều mã khác nhau
    let threwMultiCode = false;
    try {
      extractOtpCode('Mã xác nhận: 123456 hoặc Mã xác nhận: 654321');
    } catch (err) {
      threwMultiCode = true;
      assert.ok((err as Error).message.includes('Tìm thấy 2 mã OTP khác nhau'));
    }
    assert.strictEqual(threwMultiCode, true);

    // 13.3: Cùng một mã xuất hiện nhiều lần -> Loại trùng hợp lệ
    const sameCodeTwice = extractOtpCode('Mã xác nhận 123456 ... xác nhận lại: Mã xác nhận 123456');
    assert.strictEqual(sameCodeTwice, '123456', 'Trùng lặp cùng 1 mã phải được loại trùng và chấp nhận');

    // 13.4: Trích xuất mã OTP từ thẻ div style đặc trưng của Muse.ai
    const divStyleOtp = extractOtpCode(
      '<div style="font-size: 24px;font-weight: 400;background: #F1F4F7;color: #1C2B33;border-radius: 4px;letter-spacing: 2px;padding: 16px;">065444</div>'
    );
    assert.strictEqual(divStyleOtp, '065444', 'Phải trích xuất được mã 065444 từ thẻ div có style');

    // 13.5: Trích xuất mã OTP từ cụm từ tiếng Anh "Confirmation code"
    const confCode1 = extractOtpCode('Confirmation code 065444');
    assert.strictEqual(confCode1, '065444');

    const confCode2 = extractOtpCode('Confirmation code: 065444');
    assert.strictEqual(confCode2, '065444');

    const confCode3 = extractOtpCode('Confirmation code\r\n065444');
    assert.strictEqual(confCode3, '065444');

    const confCode4 = extractOtpCode('Confirmation code - 065444');
    assert.strictEqual(confCode4, '065444');

    console.log('  ✔ Xử lý thiếu mã, nhiều mã khác nhau, Confirmation code và thẻ div style OTP thành công.');
  }

  // ==========================================
  // Test 14: Email thay đổi ngoài dự kiến
  // ==========================================
  console.log('\n14. Kiểm tra email thay đổi ngoài dự kiến:');
  {
    // 14.1: Sau khi click copy, input#email thay đổi
    let copyClicked = false;
    const mockPageChangeOnCopy: any = {
      isClosed: () => false,
      title: async () => 'Temp Mail',
      locator: (sel: string) => {
        if (sel === 'button[data-qa="random-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === 'input#email') {
          return {
            count: async () => 1,
            first: () => ({
              isVisible: async () => true,
              inputValue: async () => {
                if (copyClicked) return 'unexpected_changed@ruutukf.com'; // Bị đổi sau copy
                return 'initial@ruutukf.com';
              }
            })
          };
        }
        if (sel === 'button[data-qa="copy-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                copyClicked = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let threwChangedOnCopy = false;
    try {
      await fetchEmailFromTempMail({
        page: mockPageChangeOnCopy,
        stepName: 'test-changed-copy',
        timeoutMs: 2000
      });
    } catch (err) {
      threwChangedOnCopy = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI EMAIL THAY ĐỔI]'));
      assert.ok(msg.includes('tránh lệch hộp thư'));
    }
    assert.strictEqual(threwChangedOnCopy, true, 'Phải dừng khi email thay đổi sau khi click copy');

    // 14.2: Khi quay lại TabA để chờ thư, input#email không khớp
    const mockPageChangedOnReturn: any = {
      isClosed: () => false,
      locator: (sel: string) => {
        if (sel === 'button[data-qa="random-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === 'input#email') {
          return {
            first: () => ({
              inputValue: async () => 'changed_email@ruutukf.com'
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    let threwChangedOnReturn = false;
    try {
      await extractOtpFromTempMail({
        page: mockPageChangedOnReturn,
        emailAddress: 'original_email@ruutukf.com',
        stepName: 'test-changed-return',
        timeoutMs: 1000
      });
    } catch (err) {
      threwChangedOnReturn = true;
      const msg = (err as Error).message;
      assert.ok(msg.includes('[LỖI EMAIL THAY ĐỔI]'));
      assert.ok(msg.includes('không khớp với emailAddress đã lấy'));
    }
    assert.strictEqual(threwChangedOnReturn, true, 'Phải dừng khi email thay đổi lúc quay lại TabA');
    console.log('  ✔ Bắt lỗi và dừng an toàn khi địa chỉ email thay đổi ngoài dự kiến.');
  }

  // ==========================================
  // Test 15: Ctrl+C khi đang chờ refresh
  // ==========================================
  console.log('\n15. Kiểm tra ngắt thời gian chờ refresh khi nhận tín hiệu dừng (Ctrl+C):');
  {
    const abortController = new AbortController();
    const mockPageWaitAbort: any = {
      isClosed: () => false,
      locator: () => ({ count: async () => 0 })
    };

    // Hủy bỏ sau 50ms
    setTimeout(() => {
      abortController.abort();
    }, 50);

    let threwCancelled = false;
    const startWait = Date.now();

    try {
      await waitForTempMailWithRefresh({
        page: mockPageWaitAbort,
        stepName: 'test-abort',
        cycleWaitMs: 3000,
        cancellationToken: abortController.signal
      });
    } catch (err) {
      threwCancelled = true;
      const elapsed = Date.now() - startWait;
      assert.ok(elapsed < 1000, `Phải ngắt ngay lập tức khi có tín hiệu hủy (thực tế: ${elapsed}ms)`);
      assert.ok((err as Error).message.includes('[HỦY BỎ]'));
    }

    assert.strictEqual(threwCancelled, true, 'Phải ném lỗi hủy bỏ ngay khi nhận tín hiệu');
    console.log('  ✔ Ctrl+C ngắt thời gian chờ refresh ngay lập tức mà không chờ hết chu kỳ.');
  }

  // ==========================================
  // Test 16: Không lộ OTP trong log hoặc ảnh chụp màn hình
  // ==========================================
  console.log('\n16. Kiểm tra bảo mật không lộ OTP trong log hoặc ảnh chụp màn hình:');
  {
    const secretOtp = '098123';
    const loggedLines: string[] = [];
    const secureLogger: any = {
      info: (msg: string) => loggedLines.push(msg),
      warn: (msg: string) => loggedLines.push(msg),
      error: (msg: string) => loggedLines.push(msg),
      stepResult: () => {}
    };

    const mockMailItem: any = {
      isVisible: async () => true,
      innerText: async () => 'Muse.ai Login OTP',
      click: async () => {}
    };

    const mockPageSecure: any = {
      isClosed: () => false,
      frames: () => [],
      locator: (sel: string) => {
        if (sel === 'button[data-qa="random-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === 'input#email') {
          return {
            first: () => ({
              inputValue: async () => 'secret@ruutukf.com'
            })
          };
        }
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => 1,
            nth: () => mockMailItem
          };
        }
        if (sel === '.message__body') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              innerText: async () => `Mã xác nhận: ${secretOtp}`
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const extracted = await extractOtpFromTempMail({
      page: mockPageSecure,
      emailAddress: 'secret@ruutukf.com',
      stepName: 'test-secure-log',
      timeoutMs: 1000,
      logger: secureLogger
    });

    assert.strictEqual(extracted, secretOtp);

    // Kiểm tra tất cả log ghi ra
    for (const logLine of loggedLines) {
      assert.strictEqual(
        logLine.includes(secretOtp),
        false,
        `Tuyệt đối không được ghi mã OTP vào log: "${logLine}"`
      );
    }

    console.log('  ✔ Mã OTP được bảo mật 100%, không bị ghi vào file log hoặc console.');
  }

  // ==========================================
  // Test 17: Kiểm tra Flow Registry và cấu trúc 17 bước
  // ==========================================
  console.log('\n17. Kiểm tra Flow Registry với luồng yopmail-muse (17 bước tuần tự):');
  {
    const foundFlow = getFlow('yopmail-muse');
    assert.ok(foundFlow, 'Phải tìm thấy luồng yopmail-muse trong registry');
    assert.strictEqual(foundFlow?.name, 'yopmail-muse');

    const foundViaOrThrow = getFlowOrThrow('yopmail-muse');
    assert.strictEqual(foundViaOrThrow.name, 'yopmail-muse');

    const stepIds = yopmailMuseFlow.steps.map((s) => s.id);
    assert.deepStrictEqual(stepIds, [
      'tabA-tempmail',
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
      'tabC-verify-and-close-dialog',
      'tabC-click-contact-info',
      'tabC-click-add-mobile-number',
      'tabC-input-reenter-phone',
      'tabC-submit-next',
      'tabB-activate'
    ]);
    console.log(`  ✔ Luồng đã đăng ký thành công với 22 bước tuần tự: [${stepIds.join(', ')}].`);
  }

  // ==========================================
  // Test 18: Kiểm tra thực thi toàn bộ luồng 20 bước qua Sequential Runner
  // ==========================================
  console.log('\n18. Kiểm tra thực thi toàn bộ luồng 20 bước qua Sequential Runner:');
  {
    let tabBCreated = false;
    let continueBtnClicked = false;
    let formValues: Record<string, string> = {};

    const mockTabA: any = {
      isClosed: () => false,
      title: async () => 'Temp Mail',
      goto: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      bringToFront: async () => {},
      locator: (sel: string) => {
        if (sel === 'button[data-qa="random-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === 'input#email') {
          return {
            count: async () => 1,
            first: () => ({
              isVisible: async () => true,
              inputValue: async () => 'runner_flow_test@ruutukf.com'
            }),
            nth: () => ({
              isVisible: async () => true,
              inputValue: async () => 'runner_flow_test@ruutukf.com'
            })
          };
        }
        if (sel === 'button[data-qa="copy-button"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        if (sel === '.email-list [data-qa="message"]' || sel === '[data-qa="message"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              locator: () => ({ count: async () => 0 }),
              innerText: async () => 'Muse.ai Login OTP Verification',
              click: async () => {}
            })
          };
        }
        if (sel === '.message__body') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              innerText: async () => 'Mã xác nhận: 135790'
            })
          };
        }
        return { count: async () => 0 };
      },
      frames: () => []
    };

    const mockTabB: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      goto: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      bringToFront: async () => {
        if (tabCReenteredPhone) {
          tabBBroughtToFrontAfterC = true;
        }
      },
      evaluate: async () => 'input',
      locator: (sel: string) => {
        if (sel === 'input[data-slot="input"]') {
          const item = {
            isVisible: async () => true,
            isEditable: async () => true,
            isEnabled: async () => true,
            fill: async () => {},
            inputValue: async () => 'runner_flow_test@ruutukf.com'
          };
          return {
            count: async () => 1,
            nth: () => item,
            first: () => item
          };
        }
        if (sel === '[data-pel-click="login_contact_continue_click"]') {
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
              inputValue: async () => '135790'
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
        if (sel.includes('Tham gia danh sách chờ Muse') || sel.includes('waitlist')) {
          return {
            count: async () => (continueBtnClicked ? 1 : 0),
            nth: () => ({
              isVisible: async () => continueBtnClicked
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
    let tabCClickedContactInfo = false;
    let tabCClickedAddNewContact = false;
    let tabCClickedAddMobileNumber = false;
    let tabCReenteredPhone = '';
    let tabCNextClickedAfterReenter = false;
    let tabBBroughtToFrontAfterC = false;

    const mockTabC: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      goto: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      bringToFront: async () => {},
      waitForLoadState: async () => {},
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
        if (sel === '[aria-label="Contact info"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                tabCClickedContactInfo = true;
              }
            })
          };
        }
        if (sel === '[role="presentation"]') {
          return {
            count: async () => 1,
            filter: () => ({
              count: async () => 1,
              first: () => mockTabC
            }),
            nth: () => ({
              isVisible: async () => true,
              innerText: async () => 'Add new contact info',
              getByRole: (role: string, opts?: any) => {
                if (role === 'button') {
                  return {
                    count: async () => 1,
                    nth: () => ({
                      isVisible: async () => true,
                      isEnabled: async () => true,
                      click: async () => {
                        tabCClickedAddNewContact = true;
                      }
                    })
                  };
                }
                return { count: async () => 0 };
              },
              locator: (childSel: string) => mockTabC.locator(childSel)
            })
          };
        }
        if (sel.includes('Add new contact') || sel.includes('Thêm thông tin liên hệ')) {
          return {
            count: async () => (tabCClickedContactInfo ? 1 : 0),
            nth: () => ({
              isVisible: async () => tabCClickedContactInfo,
              isEnabled: async () => true,
              innerText: async () => 'Add new contact info',
              elementHandle: async () => ({}),
              evaluate: async () => false,
              click: async () => {
                tabCClickedAddNewContact = true;
              }
            })
          };
        }
        if (sel.includes('Add mobile number') || sel.includes('Thêm số di động')) {
          return {
            count: async () => (tabCClickedAddNewContact || tabCClickedContactInfo ? 1 : 0),
            nth: () => ({
              isVisible: async () => tabCClickedAddNewContact || tabCClickedContactInfo,
              isEnabled: async () => true,
              innerText: async () => 'Add mobile number',
              elementHandle: async () => ({}),
              evaluate: async () => false,
              click: async () => {
                tabCClickedAddMobileNumber = true;
              }
            })
          };
        }
        if (sel === 'span') {
          return {
            count: async () => 6,
            filter: (filterOpts: { hasText?: RegExp | string }) => {
              const regex = filterOpts?.hasText;
              const matches: string[] = [];
              const testFn = (t: string) => (regex instanceof RegExp ? regex.test(t) : typeof regex === 'string' ? t.includes(regex) : false);
              if (testFn('Bắt đầu')) matches.push('Bắt đầu');
              if (testFn('Tiếp tục')) matches.push('Tiếp tục');
              if (testFn('Tiếp')) matches.push('Tiếp');
              if (testFn('Next')) matches.push('Next');
              if (testFn('Add new contact info')) matches.push('Add new contact info');
              if (testFn('Add mobile number')) matches.push('Add mobile number');

              return {
                count: async () => matches.length,
                nth: (idx: number) => {
                  const matchedText = matches[idx] || '';
                  return {
                    isVisible: async () => true,
                    innerText: async () => matchedText,
                    textContent: async () => matchedText,
                    elementHandle: async () => ({}),
                    evaluate: async () => false,
                    locator: () => ({
                      count: async () => 1,
                      first: () => ({
                        isVisible: async () => true,
                        isEnabled: async () => true,
                        click: async () => {
                          if (matchedText === 'Bắt đầu') tabCClickedStart = true;
                          if (matchedText === 'Tiếp tục') tabCClickedContinue = true;
                          if (matchedText === 'Tiếp' || matchedText === 'Next') {
                            if (tabCReenteredPhone) {
                              tabCNextClickedAfterReenter = true;
                            } else {
                              tabCClickedNext = true;
                            }
                          }
                          if (matchedText === 'Add new contact info') tabCClickedAddNewContact = true;
                          if (matchedText === 'Add mobile number') tabCClickedAddMobileNumber = true;
                        }
                      })
                    })
                  };
                }
              };
            },
            nth: (i: number) => {
              const texts = ['Bắt đầu', 'Tiếp tục', 'Tiếp', 'Next', 'Add new contact info', 'Add mobile number'];
              const text = texts[i] || '';
              return {
                isVisible: async () => true,
                innerText: async () => text,
                textContent: async () => text,
                elementHandle: async () => ({}),
                evaluate: async () => false,
                locator: () => ({
                  count: async () => 1,
                  first: () => ({
                    isVisible: async () => true,
                    isEnabled: async () => true,
                    click: async () => {
                      if (text === 'Bắt đầu') tabCClickedStart = true;
                      if (text === 'Tiếp tục') tabCClickedContinue = true;
                      if (text === 'Tiếp' || text === 'Next') {
                        if (tabCReenteredPhone) {
                          tabCNextClickedAfterReenter = true;
                        } else {
                          tabCClickedNext = true;
                        }
                      }
                      if (text === 'Add new contact info') tabCClickedAddNewContact = true;
                      if (text === 'Add mobile number') tabCClickedAddMobileNumber = true;
                    }
                  })
                })
              };
            }
          };
        }
        if (sel === 'input[type="tel"]') {
          const isVis = !tabCClosedDialog || tabCClickedAddMobileNumber;
          return {
            count: async () => (isVis ? 1 : 0),
            nth: () => ({
              isVisible: async () => isVis,
              isEditable: async () => true,
              isEnabled: async () => true,
              click: async () => {},
              fill: async (v: string) => {
                if (!tabCClickedAddMobileNumber) {
                  tabCPhoneEntered = v;
                } else {
                  tabCReenteredPhone = v;
                }
              },
              inputValue: async () => (tabCClickedAddMobileNumber ? tabCReenteredPhone : tabCPhoneEntered),
              evaluate: async () => true
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
        if (sel === '[aria-label="Đóng"]' || sel === '[aria-label="Close"]') {
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
          if (
            name === 'Bắt đầu' ||
            name === 'Tiếp tục' ||
            name === 'Tiếp' ||
            name === 'Next' ||
            name === 'Add new contact info' ||
            name === 'Add mobile number'
          ) {
            return {
              count: async () => 1,
              nth: () => ({
                isVisible: async () => true,
                isEnabled: async () => true,
                elementHandle: async () => ({}),
                evaluate: async () => false,
                click: async () => {
                  if (name === 'Bắt đầu') tabCClickedStart = true;
                  if (name === 'Tiếp tục') tabCClickedContinue = true;
                  if (name === 'Tiếp' || name === 'Next') {
                    if (tabCReenteredPhone) {
                      tabCNextClickedAfterReenter = true;
                    } else {
                      tabCClickedNext = true;
                    }
                  }
                  if (name === 'Add new contact info') tabCClickedAddNewContact = true;
                  if (name === 'Add mobile number') tabCClickedAddMobileNumber = true;
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
      runId: 'test-full-20-steps-run',
      logger: dummyLogger,
      data: {}
    };

    const flowResult = await runFlow(yopmailMuseFlow, fullTestContext, projectRoot);

    assert.strictEqual(flowResult.status, 'success', 'Luồng 22 bước phải chạy thành công');
    assert.strictEqual(flowResult.completedSteps.length, 22, 'Phải hoàn thành đủ 22 bước tuần tự');
    assert.strictEqual(continueBtnClicked, true, 'Nút tiếp tục trên TabB phải được bấm');
    assert.strictEqual(tabCCreated, true, 'TabC phải được tạo trong cùng browser context');
    assert.strictEqual(tabCClickedTwoFactor, true, 'Phải click Xác thực 2 yếu tố trên TabC');
    assert.strictEqual(tabCClickedStart, true, 'Phải click Bắt đầu trên TabC');
    assert.strictEqual(tabCSelectedSms, true, 'Phải chọn SMS hoặc WhatsApp trên TabC');
    assert.strictEqual(tabCClickedContinue, true, 'Phải click Tiếp tục trên TabC');
    assert.ok(tabCPhoneEntered.length >= 7, 'Phải nhập số điện thoại hợp lệ');
    assert.strictEqual(tabCClickedNext, true, 'Phải click Tiếp trên TabC');
    assert.strictEqual(tabCClosedDialog, true, 'Phải click Đóng dialog sau khi màn hình mã xác nhận hiển thị');
    assert.strictEqual(tabCClickedContactInfo, true, 'Phải click Contact info trên TabC');
    assert.strictEqual(tabCClickedAddNewContact, true, 'Phải click thẻ Add new contact info trên TabC');
    assert.strictEqual(tabCClickedAddMobileNumber, true, 'Phải click Add mobile number trên TabC');
    assert.strictEqual(tabCReenteredPhone, tabCPhoneEntered, 'Số điện thoại nhập lại phải trùng khớp với số đã chọn');
    assert.strictEqual(tabCNextClickedAfterReenter, true, 'Phải click Next trên TabC sau khi nhập lại số');
    assert.strictEqual(tabBBroughtToFrontAfterC, true, 'Phải kích hoạt lại TabB làm tab hiện hành sau khi xong TabC');
    console.log('  ✔ Toàn bộ 22 bước của luồng yopmail-muse đã chạy tuần tự qua Sequential Runner thành công 100%.');
  }

  // ==========================================
  // Test 19-27: Tiếp tục giữ nguyên toàn bộ các bài kiểm tra nghiệp vụ TabB và TabC (Meta 2FA)
  // ==========================================
  console.log('\n19. Kiểm tra chờ form thông tin cá nhân sẵn sàng (waitForProfileFormReady):');
  {
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
    assert.ok(loc);
    console.log('  ✔ Chờ form thông tin sẵn sàng bằng điều kiện DOM thành công.');
  }

  console.log('\n20. Kiểm tra nhập First name "Dang" và Last name "Dao":');
  {
    let firstNameVal = '';
    let lastNameVal = '';

    const mockPageNames: any = {
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
              fill: async (v: string) => {
                firstNameVal = v;
              },
              inputValue: async () => firstNameVal
            })
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
                lastNameVal = v;
              },
              inputValue: async () => lastNameVal
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await inputFirstName({ page: mockPageNames, stepName: 'first-name', timeoutMs: 1000 });
    assert.strictEqual(firstNameVal, 'Dang');

    await inputLastName({ page: mockPageNames, stepName: 'last-name', timeoutMs: 1000 });
    assert.strictEqual(lastNameVal, 'Dao');
    console.log('  ✔ Nhập First name "Dang" và Last name "Dao" thành công.');
  }

  console.log('\n21. Kiểm tra chọn Year 2000 qua select[aria-label="Year"]:');
  {
    let selectedOptionVal = '';

    const mockPageYear: any = {
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
              locator: () => ({
                count: async () => 1,
                first: () => ({ innerText: async () => '2000' })
              }),
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

    await selectBirthYear({ page: mockPageYear, stepName: 'select-year', timeoutMs: 1000 });
    assert.strictEqual(selectedOptionVal, '2000');
    console.log('  ✔ Chọn option value="2000" với selectOption() thành công.');
  }

  console.log('\n22. Kiểm tra bấm nút tiếp tục login_birthday_continue_click:');
  {
    let clicked = false;
    const mockPageSubmit: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      locator: (sel: string) => {
        if (sel === 'input[aria-label="First name"]') return { inputValue: async () => 'Dang' };
        if (sel === 'input[aria-label="Last name"]') return { inputValue: async () => 'Dao' };
        if (sel.includes('Year')) return { inputValue: async () => '2000' };
        if (sel === '[data-pel-click="login_birthday_continue_click"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                clicked = true;
              }
            })
          };
        }
        if (sel.includes('Tham gia danh sách chờ Muse') || sel.includes('waitlist')) {
          return {
            count: async () => (clicked ? 1 : 0),
            nth: () => ({
              isVisible: async () => clicked
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await submitProfileBirthday({ page: mockPageSubmit, stepName: 'submit-profile', timeoutMs: 1000 });
    assert.strictEqual(clicked, true);
    console.log('  ✔ Bấm nút tiếp tục đúng một lần thành công.');
  }

  console.log('\n23. Kiểm tra đọc TXT có UTF-8 BOM, CRLF, dòng trống và trùng lặp:');
  {
    const scratchDir = path.resolve(projectRoot, 'tests', 'scratch');
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }

    const testFilePath = path.join(scratchDir, 'test-bom-crlf-phones.txt');
    const testContent = '\uFEFF  +84901234567  \r\n\r\n0987654321\r\n  +84901234567  \r\n+84912345678\r\n\r\n';
    fs.writeFileSync(testFilePath, testContent, 'utf-8');

    const result = readPhoneNumbersFromFile(testFilePath);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], '+84901234567');
    assert.strictEqual(result[1], '0987654321');
    assert.strictEqual(result[2], '+84912345678');
    console.log('  ✔ Đọc file UTF-8 với BOM, CRLF, loại bỏ dòng trống và dòng trùng thành công.');
  }

  console.log('\n24. Kiểm tra phân biệt chính xác nút chứa "Tiếp" vs "Tiếp tục":');
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

    const nextBtn = await findInteractiveButtonWithSpanText({
      page: mockPageButtons,
      targetText: 'Tiếp',
      tabName: 'TabC',
      stepName: 'test-tiep',
      timeoutMs: 1000
    });
    await nextBtn.click();
    assert.strictEqual(clickedButton, 'Tiếp');

    const continueBtn = await findInteractiveButtonWithSpanText({
      page: mockPageButtons,
      targetText: 'Tiếp tục',
      tabName: 'TabC',
      stepName: 'test-tiep-tuc',
      timeoutMs: 1000
    });
    await continueBtn.click();
    assert.strictEqual(clickedButton, 'Tiếp tục');
    console.log('  ✔ Phân biệt chính xác giữa span "Tiếp" và span "Tiếp tục".');
  }

  console.log('\n25. Kiểm tra chế độ chạy Mock vs Live:');
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

    await confirmAndClickNextButton({
      page: mockPageNext,
      stepName: 'confirm-next',
      phone: '+84901234567',
      phoneMode: 'mock',
      timeoutMs: 1000
    });
    assert.strictEqual(nextClickedInMock, true);
    console.log('  ✔ Mock mode không gửi mã thật; Live mode dừng an toàn khi thiếu xác nhận.');
  }

  console.log('\n26. Kiểm tra so sánh số tương đương (tự định dạng) và nhập số:');
  {
    assert.strictEqual(isPhoneEquivalent('+84 90 123 4567', '+84901234567'), true);
    assert.strictEqual(isPhoneEquivalent('(090) 123 4567', '0901234567'), true);

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
      stepName: 'input-phone',
      phone: '+84901234567',
      timeoutMs: 1000
    });
    assert.strictEqual(enteredVal, '+84901234567');
    console.log('  ✔ Kiểm tra số điện thoại tương đương và nhập input[type="tel"] thành công.');
  }

  console.log('\n27. Kiểm tra chỉ bấm Đóng sau khi màn hình mã xác nhận hiển thị và masking số điện thoại:');
  {
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
      stepName: 'close-dialog',
      timeoutMs: 1000
    });
    assert.strictEqual(closeBtnClicked, true);

    const masked = maskPhoneNumber('+84901234567');
    assert.strictEqual(masked, '+84****567');
    console.log('  ✔ Màn hình "Nhập mã xác nhận" hiển thị rồi mới bấm Đóng, che số điện thoại bảo mật 100%.');
  }

  // ==========================================
  // Test 28: Kiểm tra Tab B chuyển thẳng sang bước nhập name sau khi nhập OTP
  // ==========================================
  console.log('\n28. Kiểm tra Tab B chuyển thẳng sang bước nhập name sau khi nhập OTP:');
  {
    // 28.1: Trang tự động chuyển sang form nhập First name mà không cần nút xác nhận
    let confirmBtnClickedAuto = false;
    let otpEntered = '';

    const mockTabBAutoTransition: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      bringToFront: async () => {},
      evaluate: async () => 'input',
      locator: (sel: string) => {
        if (sel === '[data-slot="pin-digit"]') {
          return {
            count: async () => 1,
            first: () => ({
              evaluate: async () => 'input',
              fill: async (v: string) => {
                otpEntered = v;
              },
              inputValue: async () => otpEntered
            }),
            nth: () => ({ isVisible: async () => true })
          };
        }
        if (sel === 'input[aria-label="First name"]') {
          // Ngay sau khi nhập OTP, form chuyển sang First name luôn
          return {
            count: async () => 1,
            first: () => ({ isVisible: async () => true }),
            nth: () => ({ isVisible: async () => true })
          };
        }
        if (sel === '[data-pel-click="login_otp_confirm_click"]') {
          return {
            count: async () => 1,
            first: () => ({
              isVisible: async () => false,
              isEnabled: async () => false,
              click: async () => {
                confirmBtnClickedAuto = true;
              }
            }),
            nth: () => ({
              isVisible: async () => false,
              isEnabled: async () => false,
              click: async () => {
                confirmBtnClickedAuto = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const submitOtpStep = yopmailMuseFlow.steps.find((s) => s.id === 'tabB-submit-otp')!;
    const mockContextAuto: FlowContext = {
      page: mockTabBAutoTransition,
      config: {
        startUrl: 'https://example.com',
        navigationTimeoutMs: 10000,
        actionTimeoutMs: 3000,
        flowName: 'yopmail-muse',
        screenshotOnError: true,
        proxy: { enabled: false }
      },
      runId: 'test-auto-transition-name',
      logger: dummyLogger,
      data: {
        tabB: mockTabBAutoTransition,
        otpCode: '852963'
      }
    };

    await submitOtpStep.execute(mockContextAuto);
    assert.strictEqual(otpEntered, '852963', 'Phải nhập đúng mã OTP vào Tab B');
    assert.strictEqual(confirmBtnClickedAuto, false, 'Khi trang đã chuyển sang First name, không được click nút xác nhận');
    console.log('  ✔ Sau khi nhập OTP, Tab B tự động chuyển thẳng sang nhập First name và hoàn thành bước thành công.');

    // 28.2: Trang không tự chuyển, nút xác nhận OTP hiển thị và được bấm
    let confirmBtnClickedManual = false;
    let otpEnteredManual = '';
    let isProfileFormShowing = false;

    const mockTabBManualConfirm: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      bringToFront: async () => {},
      evaluate: async () => 'input',
      locator: (sel: string) => {
        if (sel === '[data-slot="pin-digit"]') {
          return {
            count: async () => 1,
            first: () => ({
              evaluate: async () => 'input',
              fill: async (v: string) => {
                otpEnteredManual = v;
              },
              inputValue: async () => otpEnteredManual
            }),
            nth: () => ({ isVisible: async () => true })
          };
        }
        if (sel === 'input[aria-label="First name"]') {
          return {
            count: async () => (isProfileFormShowing ? 1 : 0),
            first: () => ({ isVisible: async () => isProfileFormShowing }),
            nth: () => ({ isVisible: async () => isProfileFormShowing })
          };
        }
        if (sel === '[data-pel-click="login_otp_confirm_click"]') {
          return {
            count: async () => (isProfileFormShowing ? 0 : 1),
            first: () => ({
              isVisible: async () => !isProfileFormShowing,
              isEnabled: async () => true,
              click: async () => {
                confirmBtnClickedManual = true;
                isProfileFormShowing = true;
              }
            }),
            nth: () => ({
              isVisible: async () => !isProfileFormShowing,
              isEnabled: async () => true,
              click: async () => {
                confirmBtnClickedManual = true;
                isProfileFormShowing = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    const mockContextManual: FlowContext = {
      page: mockTabBManualConfirm,
      config: {
        startUrl: 'https://example.com',
        navigationTimeoutMs: 10000,
        actionTimeoutMs: 3000,
        flowName: 'yopmail-muse',
        screenshotOnError: true,
        proxy: { enabled: false }
      },
      runId: 'test-manual-confirm-otp',
      logger: dummyLogger,
      data: {
        tabB: mockTabBManualConfirm,
        otpCode: '741963'
      }
    };

    await submitOtpStep.execute(mockContextManual);
    assert.strictEqual(otpEnteredManual, '741963', 'Phải nhập đúng mã OTP vào Tab B');
    assert.strictEqual(confirmBtnClickedManual, true, 'Nếu chưa chuyển sang First name, phải bấm nút xác nhận OTP đúng 1 lần');
    assert.strictEqual(isProfileFormShowing, true, 'Sau khi click xác nhận, form chuyển sang First name');
    console.log('  ✔ Khi trang không tự chuyển, nút xác nhận OTP được click đúng một lần và chuyển tiếp thành công.');
  }

  console.log('\n29. Kiểm tra chọn Year 2000 trên cấu trúc Radix UI Combobox tiếng Việt (button[data-slot="select-trigger"][aria-label="Năm"]):');
  {
    let currentDisplayYear = '2026';
    let triggerClicked = false;
    let option2000Clicked = false;
    let continueBtnClicked = false;

    const mockRadixTabB: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      evaluate: async (fn: any, arg: any) => {
        if (typeof fn === 'function' && arg) {
          currentDisplayYear = arg;
        }
        return 'button';
      },
      locator: (sel: string) => {
        if (sel === 'button[data-slot="select-trigger"][aria-label="Năm"]' || sel.includes('aria-label="Năm"')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              evaluate: async () => 'button',
              click: async () => {
                triggerClicked = true;
              },
              locator: (subSel: string) => {
                if (subSel === '[data-slot="select-value"]') {
                  return {
                    count: async () => 1,
                    first: () => ({
                      innerText: async () => currentDisplayYear
                    })
                  };
                }
                return { count: async () => 0 };
              },
              innerText: async () => currentDisplayYear
            })
          };
        }
        if (sel.includes('option') && sel.includes('2000')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              click: async () => {
                option2000Clicked = true;
                currentDisplayYear = '2000';
              }
            })
          };
        }
        if (sel.includes('select[autocomplete="bday-year"]')) {
          return {
            count: async () => 1,
            nth: () => ({
              selectOption: async () => {
                currentDisplayYear = '2000';
              }
            })
          };
        }
        if (sel === 'input[aria-label="First name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              inputValue: async () => 'Dang'
            })
          };
        }
        if (sel === 'input[aria-label="Last name"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              inputValue: async () => 'Dao'
            })
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
        if (sel.includes('Tham gia danh sách chờ Muse') || sel.includes('waitlist')) {
          return {
            count: async () => (continueBtnClicked ? 1 : 0),
            nth: () => ({
              isVisible: async () => continueBtnClicked
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    // 1. Thao tác chọn năm từ 2026 sang 2000
    await selectBirthYear({
      page: mockRadixTabB,
      stepName: 'tabB-select-year',
      yearValue: '2000',
      timeoutMs: 3000
    });

    assert.strictEqual(triggerClicked, true, 'Phải click vào combobox trigger aria-label="Năm"');
    assert.strictEqual(option2000Clicked, true, 'Phải click vào option 2000 trong dropdown');
    assert.strictEqual(currentDisplayYear, '2000', 'Giá trị hiển thị phải chuyển thành 2000');
    console.log('  ✔ Chuyển từ 2026 sang chọn năm 2000 trên combobox Radix UI tiếng Việt thành công.');

    // 2. Tiếp tục xác minh và bấm nút tiếp tục
    await submitProfileBirthday({
      page: mockRadixTabB,
      stepName: 'tabB-submit-profile',
      timeoutMs: 3000
    });

    assert.strictEqual(continueBtnClicked, true, 'Sau khi chọn 2000, nút login_birthday_continue_click phải được bấm');
    console.log('  ✔ Xác minh thành công các trường (Dang, Dao, 2000) và bấm nút tiếp tục thành công.');
  }

  console.log('\n30. Kiểm tra Tab B phải chờ hiển thị "Tham gia danh sách chờ Muse" rồi mới mở Tab C:');
  {
    // 30.1: Nếu trang B chưa hiển thị "Tham gia danh sách chờ Muse" -> dừng báo timeout
    let timeoutCaught = false;
    const mockPageNoWaitlist: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      evaluate: async () => false,
      locator: () => ({ count: async () => 0 })
    };

    try {
      await waitForMuseWaitlistScreen({
        page: mockPageNoWaitlist,
        stepName: 'test-no-waitlist',
        timeoutMs: 500
      });
    } catch (err: any) {
      if (err.message.includes('Tham gia danh sách chờ Muse')) {
        timeoutCaught = true;
      }
    }
    assert.strictEqual(timeoutCaught, true, 'Phải dừng và báo lỗi khi Tab B chưa hiển thị Tham gia danh sách chờ Muse');
    console.log('  ✔ Dừng báo lỗi chính xác khi Tab B chưa hiển thị "Tham gia danh sách chờ Muse".');

    // 30.2: Khi Tab B xuất hiện "Tham gia danh sách chờ Muse" -> hoàn tất thành công
    const mockPageHasWaitlist: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      evaluate: async () => true,
      locator: (sel: string) => {
        if (sel.includes('Tham gia danh sách chờ Muse')) {
          return {
            count: async () => 1,
            nth: () => ({ isVisible: async () => true })
          };
        }
        return { count: async () => 0 };
      }
    };

    await waitForMuseWaitlistScreen({
      page: mockPageHasWaitlist,
      stepName: 'test-has-waitlist',
      timeoutMs: 1000
    });
    console.log('  ✔ Đã phát hiện và xác nhận hiển thị "Tham gia danh sách chờ Muse" thành công.');
  }

  // ==========================================
  // Test 31: Kiểm tra hỗ trợ song ngữ tiếng Anh (Join the waitlist for Muse, aria-label="Two-factor authentication")
  // ==========================================
  console.log('\n31. Kiểm tra hỗ trợ song ngữ tiếng Anh (Join the waitlist for Muse, Two-factor authentication):');
  {
    // 31.1: Tab B Waitlist tiếng Anh: "Join the waitlist for Muse"
    const mockPageEnglishWaitlist: any = {
      isClosed: () => false,
      title: async () => 'Muse.ai',
      evaluate: async () => true,
      locator: (sel: string) => {
        if (sel.includes('Join the waitlist for Muse')) {
          return {
            count: async () => 1,
            nth: () => ({ isVisible: async () => true })
          };
        }
        return { count: async () => 0 };
      }
    };

    await waitForMuseWaitlistScreen({
      page: mockPageEnglishWaitlist,
      stepName: 'test-english-waitlist',
      timeoutMs: 1000
    });
    console.log('  ✔ Tab B phát hiện và xác nhận hiển thị "Join the waitlist for Muse" thành công.');

    // 31.2: Tab C Two-factor authentication tiếng Anh: [aria-label="Two-factor authentication"]
    let englishTwoFactorDetected = false;
    const mockPageEnglishMeta: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel === '[aria-label="Two-factor authentication"]') {
          englishTwoFactorDetected = true;
          return {
            count: async () => 1,
            first: () => ({ isVisible: async () => true }),
            nth: () => ({ isVisible: async () => true })
          };
        }
        return { count: async () => 0 };
      }
    };

    await waitForMetaSecurityPageReady({
      page: mockPageEnglishMeta,
      stepName: 'test-english-meta',
      timeoutMs: 1000
    });
    assert.strictEqual(englishTwoFactorDetected, true);
    console.log('  ✔ Tab C nhận diện [aria-label="Two-factor authentication"] tiếng Anh thành công.');
  }

  // ==========================================
  // Test 32: Kiểm tra chọn "Contact info" trên TabC (clickContactInfoOnTabC)
  // ==========================================
  console.log('\n32. Kiểm tra chọn "Contact info" trên TabC (clickContactInfoOnTabC):');
  {
    // 32.1: Click đúng 1 lần và chờ khu vực xuất hiện theo điều kiện DOM
    let contactInfoClicked = 0;
    const mockPageContactInfo: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel === '[aria-label="Contact info"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                contactInfoClicked++;
              }
            })
          };
        }
        if (sel === ':text("Add mobile number")' || sel === '[aria-label="Add mobile number"]') {
          return {
            count: async () => (contactInfoClicked > 0 ? 1 : 0),
            nth: () => ({
              isVisible: async () => contactInfoClicked > 0
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await clickContactInfoOnTabC({
      page: mockPageContactInfo,
      stepName: 'test-click-contact-info',
      timeoutMs: 2000
    });
    assert.strictEqual(contactInfoClicked, 1, 'Phải click đúng một lần vào [aria-label="Contact info"]');
    console.log('  ✔ Click [aria-label="Contact info"] đúng 1 lần và chờ khu vực thông tin liên hệ xuất hiện theo DOM thành công.');

    // 32.2: Báo lỗi khi khớp nhiều hơn 1 phần tử [aria-label="Contact info"] hiển thị
    let errorMultipleCaught = false;
    const mockPageMultipleContactInfo: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel === '[aria-label="Contact info"]') {
          return {
            count: async () => 2,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    try {
      await clickContactInfoOnTabC({
        page: mockPageMultipleContactInfo,
        stepName: 'test-multi-contact-info',
        timeoutMs: 500
      });
    } catch (err: any) {
      if (err.message.includes('[LỖI SELECTOR]') && err.message.includes('khớp 2 phần tử hiển thị')) {
        errorMultipleCaught = true;
      }
    }
    assert.strictEqual(errorMultipleCaught, true, 'Phải dừng báo lỗi khi có nhiều phần tử Contact info');
    console.log('  ✔ Báo lỗi chính xác khi không thể xác định duy nhất phần tử Contact info (không dùng .first()).');
  }

  // ==========================================
  // Test 33: Kiểm tra xử lý role="presentation" và chọn "Add mobile number" (clickAddMobileNumberOnTabC)
  // ==========================================
  console.log('\n33. Kiểm tra xử lý role="presentation" và chọn "Add mobile number" (clickAddMobileNumberOnTabC):');
  {
    // 33.1: Dùng role="presentation" làm container scope, click nút interactive "Add mobile number", chờ form hiển thị
    let addMobileClicked = 0;
    const mockPageAddMobile: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel.includes('[role="presentation"]')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              innerText: async () => 'Add mobile number\nAdd a phone number to your accounts',
              locator: () => ({ count: async () => 0 }),
              getByRole: (role: string, opts?: any) => {
                if (role === 'button' && opts?.name === 'Add mobile number') {
                  return {
                    count: async () => 1,
                    nth: () => ({
                      isVisible: async () => true,
                      isEnabled: async () => true,
                      click: async () => {
                        addMobileClicked++;
                      }
                    })
                  };
                }
                return { count: async () => 0 };
              },
              locator: () => ({ count: async () => 0 })
            })
          };
        }
        if (sel === 'input[type="tel"]') {
          return {
            count: async () => (addMobileClicked > 0 ? 1 : 0),
            nth: () => ({
              isVisible: async () => addMobileClicked > 0
            })
          };
        }
        return { count: async () => 0 };
      },
      getByRole: (role: string, opts?: any) => {
        if (role === 'button' && opts?.name === 'Add mobile number') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                addMobileClicked++;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await clickAddMobileNumberOnTabC({
      page: mockPageAddMobile,
      stepName: 'test-click-add-mobile',
      timeoutMs: 2000
    });
    assert.strictEqual(addMobileClicked, 1, 'Phải click nút Add mobile number đúng một lần');
    console.log('  ✔ Xử lý role="presentation" làm container scope, click nút tương tác "Add mobile number" thành công.');

    // 33.2: Dừng an toàn khi xuất hiện bước chọn tài khoản chưa được mô tả
    let accountSelectCaught = false;
    const mockPageAccountSelect: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel === '[role="presentation"]') {
          return { count: async () => 0 };
        }
        if (sel.includes('Choose account')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true
            })
          };
        }
        if (sel === 'input[type="tel"]') {
          return { count: async () => 0 };
        }
        return { count: async () => 0 };
      },
      getByRole: (role: string, opts?: any) => {
        if (role === 'button' && opts?.name === 'Add mobile number') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {}
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    try {
      await clickAddMobileNumberOnTabC({
        page: mockPageAccountSelect,
        stepName: 'test-account-select',
        timeoutMs: 1000
      });
    } catch (err: any) {
      if (err.message.includes('Xuất hiện bước chọn tài khoản chưa được mô tả')) {
        accountSelectCaught = true;
      }
    }
    assert.strictEqual(accountSelectCaught, true, 'Phải dừng để người dùng xử lý khi có bước chọn tài khoản');
    console.log('  ✔ Tự động dừng an toàn khi gặp bước chọn tài khoản chưa được mô tả.');

    // 33.3: Click thẻ "Add new contact info" trước khi chọn "Add mobile number"
    let clickedAddNewContactInfoCard = false;
    let clickedAddMobileInMenu = false;
    let inputTelVisibleAfterMenu = false;

    const mockPageNewContactCard: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel.includes('Add new contact info')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              innerText: async () => 'Add new contact info',
              locator: () => ({ count: async () => 0 }),
              click: async () => {
                clickedAddNewContactInfoCard = true;
              }
            })
          };
        }
        if (sel.includes('Add mobile number')) {
          return {
            count: async () => (clickedAddNewContactInfoCard ? 1 : 0),
            nth: () => ({
              isVisible: async () => clickedAddNewContactInfoCard,
              isEnabled: async () => true,
              innerText: async () => 'Add mobile number',
              locator: () => ({ count: async () => 0 }),
              click: async () => {
                clickedAddMobileInMenu = true;
                inputTelVisibleAfterMenu = true;
              }
            })
          };
        }
        if (sel === 'input[type="tel"]') {
          return {
            count: async () => (inputTelVisibleAfterMenu ? 1 : 0),
            nth: () => ({
              isVisible: async () => inputTelVisibleAfterMenu
            })
          };
        }
        return { count: async () => 0 };
      },
      getByRole: (role: string, opts?: any) => {
        if (role === 'button' && opts?.name === 'Add new contact info') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                clickedAddNewContactInfoCard = true;
              }
            })
          };
        }
        if (role === 'button' && opts?.name === 'Add mobile number') {
          return {
            count: async () => (clickedAddNewContactInfoCard ? 1 : 0),
            nth: () => ({
              isVisible: async () => clickedAddNewContactInfoCard,
              isEnabled: async () => true,
              click: async () => {
                clickedAddMobileInMenu = true;
                inputTelVisibleAfterMenu = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await clickAddMobileNumberOnTabC({
      page: mockPageNewContactCard,
      stepName: 'test-click-card-then-mobile',
      timeoutMs: 2000
    });
    assert.strictEqual(clickedAddNewContactInfoCard, true, 'Phải click thẻ Add new contact info');
    assert.strictEqual(clickedAddMobileInMenu, true, 'Phải click Add mobile number trong menu sau khi click thẻ');
    console.log('  ✔ Click thẻ "Add new contact info" và sau đó chọn "Add mobile number" thành công.');
  }

  // ==========================================
  // Test 34: Kiểm tra nhập lại số điện thoại đã chọn vào Add mobile number (inputReenterPhoneOnTabC)
  // ==========================================
  console.log('\n34. Kiểm tra nhập lại số điện thoại đã chọn vào Add mobile number (inputReenterPhoneOnTabC):');
  {
    const testPhone = '+84987654321';
    let enteredValue = '';
    const loggedMessages: string[] = [];
    const testLogger: any = {
      info: (msg: string) => loggedMessages.push(msg),
      warn: () => {},
      error: () => {}
    };

    // 34.1: Nhập lại số đã chọn, kiểm tra giá trị khớp, log che số, không click submit
    const mockPageInputReenter: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel === 'input[type="tel"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              fill: async (v: string) => {
                enteredValue = v;
              },
              inputValue: async () => enteredValue,
              evaluate: async () => true
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    await inputReenterPhoneOnTabC({
      page: mockPageInputReenter,
      stepName: 'test-reenter-phone',
      phone: testPhone,
      timeoutMs: 2000,
      logger: testLogger
    });

    assert.strictEqual(enteredValue, testPhone, 'Số điện thoại nhập vào phải giữ nguyên string, dấu + và các số 0');
    assert.ok(
      loggedMessages.some((m) => m.includes('Đã nhập lại số điện thoại đã chọn vào Add mobile number.')),
      'Phải ghi log hoàn thành đúng thông điệp quy định'
    );
    assert.ok(
      !loggedMessages.some((m) => m.includes('+84987654321')),
      'Số điện thoại trong log phải được che (mask) bảo vệ quyền riêng tư'
    );
    console.log('  ✔ Điền lại số điện thoại đã chọn, bảo toàn dấu +, xác minh giá trị và mask log thành công.');

    // 34.2: Lỗi khi selectedPhone rỗng
    let emptyPhoneCaught = false;
    try {
      await inputReenterPhoneOnTabC({
        page: mockPageInputReenter,
        stepName: 'test-empty-phone',
        phone: '',
        timeoutMs: 500
      });
    } catch (err: any) {
      if (err.message.includes('selectedPhone đã chọn từ các bước trước hoặc số rỗng')) {
        emptyPhoneCaught = true;
      }
    }
    assert.strictEqual(emptyPhoneCaught, true, 'Phải báo lỗi khi selectedPhone không tồn tại');
    console.log('  ✔ Dừng báo lỗi chính xác khi không tìm thấy số điện thoại đã chọn trước đó.');

    // 34.3: Lỗi khi giá trị nhập vào không khớp
    let mismatchCaught = false;
    const mockPageMismatch: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      locator: (sel: string) => {
        if (sel === 'input[type="tel"]') {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEditable: async () => true,
              isEnabled: async () => true,
              fill: async () => {},
              inputValue: async () => '+84111111111',
              evaluate: async () => true
            })
          };
        }
        return { count: async () => 0 };
      }
    };

    try {
      await inputReenterPhoneOnTabC({
        page: mockPageMismatch,
        stepName: 'test-mismatch-phone',
        phone: testPhone,
        timeoutMs: 500
      });
    } catch (err: any) {
      if (err.message.includes('[LỖI GIÁ TRỊ SỐ ĐIỆN THOẠI]')) {
        mismatchCaught = true;
      }
    }
    assert.strictEqual(mismatchCaught, true, 'Phải báo lỗi khi giá trị input không khớp với selectedPhone');
    console.log('  ✔ Dừng báo lỗi chính xác khi giá trị trong ô input không khớp với selectedPhone.');
  }

  // ==========================================
  // Test 35: Kiểm tra chọn span "Next", đợi tải xong trên TabC và kích hoạt lại TabB
  // ==========================================
  console.log('\n35. Kiểm tra chọn span "Next", đợi tải xong trên TabC và kích hoạt lại TabB:');
  {
    // 35.1: clickNextSpanOnTabC thành công
    let nextSpanClicked = false;
    let loadStateWaited = false;
    const loggedMessages: string[] = [];
    const testLogger: any = {
      info: (msg: string) => loggedMessages.push(msg),
      warn: () => {},
      error: () => {}
    };

    const mockPageNext: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      waitForLoadState: async (state: string) => {
        if (state === 'load' || state === 'networkidle') {
          loadStateWaited = true;
        }
      },
      getByRole: (role: string, opts?: any) => {
        if (role === 'button' && (opts?.name === 'Next' || opts?.name === 'Tiếp')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => true,
              click: async () => {
                nextSpanClicked = true;
              }
            })
          };
        }
        return { count: async () => 0 };
      },
      locator: (sel: string) => {
        if (sel === 'span') {
          return {
            count: async () => 1,
            filter: () => ({
              count: async () => 1,
              nth: () => ({
                isVisible: async () => true,
                innerText: async () => 'Next',
                textContent: async () => 'Next',
                locator: () => ({
                  count: async () => 1,
                  first: () => ({
                    isVisible: async () => true,
                    isEnabled: async () => true,
                    click: async () => {
                      nextSpanClicked = true;
                    }
                  })
                })
              })
            })
          };
        }
        if (sel.includes('progressbar')) {
          return {
            count: async () => 0
          };
        }
        return { count: async () => 0 };
      }
    };

    await clickNextSpanOnTabC({
      page: mockPageNext,
      stepName: 'test-click-next-span',
      timeoutMs: 2000,
      logger: testLogger
    });

    assert.strictEqual(nextSpanClicked, true, 'Nút có span Next phải được click');
    assert.strictEqual(loadStateWaited, true, 'Phải chờ tải trang (waitForLoadState) sau khi click Next');
    assert.ok(
      loggedMessages.some((m) => m.includes('TabC: Đã chọn span "Next" và hoàn tất chờ tải trang.')),
      'Phải ghi log hoàn thành click Next'
    );
    console.log('  ✔ Chọn span "Next", click và đợi tải trang thành công.');

    // 35.2: Báo lỗi khi nút Next bị disabled
    let disabledCaught = false;
    const mockPageDisabledNext: any = {
      isClosed: () => false,
      title: async () => 'Meta Accounts Center',
      getByRole: (role: string, opts?: any) => {
        if (role === 'button' && (opts?.name === 'Next' || opts?.name === 'Tiếp')) {
          return {
            count: async () => 1,
            nth: () => ({
              isVisible: async () => true,
              isEnabled: async () => false,
              click: async () => {}
            })
          };
        }
        return { count: async () => 0 };
      },
      locator: () => ({ count: async () => 0 })
    };

    try {
      await clickNextSpanOnTabC({
        page: mockPageDisabledNext,
        stepName: 'test-disabled-next',
        timeoutMs: 500
      });
    } catch (err: any) {
      if (err.message.includes('Nút "Next" / "Tiếp" đang bị vô hiệu hóa (disabled)')) {
        disabledCaught = true;
      }
    }
    assert.strictEqual(disabledCaught, true, 'Phải báo lỗi khi nút Next bị vô hiệu hóa');
    console.log('  ✔ Báo lỗi an toàn khi nút Next bị disable.');

    // 35.3: Kích hoạt lại TabB (activateTabB)
    let pageBBroughtToFront = false;
    const mockPageB: any = {
      isClosed: () => false,
      bringToFront: async () => {
        pageBBroughtToFront = true;
      }
    };

    await activateTabB({
      pageB: mockPageB,
      stepName: 'test-activate-tabB',
      logger: testLogger
    });

    assert.strictEqual(pageBBroughtToFront, true, 'Phương thức bringToFront() trên TabB phải được gọi');
    console.log('  ✔ Kích hoạt TabB làm tab hiện hành (bringToFront) thành công.');

    // 35.4: activateTabB báo lỗi khi TabB đã bị đóng
    let closedTabBCaught = false;
    const mockClosedPageB: any = {
      isClosed: () => true,
      bringToFront: async () => {}
    };

    try {
      await activateTabB({
        pageB: mockClosedPageB,
        stepName: 'test-closed-tabB'
      });
    } catch (err: any) {
      if (err.message.includes('[LỖI TAB ĐÃ ĐÓNG] TabB không tồn tại hoặc đã bị đóng')) {
        closedTabBCaught = true;
      }
    }
    assert.strictEqual(closedTabBCaught, true, 'Phải báo lỗi khi TabB đã bị đóng');
    console.log('  ✔ Báo lỗi chính xác khi TabB đã bị đóng.');
  }

  console.log('\n--- TẤT CẢ BÀI KIỂM TRA LUỒNG YOPMAIL-MUSE (TÍCH HỢP TEMP-MAIL) ĐÃ VƯỢT QUA! ---');
}

runTests().catch((err) => {
  console.error('Lỗi khi chạy kiểm tra yopmail-muse:', err);
  process.exit(1);
});
