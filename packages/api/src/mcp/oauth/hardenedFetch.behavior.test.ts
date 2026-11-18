import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHardenedOAuthFetch, resetHardenedOAuthFetchDispatchers } from './hardenedFetch';
import { createOAuthProxy } from '../__tests__/helpers/oauthTestServer';

type TestServer = {
  port: number;
  requestCount: () => number;
  close: () => Promise<void>;
};

async function createLocalServer(proxyTargetPort?: number): Promise<TestServer> {
  if (proxyTargetPort !== undefined) {
    return createOAuthProxy(`http://localhost:${proxyTargetPort}`);
  }
  let requestCount = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((request, res) => {
    requestCount += 1;
    if (request.url === '/redirect') {
      res.writeHead(307, { Location: '/token' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    requestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

describe('createHardenedOAuthFetch request policy', () => {
  let server: TestServer;
  let proxy: TestServer | undefined;

  beforeEach(async () => {
    server = await createLocalServer();
    proxy = undefined;
  });

  afterEach(async () => {
    resetHardenedOAuthFetchDispatchers();
    await proxy?.close();
    await server.close();
  });

  it('sends OAuth requests through the configured server proxy', async () => {
    proxy = await createLocalServer(server.port);
    const options = {
      allowedAddresses: [`localhost:${server.port}`],
      proxy: `http://localhost:${proxy.port}`,
    };

    const response = await createHardenedOAuthFetch(options)(
      `http://localhost:${server.port}/token`,
      { signal: AbortSignal.timeout(3000) },
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(proxy.requestCount()).toBe(1);
    expect(server.requestCount()).toBe(1);
  });

  it('still uses the server proxy when the OAuth domain is explicitly trusted', async () => {
    proxy = await createLocalServer(server.port);
    const options = {
      allowedDomains: ['localhost'],
      proxy: `http://localhost:${proxy.port}`,
    };

    const response = await createHardenedOAuthFetch(options)(
      `http://localhost:${server.port}/token`,
      { signal: AbortSignal.timeout(3000) },
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(proxy.requestCount()).toBe(1);
  });

  it('rejects untrusted local targets before contacting the proxy', async () => {
    proxy = await createLocalServer(server.port);
    const options = { proxy: `http://localhost:${proxy.port}` };

    await expect(
      createHardenedOAuthFetch(options)(`http://localhost:${server.port}/token`, {
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toThrow();

    expect(proxy.requestCount()).toBe(0);
    expect(server.requestCount()).toBe(0);
  });

  it('keeps domain-policy precedence for requests through a proxy', async () => {
    proxy = await createLocalServer(server.port);
    const options = {
      allowedDomains: ['trusted.example.com'],
      allowedAddresses: [`localhost:${server.port}`],
      proxy: `http://localhost:${proxy.port}`,
    };

    await expect(
      createHardenedOAuthFetch(options)(`http://localhost:${server.port}/token`, {
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toThrow();

    expect(proxy.requestCount()).toBe(0);
    expect(server.requestCount()).toBe(0);
  });

  it('does not follow proxied OAuth endpoint redirects with credentials', async () => {
    proxy = await createLocalServer(server.port);
    const options = {
      allowedAddresses: [`localhost:${server.port}`],
      proxy: `http://localhost:${proxy.port}`,
    };

    await expect(
      createHardenedOAuthFetch(options)(`http://localhost:${server.port}/redirect`, {
        method: 'POST',
        body: 'client_secret=fixture-secret',
        redirect: 'follow',
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toThrow(/redirect/i);

    expect(server.requestCount()).toBe(1);
  });

  it('keeps different server proxies isolated', async () => {
    proxy = await createLocalServer(server.port);
    const otherProxy = await createLocalServer(server.port);
    const options = { allowedAddresses: [`localhost:${server.port}`] };

    try {
      for (const proxyServer of [proxy, otherProxy]) {
        const response = await createHardenedOAuthFetch({
          ...options,
          proxy: `http://localhost:${proxyServer.port}`,
        })(`http://localhost:${server.port}/token`, { signal: AbortSignal.timeout(3000) });

        await expect(response.json()).resolves.toEqual({ ok: true });
      }

      expect(proxy.requestCount()).toBe(1);
      expect(otherProxy.requestCount()).toBe(1);
    } finally {
      await otherProxy.close();
    }
  });

  it('blocks local OAuth requests unless the endpoint is explicitly trusted', async () => {
    const oauthFetch = createHardenedOAuthFetch();

    await expect(
      oauthFetch(`http://localhost:${server.port}/token`, {
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow();

    expect(server.requestCount()).toBe(0);
  });

  it('allows explicitly trusted local OAuth endpoints', async () => {
    const oauthFetch = createHardenedOAuthFetch({ allowedDomains: ['localhost'] });

    const response = await oauthFetch(`http://localhost:${server.port}/token`, {
      signal: AbortSignal.timeout(1000),
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(server.requestCount()).toBe(1);
  });

  it('does not use address exemptions when domain policy is active but unmatched', async () => {
    const oauthFetch = createHardenedOAuthFetch({
      allowedDomains: ['trusted.example.com'],
      allowedAddresses: [`localhost:${server.port}`],
    });

    await expect(
      oauthFetch(`http://localhost:${server.port}/token`, {
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow();

    expect(server.requestCount()).toBe(0);
  });
});
