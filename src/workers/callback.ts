import crypto from 'node:crypto';

import { Worker } from 'bullmq';
import { request, type Dispatcher } from 'undici';

import { integrationCredentials } from '../config/env.js';
import { callbackSignatureInput, createPinnedCallbackAgent } from '../delivery/security.js';
import type { CallbackJobData, Runtime } from '../types.js';
import { createShutdownCoordinator, type ShutdownCoordinator } from './shutdown.js';

interface CallbackCredentials {
  middlewareApiKey: string;
  webhookSecret: string;
}

const canonicalPayloadValue = (
  payload: Record<string, unknown>,
  key: string,
  fallback: string,
): string => {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
};

export const deliverCallback = async (
  data: CallbackJobData,
  eventId: string,
  credentials: CallbackCredentials,
  dispatcherFactory: (url: string) => Promise<Dispatcher> = createPinnedCallbackAgent,
): Promise<void> => {
  const body = JSON.stringify(data.payload || {});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const target = new URL(data.url);
  const canonicalMode = data.signatureMode === 'codestra-v1';
  const sourceClientId = data.sourceClientId || 'kyqra-gateway';
  const source = canonicalMode ? sourceClientId : 'kyqra';
  const canonical = callbackSignatureInput(
    'POST',
    target.pathname,
    timestamp,
    eventId,
    source,
    body,
  );
  const signature = crypto
    .createHmac('sha256', credentials.webhookSecret)
    .update(canonical)
    .digest('hex');
  const payload = data.payload || {};
  const headers: Record<string, string> = canonicalMode
    ? {
        'content-type': 'application/json',
        authorization: `Bearer ${credentials.middlewareApiKey}`,
        'idempotency-key': canonicalPayloadValue(payload, 'idempotency_key', eventId),
        'x-codestra-event-id': eventId,
        'x-codestra-event-type': canonicalPayloadValue(payload, 'event_type', data.event || 'codestra.crawler.job.completed'),
        'x-codestra-source': sourceClientId,
        'x-codestra-tenant-id': canonicalPayloadValue(payload, 'tenant_id', 'unknown'),
        'x-codestra-timestamp': timestamp,
        'x-codestra-signature': `sha256=${signature}`,
        'x-correlation-id': canonicalPayloadValue(payload, 'correlation_id', eventId),
      }
    : {
        'content-type': 'application/json',
        authorization: `Bearer ${credentials.middlewareApiKey}`,
        'x-source-system': 'kyqra',
        'x-kyqra-signature-version': 'v1',
        'x-kyqra-timestamp': timestamp,
        'x-kyqra-event-id': eventId,
        'x-kyqra-signature': `sha256=${signature}`,
      };
  const dispatcher = await dispatcherFactory(data.url);
  try {
    const response = await request(data.url, {
      dispatcher,
      method: 'POST',
      headersTimeout: 15000,
      bodyTimeout: 15000,
      signal: AbortSignal.timeout(30000),
      headers,
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

export const createCallbackWorker = (
  runtime: Runtime,
  shutdown?: ShutdownCoordinator,
): Worker<CallbackJobData> => {
  const credentials = integrationCredentials();
  const worker = new Worker<CallbackJobData>(
    'callbacks',
    async (job) => {
      const eventId = job.data.eventId || String(job.id || crypto.randomUUID());
      await deliverCallback(job.data, eventId, credentials);
    },
    { connection: runtime.redisConnection, concurrency: 3 },
  );
  // `close()` stops new claims and waits for in-flight deliveries, so a redeploy neither
  // drops a callback nor delivers one twice.
  (shutdown ?? createShutdownCoordinator({ signals: [] })).onShutdown(
    'stop-callback-worker',
    async () => {
      await worker.close();
    },
  );
  return worker;
};
