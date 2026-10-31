export interface RawProxyConfig {
  enabled?: boolean;
  server?: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export interface RawProfileDefinition {
  userDataDir?: unknown;
  profileDirectory?: unknown;
}

export interface RawBrowserConfig {
  profileName?: unknown;
  cdpPort?: unknown;
  userDataDir?: unknown;
  profiles?: Record<string, RawProfileDefinition>;
}

export type BrowserMode = 'incognito' | 'persistent';

export type WindowSizeConfig =
  | 'maximized'
  | { width: number; height: number };

export interface WindowPositionConfig {
  x: number;
  y: number;
}

export interface RawJobConfig {
  id?: unknown;
  flowName?: unknown;
  connectionMode?: unknown;
  data?: unknown;
}

export interface JobConfig {
  id: string;
  flowName: string;
  connectionMode?: 'direct' | 'proxy';
  data?: Record<string, unknown>;
}

export interface RawConfig {
  startUrl?: unknown;
  profileDir?: unknown; // Cấu hình cũ (legacy)
  browser?: RawBrowserConfig; // Cấu hình mới (theo tên profile)
  navigationTimeoutMs?: unknown;
  actionTimeoutMs?: unknown;
  flowName?: unknown;
  screenshotOnError?: unknown;
  initialConnectionMode?: unknown;
  proxyCheckUrl?: unknown;
  proxy?: RawProxyConfig;
  phoneNumbersFile?: unknown;
  outputEmailsFile?: unknown;
  phoneMode?: unknown;
  incognito?: unknown;
  browserMode?: unknown;
  maxConcurrency?: unknown;
  jobs?: unknown;
  pageLoadMaxRetries?: unknown;
  pageLoadRetryDelayMs?: unknown;
  autoCloseOnComplete?: unknown;
  windowSize?: unknown;
  windowPosition?: unknown;
}

export interface ProxyConfig {
  enabled: boolean;
  server?: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export interface ProfileDefinition {
  userDataDir?: string;
  profileDirectory: string;
}

export interface BrowserProfilesConfig {
  profileName: string;
  cdpPort?: number;
  userDataDir?: string;
  profiles: Record<string, ProfileDefinition>;
}

export interface SelectedProfile {
  profileName: string;
  userDataDir: string;
  profileDirectory: string;
  fullPath: string;
  cdpPort: number;
}

export interface AppConfig {
  startUrl: string;
  profileDir: string;
  browser?: BrowserProfilesConfig;
  selectedProfile: SelectedProfile;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  flowName: string;
  screenshotOnError: boolean;
  initialConnectionMode: 'direct' | 'proxy';
  proxyCheckUrl?: string;
  proxy: ProxyConfig;
  phoneNumbersFile?: string;
  outputEmailsFile?: string;
  phoneMode: 'mock' | 'live';
  incognito?: boolean;
  browserMode?: BrowserMode;
  maxConcurrency: number;
  jobs?: JobConfig[];
  pageLoadMaxRetries: number;
  pageLoadRetryDelayMs: number;
  autoCloseOnComplete?: boolean;
  windowSize?: WindowSizeConfig;
  windowPosition?: WindowPositionConfig;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  config?: AppConfig;
}
