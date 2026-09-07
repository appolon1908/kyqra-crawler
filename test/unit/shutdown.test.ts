import { describe, expect, it } from 'vitest';

import { createShutdownCoordinator } from '../../src/workers/shutdown.js';

describe('graceful shutdown coordination', () => {
  it('aborts the signal and runs every task in registration order', async () => {
    const order: string[] = [];
    const coordinator = createShutdownCoordinator({ signals: [] });
    expect(coordinator.isShuttingDown()).toBe(false);

    coordinator.onShutdown('stop-claiming', async () => {
      order.push(`stop-claiming:${String(coordinator.signal.aborted)}`);
    });
    coordinator.onShutdown('release-claims', async () => {
      order.push('release-claims');
    });
    coordinator.onShutdown('close-runtime', async () => {
      order.push('close-runtime');
    });

    await coordinator.shutdown('SIGTERM');
    expect(order).toEqual(['stop-claiming:true', 'release-claims', 'close-runtime']);
    expect(coordinator.isShuttingDown()).toBe(true);
  });

  it('runs the sequence once no matter how many signals arrive', async () => {
    let runs = 0;
    const coordinator = createShutdownCoordinator({ signals: [] });
    coordinator.onShutdown('count', async () => {
      runs += 1;
    });
    await Promise.all([
      coordinator.shutdown('SIGTERM'),
      coordinator.shutdown('SIGINT'),
      coordinator.shutdown('SIGTERM'),
    ]);
    await coordinator.shutdown('SIGTERM');
    expect(runs).toBe(1);
  });

  it('continues past a failing task so later cleanup still happens', async () => {
    const completed: string[] = [];
    const coordinator = createShutdownCoordinator({ signals: [] });
    coordinator.onShutdown('broken', async () => {
      throw new Error('worker_close_failed');
    });
    coordinator.onShutdown('release-claims', async () => {
      completed.push('release-claims');
    });
    await coordinator.shutdown('SIGTERM');
    expect(completed).toEqual(['release-claims']);
  });

  it('returns once the grace period expires even if a task never settles', async () => {
    const coordinator = createShutdownCoordinator({ signals: [], graceMs: 30 });
    coordinator.onShutdown('hangs', () => new Promise<void>(() => undefined));
    const started = Date.now();
    await coordinator.shutdown('SIGTERM');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('installs the process signals it is given and exits after the sequence', async () => {
    const installed: string[] = [];
    const exits: number[] = [];
    let handler: (() => void) | undefined;
    const coordinator = createShutdownCoordinator({
      signals: ['SIGTERM'],
      exit: (code) => exits.push(code),
      onProcess: (signal, register) => {
        installed.push(signal);
        handler = register;
      },
    });
    let ran = false;
    coordinator.onShutdown('task', async () => {
      ran = true;
    });

    expect(installed).toEqual(['SIGTERM']);
    handler?.();
    await coordinator.shutdown('SIGTERM');
    // The handler's own exit callback resolves on the same shared promise.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran).toBe(true);
    expect(exits).toEqual([0]);
  });
});
