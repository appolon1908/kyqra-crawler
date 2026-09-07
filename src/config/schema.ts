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

export type JobSpec = z.infer<typeof jobSpecSchema>;
