import { startApi } from './api/app.js';
import { crawlWorkerKind, shutdownGraceSeconds } from './config/env.js';
import { closeRuntime, createRuntime } from './runtime.js';
import { createCallbackWorker } from './workers/callback.js';
import { createCrawlWorker } from './workers/crawl.js';
import { createShutdownCoordinator } from './workers/shutdown.js';

const runtime = createRuntime();
const role = process.env.ROLE || 'api';

// SIGTERM is how the container runtime asks for a replacement. Every role registers its
// own wind-down tasks; the runtime is closed last so in-flight work can still use it.
const shutdown = createShutdownCoordinator({ graceMs: shutdownGraceSeconds() * 1_000 });

if (role === 'api') {
  const { app, internal } = await startApi(runtime);
  shutdown.onShutdown('stop-http-listeners', async () => {
    await Promise.all([app.close(), internal.close()]);
  });
} else if (role === 'worker') {
  createCrawlWorker(runtime, crawlWorkerKind(), shutdown);
} else if (role === 'callback') {
  createCallbackWorker(runtime, shutdown);
} else {
  throw new Error('ROLE must be api, worker, or callback');
}

shutdown.onShutdown('close-runtime', async () => {
  await closeRuntime(runtime);
});
