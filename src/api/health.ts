import Fastify, { type FastifyInstance } from 'fastify';

import { internalListenerOptions } from '../config/env.js';
import { checkPostgresReady } from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';

export interface LivenessResult {
  status: string;
}

export interface ReadinessResult {
  status: string;
  redis: string;
  postgres: string;
}

/**
 * Public liveness. Answers from process state alone and never touches Redis or
 * PostgreSQL, so an unauthenticated caller cannot drive backing-store probes.
 */
export const shallowLiveness = async (): Promise<LivenessResult> => ({ status: 'ok' });

/**
 * Deep readiness. Executes a Redis PING and a schema-aware PostgreSQL check, and is
 * therefore only served to authenticated callers or on the internal listener.
 */
export const deepReadiness = async (runtime: Runtime, status = 'ok'): Promise<ReadinessResult> => {
  await runtime.redis.ping();
  await checkPostgresReady(runtime.db);
  return { status, redis: 'ok', postgres: 'ok' };
};

/** Paths whose handlers execute dependency probes. */
export const deepProbePaths = ['/health', '/readyz', '/health/ready'];

/**
 * The internal listener carries the deep probes for orchestration. It binds to the
 * loopback interface by default, is never published by compose, and is never proxied
 * by the public Nginx policy.
 */
export const buildInternalApi = (runtime: Runtime): FastifyInstance => {
  const app = Fastify({ bodyLimit: 4_096 });
  app.get('/healthz', shallowLiveness);
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health', async () => deepReadiness(runtime));
  app.get('/readyz', async () => deepReadiness(runtime));
  app.get('/health/ready', async () => deepReadiness(runtime, 'ready'));
  return app;
};

export const startInternalApi = async (runtime: Runtime): Promise<FastifyInstance> => {
  const app = buildInternalApi(runtime);
  const { host, port } = internalListenerOptions();
  await app.listen({ host, port });
  return app;
};
