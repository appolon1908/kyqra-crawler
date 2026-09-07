import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../../src/api/app.js';
import { buildInternalApi, deepProbePaths } from '../../src/api/health.js';
import { internalListenerOptions } from '../../src/config/env.js';
import type { Runtime } from '../../src/types.js';

const API_TOKEN = 'fixture-health-key-not-production';

interface ProbeCounters {
  redisPings: number;
  postgresQueries: number;
}

const stubRuntime = (counters: ProbeCounters): Runtime =>
  ({
    redis: {
      ping: async (): Promise<string> => {
        counters.redisPings += 1;
        return 'PONG';
      },
    },
    db: {
      query: async (): Promise<{ rows: unknown[] }> => {
        counters.postgresQueries += 1;
        return { rows: [] };
      },
    },
  }) as unknown as Runtime;

describe('public probe surface', () => {
  let counters: ProbeCounters;
  let app: FastifyInstance;
  let internal: FastifyInstance;
  let directory: string;

  beforeAll(async () => {
    counters = { redisPings: 0, postgresQueries: 0 };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kyqra-m3-'));
    const principalPath = path.join(directory, 'principals.json');
    fs.writeFileSync(
      principalPath,
      JSON.stringify({
        principals: [
          {
            key_sha256: crypto.createHash('sha256').update(API_TOKEN).digest('hex'),
            tenant_id: 'fixture-tenant',
            client_id: 'fixture-client',
            roles: ['operations'],
            enabled: true,
          },
        ],
      }),
    );
    process.env.KYQRA_SERVICE_PRINCIPALS_FILE = principalPath;
    const runtime = stubRuntime(counters);
    app = await buildApi(runtime);
    internal = buildInternalApi(runtime);
    await Promise.all([app.ready(), internal.ready()]);
  });

  afterAll(async () => {
    await app?.close();
    await internal?.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('answers shallow liveness publicly without touching Redis or PostgreSQL', async () => {
    for (const url of ['/healthz', '/health/live', '/api/v1/health']) {
      const response = await app.inject({ method: 'GET', url });
      expect([url, response.statusCode]).toEqual([url, 200]);
    }
    expect(counters).toEqual({ redisPings: 0, postgresQueries: 0 });
  });

  it('rejects every deep probe from an unauthenticated public caller', async () => {
    for (const url of deepProbePaths) {
      const response = await app.inject({ method: 'GET', url });
      expect([url, response.statusCode]).toEqual([url, 401]);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    }
    // The rejection happens before any handler runs, so no dependency was probed.
    expect(counters).toEqual({ redisPings: 0, postgresQueries: 0 });
  });

  it('rejects a deep probe presented with an invalid bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { authorization: 'Bearer not-a-registered-key' },
    });
    expect(response.statusCode).toBe(401);
    expect(counters).toEqual({ redisPings: 0, postgresQueries: 0 });
  });

  it('serves deep readiness to an authenticated caller on the public listener', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', redis: 'ok', postgres: 'ok' });
    expect(counters.redisPings).toBe(1);
    expect(counters.postgresQueries).toBeGreaterThan(0);
  });

  it('serves deep readiness unauthenticated on the internal listener only', async () => {
    const before = counters.redisPings;
    const readiness = await internal.inject({ method: 'GET', url: '/readyz' });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toEqual({ status: 'ok', redis: 'ok', postgres: 'ok' });
    expect(counters.redisPings).toBe(before + 1);

    const canonical = await internal.inject({ method: 'GET', url: '/health/ready' });
    expect(canonical.json()).toMatchObject({ status: 'ready', redis: 'ok', postgres: 'ok' });

    // The internal listener carries no job or mutation surface.
    expect((await internal.inject({ method: 'POST', url: '/api/v1/jobs' })).statusCode).toBe(404);
    expect((await internal.inject({ method: 'GET', url: '/api/v1/stats' })).statusCode).toBe(404);
  });

  it('binds the internal listener to loopback on a port compose never publishes', () => {
    expect(internalListenerOptions()).toEqual({ host: '127.0.0.1', port: 3001 });
    const compose = fs.readFileSync('docker-compose.yml', 'utf8');
    expect(compose).toContain('http://127.0.0.1:3001/readyz');
    expect(compose).not.toContain('3001:3001');
    const publicPolicy = fs.readFileSync('config/nginx/kyqra-public.conf', 'utf8');
    for (const probe of deepProbePaths) {
      expect(publicPolicy).toContain(`location = ${probe} { return 404; }`);
    }
    expect(publicPolicy).toContain('location = /healthz {');
  });
});
