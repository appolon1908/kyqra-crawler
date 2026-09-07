import { startApi } from './api/app.js';
import { crawlWorkerKind } from './config/env.js';
import { createRuntime } from './runtime.js';
import { createCallbackWorker } from './workers/callback.js';
import { createCrawlWorker } from './workers/crawl.js';

const runtime = createRuntime();
const role = process.env.ROLE || 'api';

if (role === 'api') await startApi(runtime);
else if (role === 'worker') createCrawlWorker(runtime, crawlWorkerKind());
else if (role === 'callback') createCallbackWorker(runtime);
else throw new Error('ROLE must be api, worker, or callback');
