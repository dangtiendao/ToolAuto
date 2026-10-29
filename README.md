# Chrome Automation Tool (Windows)

Công cụ tự động hóa Google Chrome trên Windows sử dụng Node.js LTS, TypeScript và Playwright.

---

## 1. Cài đặt lần đầu

Yêu cầu: Đã cài đặt **Google Chrome** tại `C:\Program Files\Google\Chrome\Application\chrome.exe` và **Node.js LTS** (phiên bản 18+ hoặc 20+).

Mở PowerShell tại thư mục dự án và chạy:
```powershell
npm install
```

---

## 2. Cấu hình chọn Profile Chrome thực tế

File cấu hình chính: `config/config.json`.

```json
{
  "startUrl": "https://example.com",
  "browser": {
    "profileName": "Profile 1",
    "cdpPort": 9222,
    "profiles": {
      "Profile 1": {
        "profileDirectory": "Profile 1"
      },
      "Default": {
        "profileDirectory": "Default"
      },
      "Profile 2": {
        "profileDirectory": "Profile 2"
      }
    }
  },
  "navigationTimeoutMs": 30000,
  "actionTimeoutMs": 15000,
  "flowName": "yopmail-muse",
  "screenshotOnError": true,
  "proxy": {
    "enabled": false,
    "server": "",
    "bypass": ""
  }
}
```

### Các thông số quan trọng:
- **`profileName`**: Tên profile bạn muốn tool sử dụng (ví dụ: `"Profile 1"`, `"Default"`, `"Profile 2"`...).
- **`profiles`**: Danh sách khai báo các Profile trong Chrome của bạn. Mỗi profile chỉ cần chỉ định `"profileDirectory"` tương ứng với thư mục profile trong Chrome (ví dụ: `"Profile 1"`).
- **Thư mục dữ liệu Chrome (`userDataDir`)**: Mặc định hệ thống tự động nhận diện thư mục dữ liệu Chrome của máy bạn tại:
  `%LOCALAPPDATA%\Google\Chrome\User Data`
  *(Bạn không cần khai báo lại đường dẫn này nếu dùng Chrome cá nhân thông thường).*
- **`cdpPort`**: Cổng kết nối Chrome DevTools Protocol (mặc định: `9222`).

---

## 3. Cách thức hoạt động với Google Chrome thật

Hệ thống kết nối trực tiếp vào Google Chrome thông qua giao thức **Remote Debugging Port (CDP)**:

1. **Khởi chạy tự động:**
   - Khi bạn chạy tool (`run.bat` hoặc `npm start`), tool sẽ tự động khởi chạy Chrome từ:
     `C:\Program Files\Google\Chrome\Application\chrome.exe`
     kèm cờ `--remote-debugging-port=9222` và mở đúng Profile bạn đã chọn (ví dụ: `Profile 1`).
   - Mọi tài khoản, cookie, lịch sử và extension trong Profile đó đều được giữ nguyên 100%.

2. **Nếu Chrome đang mở sẵn trên máy:**
   - Nếu Chrome đã được mở sẵn kèm cổng 9222, tool sẽ kết nối trực tiếp vào cửa sổ Chrome đó mà **không cần đóng các tab bạn đang làm việc**.
   - Nếu Chrome đang mở bình thường (chưa bật cổng 9222), bạn có 2 cách:
     - **Cách 1 (Nhanh nhất):** Đóng tất cả cửa sổ Chrome lại, sau đó chạy `npm start` (hoặc click `run.bat`). Tool sẽ tự mở Chrome kèm cổng 9222 và profile đã chọn.
     - **Cách 2:** Khởi động Chrome bằng phím tắt / Command Prompt kèm cờ:
       ```cmd
       "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --profile-directory="Profile 1"
       ```
       *(Sau khi mở bằng lệnh này, bạn có thể chạy tool bất cứ lúc nào mà không cần khởi động lại Chrome).*

---

## 4. Cách chạy chương trình

### Cách 1: Khởi chạy nhanh bằng `run.bat`
Nhấp đúp chuột vào file **`run.bat`** tại thư mục gốc dự án.

### Cách 2: Khởi chạy bằng PowerShell / Terminal
```powershell
# Chạy trực tiếp qua tsx:
npm run dev

# Hoặc biên dịch rồi chạy:
npm run build
npm start

# Chạy kiểm thử tự động toàn diện:
npm test
```

---

## 5. Các luồng nghiệp vụ có sẵn

1. **`demo`**: Mở trang `startUrl`, kiểm tra DOM, ghi nhận tiêu đề và URL.
2. **`yopmail-muse`**: Luồng tuần tự tự động hóa trên các tab:
   - TabA: Tạo hộp thư ngẫu nhiên trên YOPmail.
   - TabB: Mở Muse.ai, gửi mã OTP đến hộp thư YOPmail.
   - TabA: Lấy mã OTP 6 số từ hộp thư YOPmail.
   - TabB: Nhập mã OTP, nhập First name "Dang", Last name "Dao", chọn năm sinh 2000 và bấm tiếp tục.
   - TabC: Mở trang bảo mật Meta (`https://accountscenter.meta.com/password_and_security`), chọn xác thực 2 yếu tố qua SMS hoặc WhatsApp, nhập số điện thoại ngẫu nhiên từ danh sách file TXT, chờ màn hình "Nhập mã xác nhận" hiển thị rồi bấm "Đóng".
3. **`proxy-switch-demo`**: Luồng kiểm tra bật/tắt proxy an toàn giữa các giai đoạn kết nối.

---

## 6. Cấu hình danh sách số điện thoại (Cho TabC Meta)

- **`phoneNumbersFile`**: Đường dẫn tới file TXT chứa danh sách số điện thoại (mỗi dòng một số). Mặc định: `"phone-numbers.example.txt"`.
- **`phoneMode`**: Chế độ chạy:
  - `"mock"` (mặc định): Phục vụ kiểm thử cục bộ/mock, không gửi mã SMS/WhatsApp thật đến Meta.
  - `"live"`: Chỉ sử dụng cho tài khoản và số điện thoại được phép quản lý. Luôn yêu cầu người dùng xác nhận thủ công trong terminal trước khi gửi mã.

> [!CAUTION]
> **CẢNH BÁO VỀ DỮ LIỆU MẪU:**
> Dữ liệu trong file `phone-numbers.example.txt` là dữ liệu giả lập chỉ phục vụ mục đích kiểm thử cục bộ và chạy thử nghiệm. **TUYỆT ĐỐI KHÔNG DÙNG DỮ LIỆU MẪU NÀY TRÊN HỆ THỐNG META THẬT.**
> Khi sử dụng thực tế, người dùng phải tự tạo file danh sách số điện thoại riêng thuộc quyền sở hữu của mình và thêm file đó vào `.gitignore`.

