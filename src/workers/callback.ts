import crypto from 'node:crypto';

import { Worker } from 'bullmq';
import { request, type Dispatcher } from 'undici';

import { integrationCredentials } from '../config/env.js';
import { callbackSignatureInput, createPinnedCallbackAgent } from '../delivery/security.js';
import type { CallbackJobData, Runtime } from '../types.js';

interface CallbackCredentials {
  middlewareApiKey: string;
  webhookSecret: string;
}

export const deliverCallback = async (
  data: CallbackJobData,
  eventId: string,
  credentials: CallbackCredentials,
  dispatcherFactory: (url: string) => Promise<Dispatcher> = createPinnedCallbackAgent,
): Promise<void> => {
  const body = JSON.stringify(data.payload || {});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const target = new URL(data.url);
  const canonical = callbackSignatureInput(
    'POST',
    target.pathname,
    timestamp,
    eventId,
    'kyqra',
    body,
  );
  const signature = crypto
    .createHmac('sha256', credentials.webhookSecret)
    .update(canonical)
    .digest('hex');
  const dispatcher = await dispatcherFactory(data.url);
  try {
    const response = await request(data.url, {
      dispatcher,
      method: 'POST',
      headersTimeout: 15000,
      bodyTimeout: 15000,
      signal: AbortSignal.timeout(30000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credentials.middlewareApiKey}`,
        'x-source-system': 'kyqra',
        'x-kyqra-signature-version': 'v1',
        'x-kyqra-timestamp': timestamp,
        'x-kyqra-event-id': eventId,
        'x-kyqra-signature': `sha256=${signature}`,
      },
      body,
    });
    await response.body.dump();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`callback ${response.statusCode}`);
    }
  } finally {
    await dispatcher.close();
  }
};

export const createCallbackWorker = (runtime: Runtime): Worker<CallbackJobData> => {
  const credentials = integrationCredentials();
  return new Worker<CallbackJobData>(
    'callbacks',
    async (job) => {
      const eventId = String(job.id || crypto.randomUUID());
      await deliverCallback(job.data, eventId, credentials);
    },
    { connection: runtime.redisConnection, concurrency: 3 },
  );
};
