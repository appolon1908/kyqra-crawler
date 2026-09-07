import { log } from '../observability/logger.js';

export type ShutdownTask = () => Promise<void>;

export interface ShutdownCoordinator {
  /** Aborts when shutdown begins, so in-flight work can stop claiming and wind down. */
  readonly signal: AbortSignal;
  isShuttingDown: () => boolean;
  /** Register a task to run during shutdown. Tasks run in registration order. */
  onShutdown: (name: string, task: ShutdownTask) => void;
  /** Run the shutdown sequence once, regardless of how many times it is triggered. */
  shutdown: (reason: string) => Promise<void>;
}

export interface ShutdownOptions {
  /** Hard limit on the whole sequence; exceeded means exit anyway rather than hang. */
  graceMs?: number;
  /** Installed for the process. Pass `[]` to manage signals yourself, as tests do. */
  signals?: NodeJS.Signals[];
  exit?: (code: number) => void;
  onProcess?: (signal: NodeJS.Signals, handler: () => void) => void;
}

const DEFAULT_GRACE_MS = 25_000;

/**
 * Coordinate an orderly stop.
 *
 * Container replacement sends SIGTERM and then kills the process. Without a handler the
 * worker died mid-request, leaving claimed frontier rows that only the visibility timeout
 * would recover and BullMQ jobs that had to stall before being retried. Registered tasks
 * stop new claims, let in-flight work settle, and release claims explicitly, so a deploy
 * neither loses work nor re-fetches it.
 */
export const createShutdownCoordinator = (options: ShutdownOptions = {}): ShutdownCoordinator => {
  const controller = new AbortController();
  const tasks: Array<{ name: string; task: ShutdownTask }> = [];
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  let running: Promise<void> | undefined;

  const runTasks = async (reason: string): Promise<void> => {
    log('info', 'shutdown_started', { reason, tasks: tasks.length });
    controller.abort();
    for (const { name, task } of tasks) {
      try {
        await task();
        log('info', 'shutdown_task_complete', { task: name });
      } catch (error: unknown) {
        log('warn', 'shutdown_task_failed', {
          task: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    log('info', 'shutdown_complete', { reason });
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (running) return running;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log('warn', 'shutdown_grace_expired', { reason, graceMs });
        resolve();
      }, graceMs);
      timer.unref();
    });
    running = Promise.race([runTasks(reason), deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return running;
  };

  const register = options.onProcess ?? ((signal, handler) => void process.once(signal, handler));
  for (const signal of options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])) {
    register(signal, () => {
      void shutdown(signal).then(() => exit(0));
    });
  }

  return {
    signal: controller.signal,
    isShuttingDown: (): boolean => controller.signal.aborted,
    onShutdown: (name: string, task: ShutdownTask): void => {
      tasks.push({ name, task });
    },
    shutdown,
  };
};
