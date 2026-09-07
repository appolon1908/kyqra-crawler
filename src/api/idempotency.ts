import crypto from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { beginCommand, completeCommand } from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';

export interface DurableCommandResult {
  code: number;
  body: Record<string, unknown>;
}

export const semanticHash = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const requireCommandHeaders = (
  request: FastifyRequest,
  reply: FastifyReply,
): { idempotencyKey: string; correlationId: string } | null => {
  const idempotencyKey = String(request.headers['idempotency-key'] || '');
  const correlationId = String(request.headers['x-correlation-id'] || '');
  if (
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 128 ||
    correlationId.length < 8 ||
    correlationId.length > 128
  ) {
    void reply.code(400).send({ error: 'idempotency_and_correlation_required' });
    return null;
  }
  return { idempotencyKey, correlationId };
};

export const executeDurableCommand = async (
  runtime: Runtime,
  request: FastifyRequest,
  reply: FastifyReply,
  values: { action: string; resource: string; payload: unknown },
  effect: () => Promise<DurableCommandResult>,
): Promise<FastifyReply> => {
  const headers = requireCommandHeaders(request, reply);
  if (!headers) return reply;
  let reservation;
  try {
    reservation = await beginCommand(runtime.db, {
      id: crypto.randomUUID(),
      tenantId: request.servicePrincipal.tenant_id,
      callerId: request.servicePrincipal.client_id,
      action: values.action,
      resource: values.resource,
      idempotencyKey: headers.idempotencyKey,
      requestHash: semanticHash(values.payload),
      correlationId: headers.correlationId,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'idempotency_conflict') {
      return reply.code(409).send({ error: 'idempotency_conflict' });
    }
    throw error;
  }
  if (reservation.duplicate) {
    if (reservation.row.response && reservation.row.response_code) {
      return reply.code(reservation.row.response_code).send(reservation.row.response);
    }
    return reply.code(409).send({
      error: 'command_outcome_ambiguous',
      operation_id: reservation.row.id,
      correlation_id: reservation.row.correlation_id,
      reconciliation_required: true,
    });
  }
  const result = await effect();
  await completeCommand(runtime.db, reservation.row.id, result.code, result.body);
  return reply.code(result.code).send(result.body);
};
