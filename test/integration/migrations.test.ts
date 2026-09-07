import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../../src/api/app.js';
import { migrateDatabase } from '../../src/storage/postgres/migrate.js';
import { markJobRunning } from '../../src/storage/postgres/repository.js';
import type { Runtime } from '../../src/types.js';

const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';

const legacyTables = ['job_requests', 'jobs', 'results'];
const targetV2Tables = [
  'audit_log',
  'credentials',
  'dead_letters',
  'deliveries',
  'domains',
  'extractions',
  'frontier',
  'job_requests',
  'jobs',
  'pages',
  'results',
  'robots_cache',
  'schemas',
  'service_principals',
  'sessions',
  'tenants',
];
const targetTables = [...targetV2Tables, 'command_requests', 'job_events'].sort();

describe('PostgreSQL migrations', () => {
  let postgres: StartedPostgreSqlContainer;
  let db: pg.Pool;

  const applicationTables = async (): Promise<string[]> => {
    const result = await db.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema='public'
          and table_type='BASE TABLE'
          and table_name <> 'kyqra_migrations'
        order by table_name`,
    );
    return result.rows.map(({ table_name }) => table_name);
  };

  const jobColumns = async (): Promise<string[]> => {
    const result = await db.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema='public' and table_name='jobs'
        order by column_name`,
    );
    return result.rows.map(({ column_name }) => column_name);
  };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('crawler')
      .withUsername('crawler')
      .withPassword('fixture-only-not-production')
      .start();
    db = new pg.Pool({ connectionString: postgres.getConnectionUri() });
  });

  afterAll(async () => {
    await db?.end();
    await postgres?.stop();
  });

  it('does not execute DDL while constructing the API', async () => {
    const runtime = { db } as unknown as Runtime;
    const app = await buildApi(runtime);
    await app.close();
    expect(await applicationTables()).toEqual([]);
  });

  it('applies and reverses every migration, then reapplies the full schema', async () => {
    const databaseUrl = postgres.getConnectionUri();

    await migrateDatabase(databaseUrl, 'up', 1);
    expect(await applicationTables()).toEqual(legacyTables);
    expect(await jobColumns()).toContain('payload');

    await migrateDatabase(databaseUrl, 'down', 1);
    expect(await applicationTables()).toEqual([]);

    await migrateDatabase(databaseUrl, 'up', 1);
    await migrateDatabase(databaseUrl, 'up', 1);
    expect(await applicationTables()).toEqual(targetV2Tables);
    expect(await jobColumns()).toEqual(
      expect.arrayContaining(['budget', 'finished_at', 'spec', 'started_at', 'tenant_id']),
    );

    await migrateDatabase(databaseUrl, 'up', 1);
    expect(await applicationTables()).toEqual(targetTables);

    const rollbackDuplicateJobs = [
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000011',
    ];
    const rollbackUnaffectedJob = '00000000-0000-4000-8000-000000000012';
    const rollbackCollisionJob = '00000000-0000-4000-8000-000000000013';
    for (const [index, jobId] of rollbackDuplicateJobs.entries()) {
      await db.query(
        "insert into jobs(id,tenant_id,status,spec,budget) values($1,'rollback-tenant','queued',$2,$3)",
        [jobId, { startUrls: ['https://fixture.test'] }, {}],
      );
      await db.query(
        `insert into job_requests(
           job_id,idempotency_key,request_hash,correlation_id,tenant_id,caller_id
         ) values($1,'shared-key','rollback-hash',$2,'rollback-tenant',$3)`,
        [
          jobId,
          `rollback-correlation-${index}`,
          index === 1 ? 'legacy' : `rollback-caller-${index}`,
        ],
      );
    }
    await db.query(
      "insert into jobs(id,tenant_id,status,spec,budget) values($1,'rollback-tenant','queued',$2,$3)",
      [rollbackUnaffectedJob, { startUrls: ['https://fixture.test'] }, {}],
    );
    await db.query(
      `insert into job_requests(
         job_id,idempotency_key,request_hash,correlation_id,tenant_id,caller_id
       ) values($1,'unaffected-key','rollback-hash','unaffected-correlation','rollback-tenant','unaffected-caller')`,
      [rollbackUnaffectedJob],
    );
    await db.query(
      "insert into jobs(id,tenant_id,status,spec,budget) values($1,'rollback-tenant','queued',$2,$3)",
      [rollbackCollisionJob, { startUrls: ['https://fixture.test'] }, {}],
    );
    await db.query(
      `insert into job_requests(
         job_id,idempotency_key,request_hash,correlation_id,tenant_id,caller_id
       ) values($1,$2,'rollback-hash','collision-correlation','rollback-tenant','collision-caller')`,
      [rollbackCollisionJob, `v3-rollback-duplicate:${rollbackDuplicateJobs[1]}:0`],
    );

    await migrateDatabase(databaseUrl, 'down', 1);
    expect(await applicationTables()).toEqual(targetV2Tables);
    const rollbackKeys = await db.query<{ idempotency_key: string }>(
      `select idempotency_key from job_requests
       where job_id=any($1::uuid[]) order by job_id`,
      [rollbackDuplicateJobs],
    );
    expect(rollbackKeys.rows[0]?.idempotency_key).not.toBe('shared-key');
    expect(rollbackKeys.rows[0]?.idempotency_key.length).toBeGreaterThan(
      `v3-rollback-duplicate:${rollbackDuplicateJobs[1]}:0`.length,
    );
    expect(rollbackKeys.rows[1]?.idempotency_key).toBe('shared-key');
    const unaffectedKey = await db.query<{ idempotency_key: string }>(
      'select idempotency_key from job_requests where job_id=$1',
      [rollbackUnaffectedJob],
    );
    expect(unaffectedKey.rows[0]?.idempotency_key).toBe('unaffected-key');
    const collisionKey = await db.query<{ idempotency_key: string }>(
      'select idempotency_key from job_requests where job_id=$1',
      [rollbackCollisionJob],
    );
    expect(collisionKey.rows[0]?.idempotency_key).toBe(
      `v3-rollback-duplicate:${rollbackDuplicateJobs[1]}:0`,
    );
    await db.query('delete from job_requests where job_id=any($1::uuid[])', [
      [...rollbackDuplicateJobs, rollbackUnaffectedJob, rollbackCollisionJob],
    ]);
    await db.query('delete from jobs where id=any($1::uuid[])', [
      [...rollbackDuplicateJobs, rollbackUnaffectedJob, rollbackCollisionJob],
    ]);

    await migrateDatabase(databaseUrl, 'down', 1);
    expect(await applicationTables()).toEqual(legacyTables);
    expect(await jobColumns()).toContain('payload');
    expect(await jobColumns()).not.toContain('spec');

    await migrateDatabase(databaseUrl, 'down', 2);
    expect(await applicationTables()).toEqual([]);

    await migrateDatabase(databaseUrl, 'up');
    expect(await applicationTables()).toEqual(targetTables);

    const automaticRetryJobId = '00000000-0000-4000-8000-000000000003';
    await db.query(
      "insert into jobs(id,tenant_id,status,spec,budget) values($1,'retry-tenant','queued',$2,$3)",
      [automaticRetryJobId, { startUrls: ['https://fixture.test'] }, {}],
    );
    await db.query(
      `insert into job_requests(
         job_id,idempotency_key,request_hash,correlation_id,tenant_id,caller_id
       ) values($1,'automatic-retry','retry-hash','retry-correlation','retry-tenant','retry-caller')`,
      [automaticRetryJobId],
    );
    expect(await markJobRunning(db, automaticRetryJobId)).toBe(true);
    expect(await markJobRunning(db, automaticRetryJobId)).toBe(true);
    const attempts = await db.query<{ count: string }>(
      "select count(*)::text as count from job_events where job_id=$1 and status='running'",
      [automaticRetryJobId],
    );
    expect(attempts.rows[0]?.count).toBe('2');
    await db.query('delete from job_requests where job_id=$1', [automaticRetryJobId]);
    await db.query('delete from jobs where id=$1', [automaticRetryJobId]);

    await migrateDatabase(databaseUrl, 'down', 2);
    const legacyJobId = '00000000-0000-4000-8000-000000000002';
    await db.query("insert into jobs(id,status,payload) values($1,'queued',$2)", [
      legacyJobId,
      { startUrls: ['https://fixture.test'] },
    ]);
    await db.query(
      'insert into job_requests(job_id,idempotency_key,request_hash,correlation_id,tenant_id) values($1,$2,$3,$4,$5)',
      [legacyJobId, 'legacy-request', 'legacy-hash', 'legacy-correlation', 'legacy-tenant'],
    );
    await db.query('truncate table kyqra_migrations');

    await migrateDatabase(databaseUrl, 'up');
    const adopted = await db.query<{ spec: { startUrls: string[] }; tenant_id: string }>(
      'select spec,tenant_id from jobs where id=$1',
      [legacyJobId],
    );
    expect(adopted.rows[0]).toEqual({
      spec: { startUrls: ['https://fixture.test'] },
      tenant_id: 'legacy-tenant',
    });
    expect(await applicationTables()).toEqual(targetTables);
  });
});
