import { Page } from 'playwright';
import { AppConfig } from '../config/types';
import { Logger } from '../utils/logger';
import type { BrowserManager } from '../browser/manager';
import type { TabManager } from '../worker/tab-manager';
import type { WorkerRuntime } from '../worker/types';

export interface CancellationToken {
  readonly isCancelled: boolean;
}

export interface FlowContext {
  page: Page;
  config: AppConfig;
  runId: string;
  logger: Logger;
  cancellationToken?: AbortSignal | CancellationToken;
  data?: Record<string, unknown>;
  browserManager?: BrowserManager;
  workerId?: string;
  jobId?: string;
  tabManager?: TabManager;
  runtime?: WorkerRuntime;
}

export interface Step {
  id: string;
  name: string;
  execute: (context: FlowContext) => Promise<void>;
  verify?: (context: FlowContext) => Promise<boolean>;
  shouldRun?: (context: FlowContext) => boolean;
}

export interface Flow {
  name: string;
  description?: string;
  steps: Step[];
  supportsConcurrency?: boolean;
}

export type FlowStatus = 'success' | 'failed' | 'cancelled';

export interface FlowResult {
  runId: string;
  flowName: string;
  status: FlowStatus;
  startedAt: string;
  finishedAt: string;
  completedSteps: string[];
  failedStep?: {
    id: string;
    name: string;
    screenshotPath?: string;
  };
  error?: string;
}
