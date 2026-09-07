import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';

import {
  crawlWebSocketGuardTarget,
  type CrawlTargetResolver,
  type ResolvedCrawlTarget,
} from './security.js';

export interface PinnedCrawlProxy {
  url: string;
  close: () => Promise<void>;
}

const responseError = (response: ServerResponse, status: number): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' });
  response.end(status === 403 ? 'target denied\n' : 'upstream unavailable\n');
};

const sanitizedHeaders = (
  request: IncomingMessage,
  target: URL,
): Record<string, string | string[] | undefined> => {
  const headers: Record<string, string | string[] | undefined> = {
    ...request.headers,
    host: target.host,
  };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  return headers;
};

const selectedAddress = (resolved: ResolvedCrawlTarget): string => {
  const selected =
    resolved.addresses.find(({ family }) => family === 4)?.address ??
    resolved.addresses[0]?.address;
  if (!selected) throw new Error('crawl_target_unresolvable');
  return selected;
};

const absoluteTarget = (request: IncomingMessage): URL => {
  const target = new URL(request.url || '');
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('crawl_target_denied');
  return target;
};

const authorityTarget = (authority: string): URL => {
  const target = new URL(`https://${authority}/`);
  if (!target.port) target.port = '443';
  return target;
};

export const createPinnedCrawlProxy = async (
  resolveTarget: CrawlTargetResolver,
): Promise<PinnedCrawlProxy> => {
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void (async () => {
      const target = absoluteTarget(request);
      const resolved = await resolveTarget(target.toString());
      const address = selectedAddress(resolved);
      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request(
        {
          hostname: address,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          servername: target.protocol === 'https:' ? target.hostname : undefined,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers: sanitizedHeaders(request, target),
          timeout: 60_000,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));
      upstream.on('error', () => responseError(response, 502));
      request.pipe(upstream);
    })().catch(() => responseError(response, 403));
  });

  server.on('connect', (request, clientSocket, head) => {
    void (async () => {
      const target = authorityTarget(request.url || '');
      const resolved = await resolveTarget(target.toString());
      const upstream = net.createConnection({
        host: selectedAddress(resolved),
        port: Number(target.port),
        timeout: 60_000,
      });
      sockets.add(upstream);
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.once('timeout', () => upstream.destroy(new Error('upstream_timeout')));
      upstream.once('error', () => clientSocket.destroy());
      upstream.once('close', () => sockets.delete(upstream));
    })().catch(() => {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
    });
  });

  server.on('upgrade', (request, clientSocket, head) => {
    void (async () => {
      const target = new URL(request.url || '');
      const resolved = await resolveTarget(crawlWebSocketGuardTarget(target.toString()));
      const upstream = net.createConnection({
        host: selectedAddress(resolved),
        port: Number(target.port || 80),
        timeout: 60_000,
      });
      sockets.add(upstream);
      upstream.once('connect', () => {
        const headers = sanitizedHeaders(request, target);
        const serialized = Object.entries(headers)
          .flatMap(([name, value]) =>
            Array.isArray(value)
              ? value.map((item) => `${name}: ${item}`)
              : value === undefined
                ? []
                : [`${name}: ${value}`],
          )
          .join('\r\n');
        upstream.write(
          `${request.method || 'GET'} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n${serialized}\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.once('timeout', () => upstream.destroy(new Error('upstream_timeout')));
      upstream.once('error', () => clientSocket.destroy());
      upstream.once('close', () => sockets.delete(upstream));
    })().catch(() => clientSocket.destroy());
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('crawl_proxy_bind_failed');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};
