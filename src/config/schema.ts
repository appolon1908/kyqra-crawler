import { z } from 'zod';

export const jobSpecSchema = z.object({
  startUrls: z.array(z.string().url()).min(1).max(1000),
  mode: z.enum(['single', 'domain', 'list', 'discovery']).default('single'),
  maxPages: z.number().int().min(1).max(10000).default(100),
  maxDepth: z.number().int().min(0).max(10).default(3),
  browser: z.enum(['auto', 'http', 'playwright']).default('auto'),
  extract: z.array(z.string()).default([]),
  includePatterns: z.array(z.string()).default([]),
  excludePatterns: z.array(z.string()).default([]),
  callbackUrl: z.string().url().optional(),
  requestsPerSecond: z.number().min(0.1).max(20).default(2),
});

export const sourceProfileSchema = z.object({
  name: z.string().min(1).max(256),
  baseUrl: z.string().url().refine((value) => value.startsWith('https://'), {
    message: 'baseUrl must use HTTPS',
  }),
  enabled: z.boolean().default(true),
  crawl: z
    .object({
      mode: z.enum(['single', 'domain', 'list', 'discovery']).default('domain'),
      schedule: z.string().max(128).nullable().optional(),
      maxPages: z.number().int().min(1).max(100000).default(1000),
      maxDepth: z.number().int().min(0).max(20).default(6),
      requestsPerSecond: z.number().positive().max(100).default(1),
      respectRobotsTxt: z.literal(true).default(true),
      browserMode: z.enum(['auto', 'http', 'playwright']).default('auto'),
    })
    .default({
      mode: 'domain',
      maxPages: 1000,
      maxDepth: 6,
      requestsPerSecond: 1,
      respectRobotsTxt: true,
      browserMode: 'auto',
    }),
  discovery: z
    .object({
      sitemap: z.boolean().default(true),
      rss: z.boolean().default(true),
      pagination: z.boolean().default(true),
    })
    .default({
      sitemap: true,
      rss: true,
      pagination: true,
    }),
  extraction: z
    .object({
      schema: z.string().min(1).max(128).default('business_profile'),
      schemaVersion: z.number().int().min(1).default(1),
    })
    .default({
      schema: 'business_profile',
      schemaVersion: 1,
    }),
  allowedContentTypes: z
    .array(z.string().min(1).max(256))
    .max(64)
    .default(['text/html', 'application/json', 'application/pdf']),
  privacyPolicy: z
    .enum(['public_business_only', 'authorized_private', 'restricted'])
    .default('public_business_only'),
});

export type JobSpec = z.infer<typeof jobSpecSchema>;
export type SourceProfile = z.infer<typeof sourceProfileSchema>;
