import crypto from 'node:crypto';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { kyqraOpenApi } from '../../src/api/openapi.js';
import { validateCrawlRedirectTarget, validateCrawlTarget } from '../../src/delivery/security.js';

describe('canonical production API contract', () => {
  it('validates against the pinned official OpenAPI 3.1 schema', () => {
    const schemaSource = fs.readFileSync(
      'test/contracts/openapi-3.1-schema-2025-09-15.json',
      'utf8',
    );
    expect(crypto.createHash('sha256').update(schemaSource).digest('hex')).toBe(
      'd0a3955182364c7b5fdebfd0583ecad259a870b4a2fe86a1b0fe8785f8224fed',
    );
    const schemaDocument: unknown = JSON.parse(schemaSource);
    // The official validation schema deliberately does not validate embedded JSON Schema
    // Objects. Materialize its dynamic Schema Object placeholder as `true` so Ajv validates
    // the complete OpenAPI document structure without mis-scoping the dynamic anchor.
    const materializeSchemaObjects = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(materializeSchemaObjects);
      if (typeof value !== 'object' || value === null) return value;
      const record = value as Record<string, unknown>;
      if (record.$dynamicRef === '#meta') return true;
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, materializeSchemaObjects(item)]),
      );
    };
    const schema = materializeSchemaObjects(schemaDocument) as object;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addFormat('media-range', true);
    const validate = ajv.compile(schema);
    expect(validate(kyqraOpenApi), JSON.stringify(validate.errors)).toBe(true);
  });

  it('documents the complete established Kyqra API without duplicate prefixes', () => {
    const required: Array<[string, keyof typeof kyqraOpenApi.paths]> = [
      ['get', '/api/v1/me'],
      ['get', '/api/v1/capabilities'],
      ['post', '/api/v1/jobs'],
      ['get', '/api/v1/jobs'],
      ['get', '/api/v1/jobs/{id}'],
      ['post', '/api/v1/jobs/{id}/cancel'],
      ['post', '/api/v1/jobs/{id}/retry'],
      ['get', '/api/v1/jobs/{id}/results'],
      ['get', '/api/v1/jobs/{id}/events'],
      ['get', '/api/v1/operations'],
      ['get', '/api/v1/operations/{id}'],
      ['get', '/api/v1/operations/{id}/events'],
      ['get', '/api/v1/operations/{id}/attempts'],
      ['post', '/api/v1/operations/{id}/cancel'],
      ['post', '/api/v1/operations/{id}/reconcile'],
      ['get', '/health/live'],
      ['get', '/health/ready'],
      ['get', '/metrics'],
      ['get', '/readyz'],
    ];
    for (const [method, path] of required) expect(method in kyqraOpenApi.paths[path]).toBe(true);
    expect(Object.keys(kyqraOpenApi.paths).some((path) => path.startsWith('/v1/'))).toBe(false);
    expect(
      kyqraOpenApi.paths['/api/v1/jobs/{id}/cancel'].post.parameters.map(({ name }) => name),
    ).toEqual(['id', 'Idempotency-Key', 'X-Correlation-Id']);
  });

  it('denies loopback, private gateway, and cloud metadata crawl targets', async () => {
    delete process.env.KYQRA_ALLOW_TEST_TARGETS;
    await expect(validateCrawlTarget('http://127.0.0.1/')).rejects.toThrow('private_address');
    await expect(validateCrawlTarget('http://10.40.0.1/')).rejects.toThrow('private_address');
    await expect(validateCrawlTarget('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'private_address',
    );
    await expect(validateCrawlTarget('http://metadata.google.internal/')).rejects.toThrow('denied');
    await expect(validateCrawlTarget('http://192.0.2.10/')).rejects.toThrow('private_address');
    expect(() =>
      validateCrawlRedirectTarget('http://user@example.com/private', 'https://example.com/'),
    ).toThrow('redirect_denied');
    expect(() =>
      validateCrawlRedirectTarget('http://localhost/private', 'https://example.com/'),
    ).toThrow('target_denied');
    expect(validateCrawlRedirectTarget('/next', 'https://example.com/start')).toBe(
      'https://example.com/next',
    );
  });

  it('ships explicit reversible operation and idempotency migrations', () => {
    const migration = fs.readFileSync('migrations/0003_production_operations.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE job_events');
    expect(migration).toContain('CREATE TABLE command_requests');
    expect(migration).toContain('job_requests_semantic_idempotency');
    expect(migration).toContain('enqueue_outcome');
    expect(migration).toContain("caller_id='legacy'");
    expect(migration).toContain('max(char_length(idempotency_key))');
    expect(migration).not.toContain('LOOP');
    expect(migration).toContain('-- Down Migration');
  });

  it('uses schema-aware canonical readiness and a callback-only recovery path', () => {
    const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
    const canonical = fs.readFileSync('src/api/canonical.ts', 'utf8');
    const worker = fs.readFileSync('src/workers/crawl.ts', 'utf8');
    expect(canonical).toContain('await checkPostgresReady(runtime.db)');
    expect(canonical).toContain('callbacks_reconciled: true');
    expect(worker).toContain("existing?.status === 'completed'");
    expect(worker).toContain('job.attemptsMade + 1 >= configuredAttempts');
    expect(worker).toContain("serviceWorkers = 'block'");
    expect(worker).not.toContain("page.routeWebSocket('**/*'");
    expect(worker).toContain('browser-wide pinned proxy');
    expect(worker).toContain('createPinnedCrawlProxy(resolveTarget)');
    expect(worker).toContain('proxyUrl: pinnedProxy.url');
    expect(worker).toContain('useIncognitoPages: true');
    expect(dockerfile).toContain('/root/.npm');
    expect(dockerfile).toContain('FROM scratch');
    const repository = fs.readFileSync('src/storage/postgres/repository.ts', 'utf8');
    expect(repository).toContain("status='running' for update");
  });
});
