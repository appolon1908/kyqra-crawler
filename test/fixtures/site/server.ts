import type { Server } from 'node:http';

import express, { type Express } from 'express';

export interface FixtureSite {
  app: Express;
  baseUrl: string;
  close: () => Promise<void>;
}

export const buildFixtureSite = (): Express => {
  const app = express();

  app.get('/static', (_request, response) => {
    response.type('html').send(`<!doctype html><html><head>
      <title>Static Fixture</title>
      <meta name="description" content="A deterministic fixture page">
      <meta property="og:site_name" content="Fixture Industries">
      </head><body><h1>Static Fixture</h1><p>Contact: hello@fixture.test</p>
      <address>100 Test Avenue</address></body></html>`);
  });
  app.get('/js-rendered', (_request, response) => {
    response.type('html').send(`<!doctype html><html><head><title>JS Fixture</title></head>
      <body><div id="root">loading</div><script>
      document.querySelector('#root').textContent = 'Rendered Fixture';
      </script></body></html>`);
  });
  app.get('/list', (request, response) => {
    const page = Number(request.query.page || 1);
    const next = page < 3 ? `<a href="/list?page=${page + 1}">Next</a>` : '';
    response.type('html').send(`<!doctype html><html><head><title>List ${page}</title></head>
      <body><h1>Page ${page}</h1><article>Record ${page}</article>${next}</body></html>`);
  });
  app.get('/not-found', (_request, response) => response.status(404).send('fixture not found'));
  app.get('/server-error', (_request, response) =>
    response.status(500).send('fixture server error'),
  );
  app.get('/slow', async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.type('html').send('<html><head><title>Slow Fixture</title></head></html>');
  });
  app.get('/json-ld', (_request, response) => {
    response.type('html').send(`<!doctype html><html><head><title>JSON-LD Fixture</title>
      <script type="application/ld+json">{"@type":"Organization","name":"Fixture Org"}</script>
      </head><body><h1>Fixture Org</h1></body></html>`);
  });
  app.get('/login-walled', (request, response) => {
    if (request.headers.cookie !== 'fixture_session=allowed') {
      response.status(401).type('html').send('<html><body><h1>Login required</h1></body></html>');
      return;
    }
    response.type('html').send('<html><body><h1>Private Fixture</h1></body></html>');
  });
  return app;
};

export const startFixtureSite = async (): Promise<FixtureSite> => {
  const app = buildFixtureSite();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address_unavailable');
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
