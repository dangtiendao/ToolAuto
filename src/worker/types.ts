import { Browser, BrowserContext, Page } from 'playwright';
import { ConnectionMode } from '../browser/types';
import { TabManager } from './tab-manager';
import { WorkerLogger } from '../utils/worker-logger';

export type WorkerStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'awaiting-human'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closing'
  | 'closed';

export interface JobConfig {
  id: string;
  flowName: string;
  connectionMode?: ConnectionMode;
  data?: Record<string, unknown>;
}

export interface WorkerRuntime {
  workerId: string;
  runId: string;
  jobId: string;
  flowName: string;
  browser: Browser | null;
  context: BrowserContext | null;
  tabs: TabManager;
  connectionMode: ConnectionMode;
  abortController: AbortController;
  status: WorkerStatus;
  currentStep: string;
  data: Record<string, unknown>;
  logger: WorkerLogger;
  waitForHuman: (stepName: string, promptMessage?: string) => Promise<void>;
  resume: () => boolean;
}

export interface WorkerResult {
  workerId: string;
  jobId: string;
  runId: string;
  flowName: string;
  status: 'success' | 'failed' | 'cancelled';
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
