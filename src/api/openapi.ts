const successResponses = {
  '200': { description: 'Success' },
  '202': { description: 'Durable command accepted' },
};

const operation = (summary: string, secured = true) => ({
  summary,
  ...(secured ? { security: [{ bearerAuth: [] }] } : { security: [] }),
  responses: successResponses,
});

const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const commandHeaders = [
  {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 128 },
  },
  {
    name: 'X-Correlation-Id',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 128 },
  },
];

const identifiedOperation = (summary: string) => ({
  ...operation(summary),
  parameters: [idParameter],
});

const identifiedCommand = (summary: string) => ({
  ...operation(summary),
  parameters: [idParameter, ...commandHeaders],
  responses: {
    ...successResponses,
    '409': { description: 'State or idempotency conflict' },
  },
});

export const kyqraOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Kyqra Crawler API', version: '2.0.0' },
  servers: [{ url: 'https://crawler.kyqra.com' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      JobSpec: {
        type: 'object',
        additionalProperties: false,
        required: ['startUrls'],
        properties: {
          startUrls: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: { type: 'string', format: 'uri' },
          },
          mode: { type: 'string', enum: ['single', 'domain', 'list', 'discovery'] },
          maxPages: { type: 'integer', minimum: 1, maximum: 10000 },
          maxDepth: { type: 'integer', minimum: 0, maximum: 10 },
          browser: { type: 'string', enum: ['auto', 'http', 'playwright'] },
          extract: { type: 'array', items: { type: 'string' } },
          includePatterns: { type: 'array', items: { type: 'string' } },
          excludePatterns: { type: 'array', items: { type: 'string' } },
          callbackUrl: { type: 'string', format: 'uri' },
          requestsPerSecond: { type: 'number', minimum: 0.1, maximum: 20 },
        },
      },
      WebhookTest: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: { url: { type: 'string', format: 'uri' } },
      },
    },
  },
  paths: {
    '/': { get: operation('Crawler dashboard', false) },
    '/health': { get: operation('Legacy readiness', false) },
    '/healthz': { get: operation('Liveness', false) },
    '/readyz': { get: operation('Readiness', false) },
    '/health/live': { get: operation('Canonical liveness', false) },
    '/health/ready': { get: operation('Canonical readiness', false) },
    '/api/v1/health': { get: operation('API liveness', false) },
    '/openapi.json': { get: operation('Canonical OpenAPI document', false) },
    '/api/v1/me': { get: operation('Current service identity') },
    '/api/v1/capabilities': { get: operation('Caller capabilities') },
    '/api/v1/jobs': {
      get: operation('List tenant jobs'),
      post: {
        ...operation('Create crawl job'),
        parameters: commandHeaders,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/JobSpec' } },
          },
        },
        responses: {
          ...successResponses,
          '409': { description: 'Idempotency conflict or in-progress reservation' },
          '429': { description: 'Tenant rate limit exceeded' },
          '503': { description: 'Durable job exists but queue submission failed' },
        },
      },
    },
    '/api/v1/jobs/{id}': { get: identifiedOperation('Job detail') },
    '/api/v1/jobs/{id}/results': {
      get: {
        ...identifiedOperation('Job results'),
        parameters: [
          idParameter,
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } },
        ],
      },
    },
    '/api/v1/jobs/{id}/events': { get: identifiedOperation('Durable job events') },
    '/api/v1/jobs/{id}/cancel': { post: identifiedCommand('Cancel job') },
    '/api/v1/jobs/{id}/retry': { post: identifiedCommand('Retry failed job') },
    '/api/v1/stats': {
      get: { ...operation('Queue and worker statistics'), 'x-required-roles': ['operations'] },
    },
    '/api/v1/webhooks/test': {
      post: {
        ...operation('Queue controlled webhook test'),
        parameters: commandHeaders,
        'x-required-roles': ['operations'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WebhookTest' } },
          },
        },
      },
    },
    '/api/v1/operations': { get: operation('List durable operations') },
    '/api/v1/operations/{id}': { get: identifiedOperation('Operation detail') },
    '/api/v1/operations/{id}/events': { get: identifiedOperation('Operation events') },
    '/api/v1/operations/{id}/attempts': {
      get: identifiedOperation('Operation attempts'),
    },
    '/api/v1/operations/{id}/cancel': {
      post: identifiedCommand('Cancel operation'),
    },
    '/api/v1/operations/{id}/reconcile': {
      post: identifiedCommand('Reconcile operation'),
    },
    '/metrics': {
      get: { ...operation('Prometheus metrics'), 'x-required-roles': ['operations'] },
    },
  },
} as const;
