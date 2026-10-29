import { Browser, BrowserContext, Page } from 'playwright';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  browser?: Browser;
  executablePath?: string;
  isCdp?: boolean;
}

export interface PlaywrightProxyOptions {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export type ConnectionMode = 'direct' | 'proxy';

export interface SwitchModeOptions {
  checkUrl?: string;
  expectedIp?: string;
  timeoutMs?: number;
}
