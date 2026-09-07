import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildFixtureSite } from './fixtures/site/server.js';

describe('local crawler fixture site', () => {
  const site = request(buildFixtureSite());

  it('serves deterministic static, rendered, paginated, error, and slow responses', async () => {
    expect((await site.get('/static')).text).toContain('hello@fixture.test');
    expect((await site.get('/js-rendered')).text).toContain('Rendered Fixture');
    expect((await site.get('/list?page=1')).text).toContain('/list?page=2');
    expect((await site.get('/list?page=2')).text).toContain('/list?page=3');
    expect((await site.get('/list?page=3')).text).not.toContain('>Next<');
    expect((await site.get('/not-found')).status).toBe(404);
    expect((await site.get('/server-error')).status).toBe(500);
    expect((await site.get('/slow')).status).toBe(200);
  });

  it('serves JSON-LD and enforces the login wall', async () => {
    expect((await site.get('/json-ld')).text).toContain('application/ld+json');
    expect((await site.get('/login-walled')).status).toBe(401);
    expect(
      (await site.get('/login-walled').set('Cookie', 'fixture_session=allowed')).text,
    ).toContain('Private Fixture');
  });
});
