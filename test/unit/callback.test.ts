import crypto from 'node:crypto';

import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';

import { callbackSignatureInput } from '../../src/delivery/security.js';
import { deliverCallback } from '../../src/workers/callback.js';

describe('signed private-gateway callback delivery', () => {
  it('sends bearer and verifiable event-source headers without network access', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get('https://gateway.example.test');
    let receivedHeaders: Record<string, string> = {};
    pool.intercept({ path: '/api/v1/kyqra/results', method: 'POST' }).reply((options) => {
      receivedHeaders = Object.fromEntries(
        Object.entries(options.headers || {}).map(([key, value]) => [key, String(value)]),
      );
      return { statusCode: 204, data: '' };
    });
    const payload = { job_id: 'fixture-job', tenant_id: 'fixture-tenant' };
    const webhookSecret = 'w'.repeat(32);
    await deliverCallback(
      {
        jobId: 'fixture-job',
        url: 'https://gateway.example.test/api/v1/kyqra/results',
        payload,
      },
      'fixture-event-id',
      { middlewareApiKey: 'm'.repeat(32), webhookSecret },
      async () => agent,
    );
    expect(receivedHeaders.authorization).toBe(`Bearer ${'m'.repeat(32)}`);
    expect(receivedHeaders['x-source-system']).toBe('kyqra');
    expect(receivedHeaders['x-kyqra-event-id']).toBe('fixture-event-id');
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(
        callbackSignatureInput(
          'POST',
          '/api/v1/kyqra/results',
          receivedHeaders['x-kyqra-timestamp'] || '',
          'fixture-event-id',
          'kyqra',
          JSON.stringify(payload),
        ),
      )
      .digest('hex');
    expect(receivedHeaders['x-kyqra-signature']).toBe(`sha256=${expected}`);
  });

  it('fails a non-success response so BullMQ can retry or dead-letter it', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://gateway.example.test')
      .intercept({ path: '/failure', method: 'POST' })
      .reply(503, { error: 'fixture' });
    await expect(
      deliverCallback(
        { jobId: 'fixture-job', url: 'https://gateway.example.test/failure' },
        'fixture-event-id',
        { middlewareApiKey: 'm'.repeat(32), webhookSecret: 'w'.repeat(32) },
        async () => agent,
      ),
    ).rejects.toThrow('callback 503');
  });
  
  it('uses the canonical Codestra headers for Middleware events', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get('https://gateway.example.test');
    let receivedHeaders: Record<string, string> = {};
    pool.intercept({ path: '/api/v1/kyqra/results', method: 'POST' }).reply((options) => {
      receivedHeaders = Object.fromEntries(
        Object.entries(options.headers || {}).map(([key, value]) => [key, String(value)]),
      );
      return { statusCode: 204, data: '' };
    });
    const payload = {
      event_id: '11111111-1111-4111-8111-111111111111',
      event_type: 'codestra.crawler.job.completed',
      event_version: '1.0',
      occurred_at: '2026-09-12T11:00:00.000Z',
      received_at: '2026-09-12T11:00:00.000Z',
      source: 'kyqra-gateway',
      tenant_id: 'tenant-1',
      customer_id: null,
      correlation_id: 'corr-1',
      causation_id: 'job-1',
      idempotency_key: '11111111-1111-4111-8111-111111111111',
      payload: {
        job_id: '22222222-2222-4222-8222-222222222222',
        status: 'completed',
        error: null,
        progress: { processed: 1, records: 1, failed: 0 },
        results: [],
      },
      metadata: { origin_service: 'kyqra-crawler' },
    };
    await deliverCallback(
      {
        jobId: 'job-1',
        url: 'https://gateway.example.test/api/v1/kyqra/results',
        payload,
        eventId: payload.event_id,
        event: payload.event_type,
        signatureMode: 'codestra-v1',
        sourceClientId: 'kyqra-gateway',
      },
      payload.event_id,
      { middlewareApiKey: 'm'.repeat(32), webhookSecret: 'w'.repeat(32) },
      async () => agent,
    );
    expect(receivedHeaders['x-codestra-source']).toBe('kyqra-gateway');
    expect(receivedHeaders['x-codestra-event-type']).toBe('codestra.crawler.job.completed');
    expect(receivedHeaders['x-codestra-event-id']).toBe(payload.event_id);
    expect(receivedHeaders['idempotency-key']).toBe(payload.idempotency_key);
  });

});
