import crypto from 'node:crypto';

import type { CallbackResultRow, JobMetadata } from '../storage/postgres/repository.js';

export interface CrawlerEventProgress {
  processed: number;
  records: number;
  failed: number;
}

export interface CrawlerEventEnvelope {
  event_id: string;
  event_type:
    | 'codestra.crawler.job.completed'
    | 'codestra.crawler.job.failed'
    | 'codestra.crawler.result.review_required'
    | 'codestra.crawler.job.progress';
  event_version: '1.0';
  occurred_at: string;
  received_at: string;
  source: 'kyqra-gateway';
  tenant_id: string;
  customer_id: string | null;
  correlation_id: string;
  causation_id: string;
  idempotency_key: string;
  payload: {
    job_id: string;
    status: 'completed';
    error: null;
    progress: CrawlerEventProgress;
    results: Array<{
      record_id: string;
      source_url: string;
      data: Record<string, unknown>;
      provenance: Record<string, string>;
      review_required: true;
      confidence: number | null;
      capture_method: 'http' | 'browser';
    }>;
  };
  metadata: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asConfidence = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

export const buildCrawlerCompletionEvent = (values: {
  eventId?: string;
  jobId: string;
  metadata: JobMetadata | null;
  progress: CrawlerEventProgress;
  rows: CallbackResultRow[];
}): CrawlerEventEnvelope => {
  const tenantId = values.metadata?.tenant_id;
  const correlationId = values.metadata?.correlation_id;
  if (!tenantId || !correlationId) throw new Error('job_metadata_required_for_delivery');
  const eventId = values.eventId ?? crypto.randomUUID();
  const timestamp = new Date().toISOString();
  return {
    event_id: eventId,
    event_type: 'codestra.crawler.job.completed',
    event_version: '1.0',
    occurred_at: timestamp,
    received_at: timestamp,
    source: 'kyqra-gateway',
    tenant_id: tenantId,
    customer_id: null,
    correlation_id: correlationId,
    causation_id: values.jobId,
    idempotency_key: eventId,
    payload: {
      job_id: values.jobId,
      status: 'completed',
      error: null,
      progress: values.progress,
      results: values.rows.map((row) => {
        const data = asRecord(row.data);
        const sourceUrl =
          typeof data.source_url === 'string' ? data.source_url : row.provenance.source_url ?? '';
        return {
          record_id: row.id,
          source_url: sourceUrl,
          data,
          provenance: row.provenance,
          review_required: true,
          confidence: asConfidence(data.confidence),
          capture_method: row.fetcher === 'browser' ? 'browser' : 'http',
        };
      }),
    },
    metadata: {
      origin_service: 'kyqra-crawler',
      contract: 'kyqra-crawler-v1',
      review_policy: 'review_pending',
    },
  };
};
