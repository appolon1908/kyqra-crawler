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
});
