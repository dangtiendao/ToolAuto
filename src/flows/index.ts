import { registerFlow } from './registry';
import { demoFlow } from './demo.flow';
import { yopmailMuseFlow } from './yopmail-muse.flow';
import { proxySwitchDemoFlow } from './proxy-switch-demo.flow';

// Đăng ký các luồng mặc định vào hệ thống
registerFlow(demoFlow);
registerFlow(yopmailMuseFlow);
registerFlow(proxySwitchDemoFlow);

export * from './registry';
export * from './demo.flow';
export * from './yopmail-muse.flow';
export * from './proxy-switch-demo.flow';
