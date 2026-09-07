import crypto from 'node:crypto';
import fs from 'node:fs';

import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

import type { ServicePrincipal } from '../types.js';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isServicePrincipal = (value: unknown): value is ServicePrincipal => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.key_sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(item.key_sha256) &&
    typeof item.tenant_id === 'string' &&
    item.tenant_id.length >= 1 &&
    item.tenant_id.length <= 128 &&
    typeof item.client_id === 'string' &&
    item.client_id.length >= 1 &&
    item.client_id.length <= 128 &&
    typeof item.enabled === 'boolean' &&
    (item.roles === undefined || isStringArray(item.roles))
  );
};

export const loadServicePrincipals = (): ServicePrincipal[] => {
  const path = process.env.KYQRA_SERVICE_PRINCIPALS_FILE || '';
  if (!path) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) return [];
  const principals = (parsed as Record<string, unknown>).principals;
  return Array.isArray(principals) ? principals.filter(isServicePrincipal) : [];
};

export const authenticate = (
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void => {
  const authorization = String(request.headers.authorization || '');
  const bearer = /^Bearer ([^\s]{16,512})$/i.exec(authorization);
  const token = bearer?.[1] || '';
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const matches = loadServicePrincipals().filter(
    (principal) =>
      principal.enabled &&
      principal.key_sha256.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(principal.key_sha256), Buffer.from(digest)),
  );
  const principal = matches[0];
  if (!token || matches.length !== 1 || !principal) {
    void reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  const claimedTenant = String(request.headers['x-tenant-id'] || '');
  if (claimedTenant && claimedTenant !== principal.tenant_id) {
    void reply.code(403).send({ error: 'tenant_claim_mismatch' });
    return;
  }
  request.servicePrincipal = principal;
  done();
};
