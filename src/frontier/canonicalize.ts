import crypto from 'node:crypto';

const TRACKING_PARAMETERS = ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid'];

export const canonicalizeUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const parameter of TRACKING_PARAMETERS) url.searchParams.delete(parameter);
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
};

export const urlHash = (rawUrl: string): string =>
  crypto.createHash('sha256').update(canonicalizeUrl(rawUrl)).digest('hex');
