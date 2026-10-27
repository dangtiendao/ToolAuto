import { BrowserContext, Page } from 'playwright';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export interface PlaywrightProxyOptions {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}
