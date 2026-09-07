import { readFileSync } from 'node:fs';
import os from 'node:os';

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const redisPassword = (): string | undefined => {
  const file = process.env.REDIS_PASSWORD_FILE?.trim();
  const direct = process.env.REDIS_PASSWORD?.trim();
  if (file && direct) throw new Error('configure only REDIS_PASSWORD_FILE or REDIS_PASSWORD');
  const value = file ? readFileSync(file, 'utf8').trim() : direct;
  if (value && !/^[A-Za-z0-9_-]{32,200}$/.test(value)) {
    throw new Error('Redis password must be a 32-200 character URL-safe token');
  }
  return value || undefined;
};

const fileOrEnvironmentSecret = (
  name: string,
  minimumLength: number,
  maximumLength: number,
): string => {
  const file = process.env[`${name}_FILE`]?.trim();
  const direct = process.env[name]?.trim();
  if (file && direct) throw new Error(`configure only ${name}_FILE or ${name}`);
  const value = file ? readFileSync(file, 'utf8').trim() : direct || '';
  if (value.length < minimumLength || value.length > maximumLength || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be ${minimumLength}-${maximumLength} characters`);
  }
  return value;
};

export const integrationCredentials = (): {
  middlewareApiKey: string;
  webhookSecret: string;
} => ({
  middlewareApiKey: fileOrEnvironmentSecret('KYQRA_MIDDLEWARE_API_KEY', 32, 512),
  webhookSecret: fileOrEnvironmentSecret('KYQRA_WEBHOOK_SECRET', 32, 256),
});

export const redisConnectionOptions = (): RedisConnectionOptions => {
  const password = redisPassword();
  return {
    host: process.env.REDIS_HOST || 'redis',
    port: positiveInteger(process.env.REDIS_PORT, 6379),
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
  };
};

export const databaseUrl = (): string => {
  const direct = process.env.DATABASE_URL?.trim();
  const passwordFile = process.env.DATABASE_PASSWORD_FILE?.trim();
  if (direct && passwordFile) {
    throw new Error('configure only DATABASE_URL or DATABASE_PASSWORD_FILE');
  }
  if (direct) return direct;
  if (!passwordFile) throw new Error('DATABASE_PASSWORD_FILE is required');
  const password = readFileSync(passwordFile, 'utf8').trim();
  if (password.length < 32 || password.length > 200 || /[\r\n]/.test(password)) {
    throw new Error('database password must be 32-200 characters');
  }
  const host = process.env.DATABASE_HOST || 'postgres';
  const port = positiveInteger(process.env.DATABASE_PORT, 5432);
  const user = encodeURIComponent(process.env.DATABASE_USER || 'crawler');
  const database = encodeURIComponent(process.env.DATABASE_NAME || 'crawler');
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
};

export interface InternalListenerOptions {
  host: string;
  port: number;
}

/**
 * Listener that carries the deep readiness probes. It defaults to the loopback
 * interface so container health checks and orchestration can reach it while the
 * public listener cannot expose dependency probes to the internet.
 */
export const internalListenerOptions = (): InternalListenerOptions => ({
  host: process.env.INTERNAL_HEALTH_HOST || '127.0.0.1',
  port: positiveInteger(process.env.INTERNAL_HEALTH_PORT, 3001),
});

/**
 * Stable identity for this worker process. Frontier claims are recorded against it so a
 * graceful shutdown can release exactly the claims this process holds, and so an
 * abandoned claim is attributable.
 */
export const workerIdentity = (): string =>
  `${process.env.KYQRA_WORKER_ID || os.hostname()}:${process.pid}`;

/**
 * How long a frontier claim stays valid without progress. A worker killed without running
 * its shutdown path has its claims recovered after this window.
 */
export const frontierVisibilitySeconds = (): number =>
  positiveInteger(process.env.FRONTIER_VISIBILITY_SECONDS, 120);

/** How often a worker returns expired claims to the pending pool. */
export const frontierSweepSeconds = (): number =>
  positiveInteger(process.env.FRONTIER_SWEEP_SECONDS, 30);

/** Seconds a shutdown may take before the process exits regardless. */
export const shutdownGraceSeconds = (): number =>
  positiveInteger(process.env.SHUTDOWN_GRACE_SECONDS, 25);

export const httpConcurrency = (): number => positiveInteger(process.env.HTTP_CONCURRENCY, 15);

export const browserConcurrency = (): number => positiveInteger(process.env.BROWSER_CONCURRENCY, 3);

export const jobConcurrency = (): number => positiveInteger(process.env.JOB_CONCURRENCY, 2);

export const crawlWorkerKind = (): 'http' | 'browser' => {
  const value = process.env.WORKER_KIND;
  if (value === 'http' || value === 'browser') return value;
  throw new Error('WORKER_KIND must be http or browser');
};
