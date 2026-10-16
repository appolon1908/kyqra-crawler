import { describe, expect, it } from 'vitest';

import { kyqraOpenApi } from '../../src/api/openapi.js';

const expectedRoutes = [
  ['get', '/'], ['get', '/health'], ['get', '/healthz'], ['get', '/readyz'],
  ['get', '/health/live'], ['get', '/health/ready'], ['get', '/api/v1/health'],
  ['get', '/openapi.json'], ['get', '/api/v1/me'], ['get', '/api/v1/capabilities'],
  ['get', '/api/v1/jobs'], ['post', '/api/v1/jobs'], ['get', '/api/v1/jobs/{id}'],
  ['get', '/api/v1/jobs/{id}/results'], ['get', '/api/v1/jobs/{id}/events'],
  ['post', '/api/v1/jobs/{id}/cancel'], ['post', '/api/v1/jobs/{id}/retry'],
  ['get', '/api/v1/stats'], ['post', '/api/v1/webhooks/test'],
  ['get', '/api/v1/operations'], ['get', '/api/v1/operations/{id}'],
  ['get', '/api/v1/operations/{id}/events'], ['get', '/api/v1/operations/{id}/attempts'],
  ['post', '/api/v1/operations/{id}/cancel'], ['post', '/api/v1/operations/{id}/reconcile'],
  ['get', '/metrics'],
] as const;

describe('OpenAPI route parity', () => {
  it('documents every registered API route and method', () => {
    for (const [method, path] of expectedRoutes) {
      expect(kyqraOpenApi.paths).toHaveProperty([path, method]);
    }
  });

  it('requires durable command headers on every mutating command', () => {
    const commandRoutes = [
      '/api/v1/jobs', '/api/v1/jobs/{id}/cancel', '/api/v1/jobs/{id}/retry',
      '/api/v1/webhooks/test', '/api/v1/operations/{id}/cancel',
      '/api/v1/operations/{id}/reconcile',
    ] as const;
    for (const path of commandRoutes) {
      const operation = kyqraOpenApi.paths[path].post;
      const names = operation.parameters?.map((parameter) => parameter.name) ?? [];
      expect(names).toContain('Idempotency-Key');
      expect(names).toContain('X-Correlation-Id');
    }
  });

  it('documents the common authentication and tenant-safe error surface', () => {
    const operation = kyqraOpenApi.paths['/api/v1/jobs/{id}'].get;
    expect(operation.responses).toHaveProperty('401');
    expect(operation.responses).toHaveProperty('403');
    expect(operation.responses).toHaveProperty('404');
  });
});
