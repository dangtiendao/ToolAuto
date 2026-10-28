import { registerFlow } from './registry';
import { demoFlow } from './demo.flow';
import { yopmailMuseFlow } from './yopmail-muse.flow';

// Đăng ký các luồng mặc định vào hệ thống
registerFlow(demoFlow);
registerFlow(yopmailMuseFlow);

export * from './registry';
export * from './demo.flow';
export * from './yopmail-muse.flow';
