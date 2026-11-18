import { isIP } from 'node:net';
import { Agent, ProxyAgent } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport';
import type { Dispatcher } from 'undici';
import { createSSRFSafeUndiciConnect, isOAuthUrlAllowed, isSSRFTarget } from '~/auth';
import { getOAuthUrlPort } from './url';

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: Dispatcher;
};

const MAX_OAUTH_DISPATCHERS = 64;
const oauthDispatchers = new Map<string, Dispatcher>();

function shouldBypassSSRFDispatcher(url: string | URL, allowedDomains?: string[] | null): boolean {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return false;
  }

  return isOAuthUrlAllowed(url.toString(), allowedDomains, null);
}

function getDispatcherCacheKey(port: string, allowedAddresses?: string[] | null): string {
  const normalizedAddresses = Array.isArray(allowedAddresses)
    ? [...new Set(allowedAddresses)].sort().join('\n')
    : '';
  return `${port}\0${normalizedAddresses}`;
}

function evictOldestDispatcher(): void {
  const oldestKey = oauthDispatchers.keys().next().value as string | undefined;
  if (!oldestKey) {
    return;
  }

  const dispatcher = oauthDispatchers.get(oldestKey);
  oauthDispatchers.delete(oldestKey);
  void dispatcher?.close().catch(() => undefined);
}

function getCachedDispatcher(cacheKey: string, createDispatcher: () => Dispatcher): Dispatcher {
  const cached = oauthDispatchers.get(cacheKey);
  if (cached) {
    oauthDispatchers.delete(cacheKey);
    oauthDispatchers.set(cacheKey, cached);
    return cached;
  }

  if (oauthDispatchers.size >= MAX_OAUTH_DISPATCHERS) {
    evictOldestDispatcher();
  }

  const dispatcher = createDispatcher();
  oauthDispatchers.set(cacheKey, dispatcher);
  return dispatcher;
}

function getOAuthDispatcher(
  url: string | URL,
  allowedDomains?: string[] | null,
  allowedAddresses?: string[] | null,
  proxy?: string,
): Dispatcher | undefined {
  const parsedUrl = url instanceof URL ? url : new URL(url);
  const port = getOAuthUrlPort(parsedUrl);
  const effectiveAddresses =
    Array.isArray(allowedDomains) && allowedDomains.length > 0 ? null : allowedAddresses;

  if (proxy) {
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    const trusted = isOAuthUrlAllowed(parsedUrl.href, allowedDomains, effectiveAddresses);
    if (!trusted && (!isIP(hostname) || isSSRFTarget(hostname, effectiveAddresses, port))) {
      throw new Error(
        'SSRF protection: proxied OAuth targets must be public IP literals or explicitly allowed endpoints',
      );
    }
    return getCachedDispatcher(`proxy\0${proxy}`, () => new ProxyAgent({ uri: proxy }));
  }

  if (shouldBypassSSRFDispatcher(parsedUrl, allowedDomains)) {
    return undefined;
  }

  return getCachedDispatcher(
    `direct\0${getDispatcherCacheKey(port, effectiveAddresses)}`,
    () => new Agent({ connect: createSSRFSafeUndiciConnect(effectiveAddresses, port) }),
  );
}

export function createHardenedOAuthFetch({
  allowedDomains,
  allowedAddresses,
  proxy,
}: {
  allowedDomains?: string[] | null;
  allowedAddresses?: string[] | null;
  proxy?: string;
} = {}): FetchLike {
  const proxyUrl = proxy?.trim();
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const dispatcher = getOAuthDispatcher(url, allowedDomains, allowedAddresses, proxyUrl);
    const fetchInit: FetchInitWithDispatcher =
      dispatcher != null ? { ...init, dispatcher } : { ...init };
    if (proxyUrl) {
      fetchInit.redirect = 'manual';
    }
    const response = await fetch(url, fetchInit);
    if (proxyUrl && response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Proxied OAuth endpoint redirects are not allowed');
    }
    return response;
  };
}

export function resetHardenedOAuthFetchDispatchers(): void {
  for (const dispatcher of oauthDispatchers.values()) {
    dispatcher.destroy();
  }
  oauthDispatchers.clear();
}
