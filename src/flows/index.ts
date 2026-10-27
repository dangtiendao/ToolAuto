import { registerFlow } from './registry';
import { demoFlow } from './demo.flow';

// Đăng ký các luồng mặc định vào hệ thống
registerFlow(demoFlow);

export * from './registry';
export * from './demo.flow';
