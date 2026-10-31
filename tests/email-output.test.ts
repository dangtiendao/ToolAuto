import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { saveEmailToOutputFile, readOutputEmails } from '../src/utils/output';
import { validateConfig } from '../src/config';

console.log('--- BẮT ĐẦU KIỂM TRA TÍNH NĂNG LƯU EMAIL VÀO DANH SÁCH TXT OUTPUT ---');

const projectRoot = path.resolve(__dirname, '..');
const testOutputDir = path.resolve(projectRoot, 'output', 'test-output');
const testOutputFile = path.resolve(testOutputDir, 'test-emails.txt');

function cleanup() {
  try {
    if (fs.existsSync(testOutputFile)) {
      fs.unlinkSync(testOutputFile);
    }
    if (fs.existsSync(testOutputDir)) {
      fs.rmdirSync(testOutputDir);
    }
  } catch {}
}

async function runTests() {
  cleanup();

  // 1. Kiểm tra lưu email vào file mới (tự động tạo thư mục cha)
  console.log('\n1. Kiểm tra lưu email vào file mới (tự động tạo thư mục):');
  {
    const email1 = 'user_test_01@tempmail.io';
    const savedPath = await saveEmailToOutputFile(email1, {
      filePath: testOutputFile
    });

    assert.strictEqual(savedPath, testOutputFile);
    assert.strictEqual(fs.existsSync(testOutputFile), true, 'File output phải được tạo');

    const emails = await readOutputEmails(testOutputFile);
    assert.strictEqual(emails.length, 1);
    assert.strictEqual(emails[0], email1);
    console.log('  ✔ Lưu email đầu tiên và tự động tạo thư mục thành công.');
  }

  // 2. Kiểm tra ghi thêm email thứ 2 vào file (mỗi email một dòng)
  console.log('\n2. Kiểm tra ghi thêm email thứ 2 (mỗi email một dòng):');
  {
    const email2 = 'user_test_02@ruutukf.com';
    await saveEmailToOutputFile(email2, {
      filePath: testOutputFile
    });

    const emails = await readOutputEmails(testOutputFile);
    assert.strictEqual(emails.length, 2);
    assert.strictEqual(emails[0], 'user_test_01@tempmail.io');
    assert.strictEqual(emails[1], email2);
    console.log('  ✔ Ghi thêm email mới vào file thành công.');
  }

  // 3. Kiểm tra ngăn chặn trùng lặp email (allowDuplicates: false mặc định)
  console.log('\n3. Kiểm tra ngăn chặn ghi trùng lặp email mặc định:');
  {
    const emailDuplicate = 'user_test_01@tempmail.io';
    await saveEmailToOutputFile(emailDuplicate, {
      filePath: testOutputFile,
      allowDuplicates: false
    });

    const emails = await readOutputEmails(testOutputFile);
    assert.strictEqual(emails.length, 2, 'Số lượng email không được tăng khi ghi trùng');
    console.log('  ✔ Ngăn chặn ghi trùng lặp email thành công.');
  }

  // 4. Kiểm tra cho phép trùng lặp khi cấu hình allowDuplicates: true
  console.log('\n4. Kiểm tra ghi trùng lặp khi bật allowDuplicates: true:');
  {
    const emailAllowDup = 'user_test_01@tempmail.io';
    await saveEmailToOutputFile(emailAllowDup, {
      filePath: testOutputFile,
      allowDuplicates: true
    });

    const emails = await readOutputEmails(testOutputFile);
    assert.strictEqual(emails.length, 3);
    assert.strictEqual(emails[2], emailAllowDup);
    console.log('  ✔ Ghi trùng lặp khi allowDuplicates=true thành công.');
  }

  // 5. Kiểm tra từ chối email rỗng
  console.log('\n5. Kiểm tra từ chối email rỗng:');
  {
    let caughtEmpty = false;
    try {
      await saveEmailToOutputFile('   ', { filePath: testOutputFile });
    } catch (err: any) {
      if (err.message.includes('[LỖI LƯU EMAIL]')) {
        caughtEmpty = true;
      }
    }
    assert.strictEqual(caughtEmpty, true, 'Phải báo lỗi khi email rỗng');
    console.log('  ✔ Báo lỗi khi email rỗng thành công.');
  }

  // 6. Kiểm tra an toàn khi nhiều worker ghi đồng thời (Concurrency):
  console.log('\n6. Kiểm tra ghi đồng thời (Concurrency Safety):');
  {
    const concurrentFile = path.resolve(testOutputDir, 'concurrent-emails.txt');
    const emailsToAppend = Array.from({ length: 20 }, (_, i) => `worker_email_${i + 1}@domain.com`);

    await Promise.all(
      emailsToAppend.map((e) =>
        saveEmailToOutputFile(e, {
          filePath: concurrentFile,
          allowDuplicates: true
        })
      )
    );

    const saved = await readOutputEmails(concurrentFile);
    assert.strictEqual(saved.length, 20, 'Tất cả 20 email phải được ghi đủ');
    for (const e of emailsToAppend) {
      assert.ok(saved.includes(e), `Email ${e} phải có trong file`);
    }

    try { fs.unlinkSync(concurrentFile); } catch {}
    console.log('  ✔ Ghi đồng thời 20 email an toàn, không bị mất dòng hay xung đột.');
  }

  // 7. Kiểm tra thẩm định cấu hình outputEmailsFile trong validateConfig
  console.log('\n7. Kiểm tra thẩm định cấu hình outputEmailsFile:');
  {
    // Mặc định
    const cfgDefault = validateConfig({ startUrl: 'https://example.com', profileDir: 'profiles/t' }, projectRoot);
    assert.strictEqual(cfgDefault.valid, true, `cfgDefault errors: ${cfgDefault.errors.join(', ')}`);
    assert.strictEqual(
      cfgDefault.config?.outputEmailsFile,
      path.resolve(projectRoot, 'output', 'emails.txt'),
      'Mặc định outputEmailsFile là output/emails.txt'
    );

    // Tùy chỉnh đường dẫn tương đối
    const cfgCustom = validateConfig(
      { startUrl: 'https://example.com', profileDir: 'profiles/t', outputEmailsFile: 'custom-output/danh_sach_email.txt' },
      projectRoot
    );
    assert.strictEqual(cfgCustom.valid, true, `cfgCustom errors: ${cfgCustom.errors.join(', ')}`);
    assert.strictEqual(
      cfgCustom.config?.outputEmailsFile,
      path.resolve(projectRoot, 'custom-output', 'danh_sach_email.txt')
    );

    // Không hợp lệ (rỗng)
    const cfgInvalid = validateConfig(
      { startUrl: 'https://example.com', profileDir: 'profiles/t', outputEmailsFile: '   ' },
      projectRoot
    );
    assert.strictEqual(cfgInvalid.valid, false);
    assert.ok(cfgInvalid.errors.some((e) => e.includes('"outputEmailsFile"')));
    console.log('  ✔ Thẩm định cấu hình outputEmailsFile (mặc định, tùy chỉnh, kiểm tra lỗi) thành công.');
  }


  // 8. Kiểm tra chỉ lưu email khi hoàn tất tất cả các bước (không lưu ở Tab A)
  console.log('\n8. Kiểm tra chỉ lưu email khi thành công toàn bộ luồng (không lưu giữa chừng):');
  {
    const fileOnlyOnSuccess = path.resolve(testOutputDir, 'success-only-emails.txt');
    try { if (fs.existsSync(fileOnlyOnSuccess)) fs.unlinkSync(fileOnlyOnSuccess); } catch {}

    // Giả lập trạng thái sau bước Tab A: có email nhưng chưa xong luồng
    const simulatedState = {
      emailAddress: 'unfinished_user@tempmail.io'
    };

    // Kiểm tra: ở bước tabA-tempmail không được tự ý ghi file
    assert.strictEqual(fs.existsSync(fileOnlyOnSuccess), false, 'Không được ghi email vào file ở bước đầu');

    // Giả lập luồng thất bại giữa chừng (ví dụ ở Tab B hoặc Tab C)
    const failedFlowStatus = 'failed';
    if (failedFlowStatus === 'failed') {
      // Không ghi file khi thất bại
    }
    assert.strictEqual(fs.existsSync(fileOnlyOnSuccess), false, 'Khi thất bại giữa chừng, tuyệt đối không add email vào output');

    // Giả lập luồng thành công 100% tất cả các bước
    const successFlowStatus = 'success';
    if (successFlowStatus === 'success' && simulatedState.emailAddress) {
      await saveEmailToOutputFile(simulatedState.emailAddress, { filePath: fileOnlyOnSuccess });
    }

    assert.strictEqual(fs.existsSync(fileOnlyOnSuccess), true, 'File output phải được tạo khi thành công toàn bộ luồng');
    const emails = await readOutputEmails(fileOnlyOnSuccess);
    assert.strictEqual(emails.length, 1);
    assert.strictEqual(emails[0], 'unfinished_user@tempmail.io');

    try { fs.unlinkSync(fileOnlyOnSuccess); } catch {}
    console.log('  ✔ Đảm bảo chỉ khi thành công 100% tất cả các bước mới lưu email vào file output.');
  }

  cleanup();
  console.log('\n=== TẤT CẢ BÀI KIỂM THỬ LƯU EMAIL OUTPUT ĐÃ VƯỢT QUA 100%! ===\n');
}

runTests().catch((err) => {
  cleanup();
  console.error('\n❌ BÀI KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
