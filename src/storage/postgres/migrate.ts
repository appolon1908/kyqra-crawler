import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { databaseUrl } from '../../config/env.js';

export type MigrationDirection = 'up' | 'down';

const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);

const waitForDatabase = async (databaseUrl: string, attempts = 30): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query('select 1');
      return;
    } catch (error: unknown) {
      lastError = error;
    } finally {
      await client.end().catch(() => undefined);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError;
};

export const migrateDatabase = async (
  databaseUrl: string,
  direction: MigrationDirection,
  count = direction === 'up' ? Number.POSITIVE_INFINITY : 1,
): Promise<void> => {
  await waitForDatabase(databaseUrl);
  await runner({
    databaseUrl,
    direction,
    count,
    dir: migrationDirectory,
    migrationsTable: 'kyqra_migrations',
    checkOrder: true,
    singleTransaction: true,
  });
};

const parseCount = (value: string | undefined, direction: MigrationDirection): number => {
  if (!value) return direction === 'up' ? Number.POSITIVE_INFINITY : 1;
  if (value === 'all') return Number.POSITIVE_INFINITY;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('migration_count_must_be_positive');
  return count;
};

const runCommand = async (): Promise<void> => {
  const connectionUrl = databaseUrl();
  const directionArgument = process.argv[2] ?? 'up';
  if (directionArgument !== 'up' && directionArgument !== 'down') {
    throw new Error('migration_direction_must_be_up_or_down');
  }
  await migrateDatabase(
    connectionUrl,
    directionArgument,
    parseCount(process.argv[3], directionArgument),
  );
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCommand().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`migration_failed: ${message}`);
    process.exitCode = 1;
  });
}
