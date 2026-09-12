import { describe, expect, it } from 'vitest';

import { buildCrawlerCompletionEvent } from '../../src/integration/crawler-events.js';

describe('Kyqra crawler integration events', () => {
  it('builds a review-pending canonical completion event with provenance', () => {
    const event = buildCrawlerCompletionEvent({
      eventId: '11111111-1111-4111-8111-111111111111',
      jobId: '22222222-2222-4222-8222-222222222222',
      metadata: { tenant_id: 'tenant-1', correlation_id: 'corr-1' },
      progress: { processed: 1, records: 1, failed: 0 },
      rows: [
        {
          id: '7',
          fetcher: 'browser',
          data: {
            source_url: 'https://public.example.test/business',
            business_name: 'Example',
            confidence: 0.8,
          } as never,
          provenance: { business_name: 'https://public.example.test/business' },
        },
      ],
    });
    expect(event.source).toBe('kyqra-gateway');
    expect(event.idempotency_key).toBe(event.event_id);
    expect(event.payload.results[0]).toMatchObject({
      record_id: '7',
      review_required: true,
      capture_method: 'browser',
      confidence: 0.8,
    });
    expect(event.metadata).toMatchObject({
      origin_service: 'kyqra-crawler',
      review_policy: 'review_pending',
    });
  });
});
