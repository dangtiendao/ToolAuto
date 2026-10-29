import { Page } from 'playwright';
import { AppConfig } from '../config/types';
import { Logger } from '../utils/logger';
import type { BrowserManager } from '../browser/manager';

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
}

export interface Step {
  id: string;
  name: string;
  execute: (context: FlowContext) => Promise<void>;
  verify?: (context: FlowContext) => Promise<boolean>;
}

export interface Flow {
  name: string;
  description?: string;
  steps: Step[];
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
