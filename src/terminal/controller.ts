import * as readline from 'readline';
import { WorkerScheduler } from '../worker/scheduler';

export class TerminalController {
  private readonly scheduler: WorkerScheduler;
  private rl: readline.Interface | null = null;
  private isListening: boolean = false;

  constructor(scheduler: WorkerScheduler) {
    this.scheduler = scheduler;
  }

  /**
   * Bắt đầu lắng nghe lệnh từ standard input (chỉ duy nhất một bộ đọc stdin cho toàn ứng dụng).
   */
  public startListening(): void {
    if (this.isListening) return;

    if (!process.stdin.isTTY) {
      // Trong môi trường CI/test không có TTY, không mở readline để tránh treo
      return;
    }

    this.isListening = true;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'ToolAuto> '
    });

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          const response = await this.handleCommand(trimmed);
          if (response) {
            console.log(response);
          }
        } catch (err) {
          console.error(`[TERMINAL ERROR] ${(err as Error).message}`);
        }
      }
      if (this.rl) {
        this.rl.prompt();
      }
    });

    this.rl.on('close', () => {
      this.isListening = false;
      this.rl = null;
    });
  }

  /**
   * Đóng bộ đọc terminal.
   */
  public close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.isListening = false;
  }

  /**
   * Xử lý lệnh terminal (dùng chung cho cả stdin trực tiếp và test kiểm thử).
   */
  public async handleCommand(cmdLine: string): Promise<string> {
    const parts = cmdLine.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const targetWorkerId = parts[1];

    switch (command) {
      case 'status': {
        const activeWorkers = this.scheduler.getActiveWorkers();
        const allWorkers = this.scheduler.getAllWorkers();
        const queued = this.scheduler.getQueuedJobs();
        const maxConc = this.scheduler.getMaxConcurrency();

        const lines: string[] = [];
        lines.push(`=================== TRẠNG THÁI HỆ THỐNG ===================`);
        lines.push(`Đang chiếm slot: ${activeWorkers.length}/${maxConc} | Hàng đợi chờ: ${queued.length} job`);

        if (allWorkers.length === 0 && queued.length === 0) {
          lines.push(`Hiện chưa có worker nào được khởi tạo.`);
        } else {
          for (const w of allWorkers) {
            lines.push(
              `  - [${w.workerId}] Job: ${w.job.id} | Luồng: ${w.job.flowName} | Mode: ${w.getConnectionMode()} | Trạng thái: ${w.getStatus()} | Bước: ${w.getCurrentStep()}`
            );
          }
        }

        if (queued.length > 0) {
          lines.push(`Danh sách job trong hàng đợi:`);
          for (const q of queued) {
            lines.push(`  * Job: ${q.id} (Luồng: ${q.flowName}, Mode: ${q.connectionMode || 'direct'})`);
          }
        }
        lines.push(`==========================================================`);
        return lines.join('\n');
      }

      case 'resume': {
        if (!targetWorkerId) {
          return `[LỖI CÚ PHÁP] Vui lòng chỉ định workerId cần resume.\nVí dụ: resume worker-1`;
        }

        const worker = this.scheduler.getWorker(targetWorkerId);
        if (!worker) {
          const available = this.scheduler.getAllWorkers().map((w) => w.workerId).join(', ') || 'không có';
          return `[LỖI] Không tìm thấy worker [${targetWorkerId}].\nCác worker hiện có: [${available}].`;
        }

        if (worker.getStatus() !== 'awaiting-human') {
          return `[CẢNH BÁO] Worker [${targetWorkerId}] đang ở trạng thái "${worker.getStatus()}". Chỉ có thể resume khi worker ở trạng thái "awaiting-human".`;
        }

        const resumed = this.scheduler.resumeWorker(targetWorkerId);
        if (resumed) {
          return `[TERMINAL] Đã gửi tín hiệu resume đến worker [${targetWorkerId}]. Worker đang kiểm tra lại điều kiện DOM (lưu ý: resume không mặc định coi là xác minh thành công).`;
        } else {
          return `[LỖI] Không thể resume worker [${targetWorkerId}].`;
        }
      }

      case 'stop': {
        if (!targetWorkerId) {
          return `[LỖI CÚ PHÁP] Vui lòng chỉ định workerId cần dừng.\nVí dụ: stop worker-1`;
        }

        const worker = this.scheduler.getWorker(targetWorkerId);
        if (!worker) {
          const available = this.scheduler.getAllWorkers().map((w) => w.workerId).join(', ') || 'không có';
          return `[LỖI] Không tìm thấy worker [${targetWorkerId}].\nCác worker hiện có: [${available}].`;
        }

        await this.scheduler.stopWorker(targetWorkerId);
        return `[TERMINAL] Đã gửi tín hiệu dừng và đóng trình duyệt của worker [${targetWorkerId}].`;
      }

      case 'close': {
        if (!targetWorkerId) {
          return `[LỖI CÚ PHÁP] Vui lòng chỉ định workerId cần đóng Chrome.\nVí dụ: close worker-1`;
        }

        const worker = this.scheduler.getWorker(targetWorkerId);
        if (!worker) {
          const available = this.scheduler.getAllWorkers().map((w) => w.workerId).join(', ') || 'không có';
          return `[LỖI] Không tìm thấy worker [${targetWorkerId}].\nCác worker hiện có: [${available}].`;
        }

        await this.scheduler.closeWorker(targetWorkerId);
        return `[TERMINAL] Đã đóng Chrome và giải phóng slot cho worker [${targetWorkerId}].`;
      }

      case 'stop-all': {
        await this.scheduler.stopAll();
        return `[TERMINAL] Đã hủy toàn bộ hàng đợi và đóng tất cả Chrome của công cụ.`;
      }

      default: {
        return (
          `[LỆNH KHÔNG HỢP LỆ] "${command}"\n` +
          `Các lệnh khả dụng:\n` +
          `  - status                 : Xem trạng thái tất cả worker và hàng đợi\n` +
          `  - resume <workerId>      : Tiếp tục worker đang chờ người dùng\n` +
          `  - stop <workerId>        : Dừng và hủy worker chỉ định\n` +
          `  - close <workerId>       : Đóng Chrome đã hoàn thành để giải phóng slot\n` +
          `  - stop-all               : Dừng toàn bộ các worker và thoát an toàn`
        );
      }
    }
  }
}
