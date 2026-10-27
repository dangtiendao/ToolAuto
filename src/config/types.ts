export interface RawProxyConfig {
  enabled?: boolean;
  server?: string;
  bypass?: string;
}

export interface RawConfig {
  startUrl?: unknown;
  profileDir?: unknown;
  navigationTimeoutMs?: unknown;
  actionTimeoutMs?: unknown;
  flowName?: unknown;
  screenshotOnError?: unknown;
  proxy?: RawProxyConfig;
}

export interface ProxyConfig {
  enabled: boolean;
  server?: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export interface AppConfig {
  startUrl: string;
  profileDir: string;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  flowName: string;
  screenshotOnError: boolean;
  proxy: ProxyConfig;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  config?: AppConfig;
}
