import crypto from 'node:crypto';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';

import { Agent } from 'undici';

const callbackAllowlist = (): string[] =>
  (process.env.CALLBACK_ALLOWLIST || 'kyqra.com,10.40.0.1')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

const metadataHostnames = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
  'metadata',
]);

const configuredHosts = (name: string): string[] =>
  (process.env[name] || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

const hostMatches = (host: string, configured: string[]): boolean =>
  configured.some((value) => host === value || host.endsWith(`.${value}`));

const validateCrawlHostname = (host: string): void => {
  if (
    metadataHostnames.has(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    hostMatches(host, configuredHosts('CRAWL_HOST_DENYLIST'))
  ) {
    throw new Error('crawl_target_denied');
  }
  const allowlist = configuredHosts('CRAWL_HOST_ALLOWLIST');
  if (allowlist.length > 0 && !hostMatches(host, allowlist)) {
    throw new Error('crawl_target_not_allowlisted');
  }
};

export const isCallbackAllowed = (rawUrl: string): boolean => {
  const url = new URL(rawUrl);
  const protocolAllowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '10.40.0.1');
  return (
    protocolAllowed &&
    callbackAllowlist().some(
      (allowedHost) => url.hostname === allowedHost || url.hostname.endsWith(`.${allowedHost}`),
    )
  );
};

export const isProhibitedAddress = (address: string): boolean => {
  if (address === '10.40.0.1') return false;
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    const first = octets[0];
    const second = octets[1];
    const third = octets[2];
    if (first === undefined || second === undefined || third === undefined) return true;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    if (net.isIPv4(mapped)) return isProhibitedAddress(mapped);
    const hexadecimal = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (!hexadecimal) return true;
    const high = Number.parseInt(hexadecimal[1] || '', 16);
    const low = Number.parseInt(hexadecimal[2] || '', 16);
    const normalized = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    return isProhibitedAddress(normalized);
  }
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('ff') ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('2001:db8:')
  );
};

export const validateCrawlRedirectTarget = (location: string, baseUrl: string): string => {
  let target: URL;
  try {
    target = new URL(location, baseUrl);
  } catch {
    throw new Error('crawl_redirect_invalid');
  }
  const host = target.hostname.replace(/\.$/, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    Boolean(target.username || target.password)
  ) {
    throw new Error('crawl_redirect_denied');
  }
  validateCrawlHostname(host);
  return target.href;
};

export const createPinnedCallbackAgent = async (rawUrl: string): Promise<Agent> => {
  if (!isCallbackAllowed(rawUrl)) throw new Error('callback_not_allowed');
  const hostname = new URL(rawUrl).hostname;
  const resolved = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIPv4(hostname) ? 4 : 6 }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0 || resolved.some((item) => isProhibitedAddress(item.address))) {
    throw new Error('callback_destination_rejected');
  }
  const pinned = resolved[0];
  if (!pinned) throw new Error('callback_destination_rejected');

  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    },
  });
};

export interface ResolvedCrawlTarget {
  hostname: string;
  addresses: Array<{ address: string; family: number }>;
}

export type CrawlTargetResolver = (rawUrl: string) => Promise<ResolvedCrawlTarget>;

const resolveCrawlTarget = async (rawUrl: string): Promise<ResolvedCrawlTarget> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('crawl_target_invalid');
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || Boolean(url.username || url.password)) {
    throw new Error('crawl_target_denied');
  }
  validateCrawlHostname(host);
  const resolved = net.isIP(host)
    ? [{ address: host, family: net.isIPv4(host) ? 4 : 6 }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error('crawl_target_unresolvable');
  const addresses = [...new Map(resolved.map((item) => [item.address, item])).values()].sort(
    (left, right) => left.address.localeCompare(right.address),
  );
  if (
    process.env.KYQRA_ALLOW_TEST_TARGETS !== 'true' &&
    addresses.some(({ address }) => address === '10.40.0.1' || isProhibitedAddress(address))
  ) {
    throw new Error('crawl_target_private_address');
  }
  return { hostname: host, addresses };
};

export const validateCrawlTarget = async (rawUrl: string): Promise<void> => {
  await resolveCrawlTarget(rawUrl);
};

export const createCrawlTargetResolver = (): CrawlTargetResolver => {
  const fingerprints = new Map<string, string>();
  return async (rawUrl: string): Promise<ResolvedCrawlTarget> => {
    const resolved = await resolveCrawlTarget(rawUrl);
    const fingerprint = resolved.addresses.map(({ address }) => address).join(',');
    const prior = fingerprints.get(resolved.hostname);
    if (prior && prior !== fingerprint) throw new Error('crawl_target_dns_rebinding');
    fingerprints.set(resolved.hostname, fingerprint);
    return resolved;
  };
};

export const createCrawlTargetGuard = (): ((rawUrl: string) => Promise<void>) => {
  const resolve = createCrawlTargetResolver();
  return async (rawUrl: string): Promise<void> => {
    await resolve(rawUrl);
  };
};

export const crawlWebSocketGuardTarget = (rawUrl: string): string => {
  const target = new URL(rawUrl);
  if (target.protocol === 'ws:') target.protocol = 'http:';
  else if (target.protocol === 'wss:') target.protocol = 'https:';
  else throw new Error('crawl_target_denied');
  return target.toString();
};

export const createPinnedCrawlLookup = async (
  rawUrl: string,
  resolve: CrawlTargetResolver = resolveCrawlTarget,
): Promise<net.LookupFunction> => {
  const initial = await resolve(rawUrl);
  const pinned = new Map<string, ResolvedCrawlTarget['addresses']>([
    [initial.hostname, initial.addresses],
  ]);
  const lookup = (
    hostname: string,
    options: number | LookupOneOptions | LookupAllOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    const normalized = hostname.replace(/\.$/, '').toLowerCase();
    const respond = (addresses: ResolvedCrawlTarget['addresses']): void => {
      const wantsAll = typeof options === 'object' && options.all === true;
      if (wantsAll) callback(null, addresses);
      else {
        const requestedFamily = typeof options === 'number' ? options : options.family;
        const selected =
          addresses.find(({ family }) => !requestedFamily || family === requestedFamily) ||
          addresses[0];
        if (!selected) return callback(new Error('crawl_target_unresolvable'), '', 0);
        callback(null, selected.address, selected.family);
      }
    };
    const existing = pinned.get(normalized);
    if (existing) return respond(existing);
    validateCrawlHostname(normalized);
    void resolve(`https://${normalized}/`).then(
      (resolved) => {
        pinned.set(normalized, resolved.addresses);
        respond(resolved.addresses);
      },
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error('crawl_target_denied'), '', 0),
    );
  };
  return lookup as net.LookupFunction;
};

export const callbackSignatureInput = (
  method: string,
  path: string,
  timestamp: string,
  eventId: string,
  source: string,
  body: string,
): string => {
  const normalizedPath = `/${path.split('/').filter(Boolean).join('/')}`;
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return ['v1', method.toUpperCase(), normalizedPath, timestamp, eventId, source, bodyHash].join(
    '\n',
  );
};
