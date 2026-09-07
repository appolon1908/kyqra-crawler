import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const installer = readFileSync(
  new URL('../../scripts/codestra-kyqra-remediation-admin.in', import.meta.url),
  'utf8',
);

const section = (start: string, end: string): string => {
  const startIndex = installer.indexOf(start);
  const endIndex = installer.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return installer.slice(startIndex, endIndex);
};

const ordered = (source: string, needles: string[]): void => {
  let previous = -1;
  for (const needle of needles) {
    const current = source.indexOf(needle);
    expect(current, `missing ${needle}`).toBeGreaterThan(previous);
    previous = current;
  }
};

describe('privileged installer storage cutover', () => {
  it('quiesces every application writer before PostgreSQL and Redis snapshots', () => {
    expect(installer).toContain(
      'declare -ar APP_SERVICES=(api http-worker browser-worker callback-worker)',
    );

    const backup = section('create_backup() {', '\nruntime_verify() {');
    ordered(backup, [
      'capture_running_services',
      'previous_image',
      'redis_volume_name',
      'stop "${APP_SERVICES[@]}"',
      'REDIS_QUIESCED=1',
      'stop redis',
      'backup_redis_volume',
      'pg_dump',
      'sha256sum * >SHA256SUMS',
      'mv -T "$pointer_tmp" "$CURRENT_BACKUP"',
      'BACKUP_IN_PROGRESS=0',
    ]);
  });

  it('restores both stores before recreating only the recorded prior service set', () => {
    const rollback = section('do_rollback() {', '\ncase "$op" in');
    ordered(rollback, [
      'stop "${APP_SERVICES[@]}"',
      'stop redis',
      'pg_restore',
      'restore_redis_volume',
      'wait_for_redis',
      'start_recorded_services',
    ]);
    expect(rollback).not.toContain(
      'up -d --no-deps --force-recreate api http-worker browser-worker callback-worker',
    );
  });

  it('restores the pre-backup runtime when a partial snapshot fails', () => {
    const install = section('  install)\n', '\n  verify)');
    ordered(install, ["trap 'on_install_exit $?' EXIT", 'create_backup']);

    const exitHandler = section('on_install_exit() {', '\ncreate_backup() {');
    expect(exitHandler).toContain('if (( BACKUP_IN_PROGRESS )); then');
    expect(exitHandler).toContain('restore_prebackup_runtime');
    expect(exitHandler).toContain('do_rollback');
  });
});
