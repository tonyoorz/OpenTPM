import { z } from 'zod';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FleemCommand, FleemOptions, FleemSnapshot } from './fleem';
import { createFleemServer, createSnapshotReader, loadFleemOptions } from './fleem';

const sourceUrl =
  'https://integrate.bmwgroup.net/fleem/Platforms?iql=ids.fleet%20in%20(%22FLEET-A%22%2C%22FLEET-B%22)&platformStatus=Active';

const detailPageSchema = z.object({
  json_chunk: z.string(),
  content_sha256: z.string(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  total_characters: z.number(),
});

function makeSnapshot(): FleemSnapshot {
  return {
    fetched_at: '2026-10-23T08:00:00Z',
    source_url: sourceUrl,
    query: 'ids.fleet in ("FLEET-A","FLEET-B")',
    platform_status: ['Active'],
    view: 'platform-EEK_Export',
    total: 3,
    platforms: [
      { _id: 'platform-1', ids: { vin: 'VIN-1', fleet: 'FLEET-A' }, name: 'First platform' },
      { _id: 'platform-2', ids: { vin: 'VIN-2', fleet: 'FLEET-A' }, name: 'Second platform' },
      { _id: 'platform-3', ids: { vin: 'VIN-3', fleet: 'FLEET-B' }, name: 'Third platform' },
    ],
    project_market_classification: {
      source: 'backend/analytics/assets/data/vin_project_mapping.json',
      rule: 'First VIN prefix match in the project mapping asset.',
      market_counts: { CN: 2, UNMAPPED: 1 },
      platforms: [
        { platform_id: 'platform-1', vin: 'VIN-1', market: 'CN', matched_vin_prefix: 'VIN-1' },
        { platform_id: 'platform-2', vin: 'VIN-2', market: 'CN', matched_vin_prefix: 'VIN-2' },
        { platform_id: 'platform-3', vin: 'VIN-3', market: '', matched_vin_prefix: '' },
      ],
    },
  };
}

describe('Fleem MCP', () => {
  let client: Client;
  let server: McpServer;
  let snapshot: FleemSnapshot;
  let failure: Error | undefined;
  let snapshotRequests: boolean[];

  beforeEach(async () => {
    snapshot = makeSnapshot();
    failure = undefined;
    snapshotRequests = [];
    server = createFleemServer(async (refresh = false) => {
      snapshotRequests.push(refresh);
      if (failure) {
        throw failure;
      }
      return snapshot;
    });
    client = new Client({ name: 'fleem-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it('exposes five read-only tools including complete field access', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'fleem_get_platform',
      'fleem_list_platform_fields',
      'fleem_query_platforms',
      'fleem_read_platform_details',
      'fleem_summarize_platforms',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('returns a bounded filtered page with complete-source totals and provenance', async () => {
    const result = await client.callTool({
      name: 'fleem_query_platforms',
      arguments: { fleet: 'FLEET-A', limit: 1 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      fetched_at: snapshot.fetched_at,
      source_url: sourceUrl,
      snapshot_total: 3,
      matched_total: 2,
      source_complete: true,
      returned: 1,
      has_more: true,
      next_offset: 1,
      platforms: [{ platform_id: 'platform-1', vin: 'VIN-1', fleet: 'FLEET-A', market: 'CN' }],
    });
  });

  it('supports the next page without mutating the cached snapshot', async () => {
    const result = await client.callTool({
      name: 'fleem_query_platforms',
      arguments: { fleet: 'fleet-a', limit: 1, offset: 1 },
    });
    expect(result.structuredContent).toMatchObject({
      matched_total: 2,
      returned: 1,
      has_more: false,
      next_offset: null,
      platforms: [{ platform_id: 'platform-2' }],
    });
    expect(snapshot.platforms).toHaveLength(3);
  });

  it('preserves native fleet arrays and filters by exact membership', async () => {
    snapshot.platforms[0].ids = { vin: 'VIN-1', fleet: ['FLEET-A', 'FLEET-B'] };
    const result = await client.callTool({
      name: 'fleem_query_platforms',
      arguments: { fleet: 'fleet-b' },
    });
    expect(result.structuredContent).toMatchObject({
      matched_total: 2,
      platforms: [
        { platform_id: 'platform-1', fleet: ['FLEET-A', 'FLEET-B'] },
        { platform_id: 'platform-3', fleet: 'FLEET-B' },
      ],
    });
    expect(snapshot.platforms[0].ids).toEqual({
      vin: 'VIN-1',
      fleet: ['FLEET-A', 'FLEET-B'],
    });
  });

  it('counts each fleet membership once per platform', async () => {
    snapshot.platforms[0].ids = { vin: 'VIN-1', fleet: ['FLEET-A', 'FLEET-B', 'FLEET-A'] };
    const result = await client.callTool({
      name: 'fleem_summarize_platforms',
      arguments: { group_by: 'fleet' },
    });
    expect(result.structuredContent).toMatchObject({
      matched_total: 3,
      groups: { 'FLEET-A': 2, 'FLEET-B': 2 },
    });
  });

  it('reads exact VIN details without returning unrelated platform records', async () => {
    const result = await client.callTool({
      name: 'fleem_get_platform',
      arguments: { vin: 'vin-2' },
    });
    expect(result.structuredContent).toMatchObject({
      found: true,
      platform: { platform_id: 'platform-2', vin: 'VIN-2', details: { name: 'Second platform' } },
    });
    expect(JSON.stringify(result)).not.toContain('Third platform');
  });

  it('preserves long values, large collections, and deeply nested native fields', async () => {
    let nested: FleemSnapshot['platforms'][number] = { value: 'Deep native field' };
    for (let depth = 0; depth < 12; depth++) {
      nested = { child: nested };
    }
    snapshot.platforms[1].native = {
      long_text: 'x'.repeat(5000),
      versions: Array.from({ length: 125 }, (_, index) => ({ version: index })),
      attributes: Object.fromEntries(
        Array.from({ length: 125 }, (_, index) => [`field_${index}`, index]),
      ),
      nested,
    };
    const result = await client.callTool({
      name: 'fleem_get_platform',
      arguments: { vin: 'VIN-2' },
    });
    expect(result.structuredContent).toMatchObject({
      platform: {
        details_truncated: false,
        details_redacted: false,
        details: { native: snapshot.platforms[1].native },
      },
    });
  });

  it('aggregates the complete matching snapshot, including unmapped markets', async () => {
    const result = await client.callTool({
      name: 'fleem_summarize_platforms',
      arguments: { group_by: 'market' },
    });
    expect(result.structuredContent).toMatchObject({
      matched_total: 3,
      source_complete: true,
      group_by: 'market',
      groups: { CN: 2, UNMAPPED: 1 },
    });
  });

  it('does not merge distinct fleet names with the same long prefix', async () => {
    const prefix = 'A'.repeat(128);
    snapshot.platforms[0].ids = { vin: 'VIN-1', fleet: `${prefix}-first` };
    snapshot.platforms[1].ids = { vin: 'VIN-2', fleet: `${prefix}-second` };
    const result = await client.callTool({
      name: 'fleem_summarize_platforms',
      arguments: { group_by: 'fleet' },
    });
    expect(result.structuredContent).toMatchObject({
      matched_total: 3,
      groups: { [`${prefix}-first`]: 1, [`${prefix}-second`]: 1, 'FLEET-B': 1 },
    });
  });

  it('does not treat a missing VIN as permission to return the entire fleet', async () => {
    const result = await client.callTool({ name: 'fleem_get_platform', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('First platform');
  });

  it('rejects oversized pages at the MCP interface', async () => {
    const result = await client.callTool({
      name: 'fleem_query_platforms',
      arguments: { limit: 10000 },
    });
    expect(result.isError).toBe(true);
  });

  it('removes sensitive fields nested in detail objects and arrays', async () => {
    snapshot.platforms[1].metadata = {
      authorization: 'synthetic-nested-secret',
      label: 'Visible metadata',
      children: [{ cookie: 'synthetic-cookie-secret', label: 'Visible child' }],
    };
    const result = await client.callTool({
      name: 'fleem_get_platform',
      arguments: { vin: 'VIN-2' },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-nested-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-cookie-secret');
    expect(result.structuredContent).toMatchObject({
      platform: {
        details_truncated: false,
        details_redacted: true,
        details: {
          metadata: { label: 'Visible metadata', children: [{ label: 'Visible child' }] },
        },
      },
    });
  });

  it('does not forward raw backend errors or credentials into tool results', async () => {
    failure = new Error('Authorization: Bearer synthetic-secret; raw child stderr');
    const result = await client.callTool({ name: 'fleem_query_platforms', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(JSON.stringify(result)).not.toContain('raw child stderr');
  });

  it('discovers actual field names and types with escaped JSON Pointer paths', async () => {
    snapshot.platforms[1]['native/key~'] = {
      'country/code~': 'HK',
      contract: null,
      versions: ['version-1', 'version-2'],
      password: 'synthetic-directory-secret',
    };
    const result = await client.callTool({
      name: 'fleem_list_platform_fields',
      arguments: { platform_id: 'platform-2', path: '/native~1key~0' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      path_found: true,
      details_redacted: true,
      value_type: 'object',
      total_fields: 3,
      returned: 3,
      has_more: false,
      fields: [
        { name: 'country/code~', path: '/native~1key~0/country~1code~0', value_type: 'string' },
        { name: 'contract', path: '/native~1key~0/contract', value_type: 'null' },
        { name: 'versions', path: '/native~1key~0/versions', value_type: 'array', size: 2 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-directory-secret');
  });

  it('paginates field directories beyond the former 100-field limit', async () => {
    snapshot.platforms[1].native = Object.fromEntries(
      Array.from({ length: 125 }, (_, index) => [`field_${index}`, index]),
    );
    const first = await client.callTool({
      name: 'fleem_list_platform_fields',
      arguments: { vin: 'VIN-2', path: '/native', limit: 100 },
    });
    const { content_sha256: digest } = z
      .object({ content_sha256: z.string() })
      .parse(first.structuredContent);
    expect(first.structuredContent).toMatchObject({
      total_fields: 125,
      returned: 100,
      has_more: true,
      next_offset: 100,
    });
    const last = await client.callTool({
      name: 'fleem_list_platform_fields',
      arguments: { vin: 'VIN-2', path: '/native', offset: 100, expected_sha256: digest },
    });
    expect(last.structuredContent).toMatchObject({
      total_fields: 125,
      returned: 25,
      has_more: false,
      next_offset: null,
    });
    expect(JSON.stringify(last.structuredContent)).toContain('field_124');
  });

  it('reassembles complete oversized native data from bounded JSON chunks', async () => {
    snapshot.platforms[1].native = {
      text: 'a"\\\n\u4e2d\ud83d\ude80'.repeat(4000),
      versions: Array.from({ length: 150 }, (_, index) => ({ index })),
    };
    const preview = await client.callTool({
      name: 'fleem_get_platform',
      arguments: { vin: 'VIN-2' },
    });
    expect(preview.structuredContent).toMatchObject({ platform: { details_truncated: true } });
    const chunks: string[] = [];
    let offset = 0;
    let digest: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const result = await client.callTool({
        name: 'fleem_read_platform_details',
        arguments: { vin: 'VIN-2', offset, chunk_size: 12000, expected_sha256: digest },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(32000);
      const page = detailPageSchema.parse(result.structuredContent);
      digest ??= page.content_sha256;
      expect(page.content_sha256).toBe(digest);
      chunks.push(page.json_chunk);
      hasMore = page.has_more;
      offset = page.next_offset ?? page.total_characters;
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(chunks.join(''))).toEqual(snapshot.platforms[1]);
  });

  it('reads an exact escaped path without returning unrelated native fields', async () => {
    snapshot.platforms[1]['native/key~'] = { 'country/code~': 'HK', other: 'Unrelated field' };
    const result = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { platform_id: 'platform-2', path: '/native~1key~0/country~1code~0' },
    });
    expect(result.structuredContent).toMatchObject({
      found: true,
      path_found: true,
      json_chunk: '"HK"',
      has_more: false,
      next_offset: null,
    });
    expect(JSON.stringify(result)).not.toContain('Unrelated field');
  });

  it('distinguishes an explicit null value from a missing path', async () => {
    snapshot.platforms[1].contract = null;
    const result = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { vin: 'VIN-2', path: '/contract' },
    });
    expect(result.structuredContent).toMatchObject({ path_found: true, json_chunk: 'null' });
    const missing = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { vin: 'VIN-2', path: '/absent' },
    });
    expect(missing.structuredContent).toMatchObject({ found: true, path_found: false });
  });

  it('redacts secrets throughout full data without mutating the source', async () => {
    snapshot.platforms[1].native = {
      children: [{ authorization: 'synthetic-full-secret', visible: 'Kept' }],
      password: 'synthetic-password-secret',
    };
    const result = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { vin: 'VIN-2' },
    });
    const page = detailPageSchema.parse(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ details_redacted: true, has_more: false });
    expect(JSON.parse(page.json_chunk)).toMatchObject({
      native: { children: [{ visible: 'Kept' }] },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-full-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-password-secret');
    expect(JSON.stringify(snapshot.platforms[1])).toContain('synthetic-full-secret');
    const hidden = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { vin: 'VIN-2', path: '/native/password' },
    });
    expect(hidden.structuredContent).toMatchObject({ path_found: false });
  });

  it.each(['fleem_list_platform_fields', 'fleem_read_platform_details'])(
    'requires a digest when continuing %s and rejects changed data',
    async (name) => {
      const first = await client.callTool({ name, arguments: { vin: 'VIN-2' } });
      const { content_sha256: digest } = z
        .object({ content_sha256: z.string() })
        .parse(first.structuredContent);
      const unpinned = await client.callTool({ name, arguments: { vin: 'VIN-2', offset: 1 } });
      expect(unpinned.isError).toBe(true);
      expect(JSON.stringify(unpinned)).toContain('CONTENT_DIGEST_REQUIRED');
      snapshot.platforms[1].name = 'Changed platform';
      const changed = await client.callTool({
        name,
        arguments: { vin: 'VIN-2', offset: 1, expected_sha256: digest },
      });
      expect(changed.isError).toBe(true);
      expect(JSON.stringify(changed)).toContain('CONTENT_CHANGED');
    },
  );

  it.each(['fleem_list_platform_fields', 'fleem_read_platform_details'])(
    'validates lookups and safe paths for %s',
    async (name) => {
      const missingId = await client.callTool({ name, arguments: {} });
      expect(missingId.isError).toBe(true);
      const bothIds = await client.callTool({
        name,
        arguments: { vin: 'VIN-2', platform_id: 'platform-2' },
      });
      expect(bothIds.isError).toBe(true);
      const notFound = await client.callTool({ name, arguments: { vin: 'NO-SUCH-VIN' } });
      expect(notFound.structuredContent).toMatchObject({ found: false, matched_total: 0 });
      const invalid = await client.callTool({ name, arguments: { vin: 'VIN-2', path: '/bad~2' } });
      expect(invalid.isError).toBe(true);
      const inherited = await client.callTool({
        name,
        arguments: { vin: 'VIN-2', path: '/toString' },
      });
      expect(inherited.structuredContent).toMatchObject({ path_found: false });
      snapshot.platforms[0].ids = { vin: 'VIN-2', fleet: 'FLEET-A' };
      const ambiguous = await client.callTool({ name, arguments: { vin: 'VIN-2' } });
      expect(ambiguous.isError).toBe(true);
      expect(JSON.stringify(ambiguous)).toContain('AMBIGUOUS_LOOKUP');
    },
  );

  it.each(['fleem_get_platform', 'fleem_list_platform_fields', 'fleem_read_platform_details'])(
    'rejects invalid lookups before fetching the snapshot for %s',
    async (name) => {
      const missing = await client.callTool({ name, arguments: {} });
      expect(missing.isError).toBe(true);
      expect(snapshotRequests).toHaveLength(0);
      const both = await client.callTool({
        name,
        arguments: { vin: 'VIN-2', platform_id: 'platform-2' },
      });
      expect(both.isError).toBe(true);
      expect(snapshotRequests).toHaveLength(0);
    },
  );

  it.each(['fleem_list_platform_fields', 'fleem_read_platform_details'])(
    'rejects continuation if the selected path disappeared for %s',
    async (name) => {
      snapshot.platforms[1].native = { value: 'Original value' };
      const first = await client.callTool({ name, arguments: { vin: 'VIN-2', path: '/native' } });
      const { content_sha256: digest } = z
        .object({ content_sha256: z.string() })
        .parse(first.structuredContent);
      delete snapshot.platforms[1].native;
      const result = await client.callTool({
        name,
        arguments: { vin: 'VIN-2', path: '/native', offset: 1, expected_sha256: digest },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('CONTENT_CHANGED');
    },
  );

  it('keeps large field directories bounded without silently skipping names', async () => {
    snapshot.platforms[1].native = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`${'k'.repeat(600)}_${index}`, index]),
    );
    const result = await client.callTool({
      name: 'fleem_list_platform_fields',
      arguments: { vin: 'VIN-2', path: '/native', limit: 100 },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(32000);
    const page = z
      .object({ returned: z.number(), next_offset: z.number(), has_more: z.literal(true) })
      .parse(result.structuredContent);
    expect(page.returned).toBeGreaterThan(0);
    expect(page.returned).toBeLessThan(100);
    expect(page.next_offset).toBe(page.returned);
  });

  it.each(['fleem_list_platform_fields', 'fleem_read_platform_details'])(
    'forwards refresh and supports array paths for %s',
    async (name) => {
      snapshot.platforms[1].native = [{ name: 'First' }, { name: 'Second' }];
      const result = await client.callTool({
        name,
        arguments: { platform_id: 'platform-2', path: '/native/1', refresh: true },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ path_found: true });
      expect(snapshotRequests).toEqual([true]);
    },
  );

  it.each(['fleem_list_platform_fields', 'fleem_read_platform_details'])(
    'does not let large fleet metadata block a small selection for %s',
    async (name) => {
      snapshot.platforms[1].ids = {
        vin: 'VIN-2',
        fleet: Array.from({ length: 400 }, (_, index) => `${'F'.repeat(100)}_${index}`),
      };
      const result = await client.callTool({ name, arguments: { vin: 'VIN-2', path: '/name' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ found: true, path_found: true });
      expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(32000);
    },
  );

  it('can continue beyond the snapshot byte limit when numeric JSON expands', async () => {
    snapshot.platforms[1].native = Array<number>(1_200_000).fill(1e20);
    const first = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { vin: 'VIN-2', path: '/native', chunk_size: 1 },
    });
    const page = detailPageSchema.parse(first.structuredContent);
    const offset = page.total_characters - 20;
    expect(offset).toBeGreaterThan(25 * 1024 * 1024);
    const last = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { vin: 'VIN-2', path: '/native', offset, expected_sha256: page.content_sha256 },
    });
    expect(last.isError).not.toBe(true);
    expect(last.structuredContent).toMatchObject({
      json_chunk: `${JSON.stringify(1e20)}]`.slice(-20),
      returned_characters: 20,
      has_more: false,
      next_offset: null,
    });
  });

  it('provides a parent-read fallback instead of an unusably long field path', async () => {
    const name = 'k'.repeat(4096);
    snapshot.platforms[1][name] = 'Visible';
    const result = await client.callTool({
      name: 'fleem_list_platform_fields',
      arguments: { vin: 'VIN-2' },
    });
    const { fields } = z
      .object({
        fields: z.array(
          z.object({
            name: z.string(),
            path: z.string().nullable(),
            read_parent: z.string().optional(),
          }),
        ),
      })
      .parse(result.structuredContent);
    const field = fields.find((entry) => entry.name === name);
    expect(field?.path).toBeNull();
    expect(field?.read_parent).toBe('');
    const parent = await client.callTool({
      name: 'fleem_read_platform_details',
      arguments: { vin: 'VIN-2', path: field?.read_parent },
    });
    expect(parent.isError).not.toBe(true);
    expect(JSON.parse(detailPageSchema.parse(parent.structuredContent).json_chunk)).toMatchObject({
      [name]: 'Visible',
    });
  });
});

describe('Fleem snapshot reader', () => {
  function options(extra: NodeJS.ProcessEnv = {}): FleemOptions {
    return loadFleemOptions({
      VIZION_LAB_ROOT: process.cwd(),
      FLEEM_PYTHON_PATH: 'python-fixture',
      FLEEM_VIEW_URL: sourceUrl,
      FLEEM_BEARER_TOKEN: 'synthetic-reader-secret',
      ...extra,
    });
  }

  it('reuses the existing Python CLI and passes credentials only in its environment', async () => {
    const commands: FleemCommand[] = [];
    const reader = createSnapshotReader(options(), async (command) => {
      commands.push(command);
      await writeFile(command.outputPath, JSON.stringify(makeSnapshot()));
    });
    expect(await reader()).toMatchObject({ total: 3 });
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command.executable).toBe('python-fixture');
    expect(command.args).toEqual([
      '-m',
      'backend.fleem_client',
      '--view-url',
      sourceUrl,
      '--view',
      'platform-EEK_Export',
      '--output',
      command.outputPath,
    ]);
    expect(command.env.FLEEM_BEARER_TOKEN).toBe('synthetic-reader-secret');
    expect(command.args.join(' ')).not.toContain('synthetic-reader-secret');
    await expect(stat(command.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the configured data view supported by the upstream CLI', async () => {
    const reader = createSnapshotReader(
      options({ FLEEM_DATA_VIEW: 'platform-authorized-view' }),
      async (command) => {
        expect(command.args).toEqual(
          expect.arrayContaining(['--view', 'platform-authorized-view']),
        );
        await writeFile(
          command.outputPath,
          JSON.stringify({ ...makeSnapshot(), view: 'platform-authorized-view' }),
        );
      },
    );
    await expect(reader()).resolves.toMatchObject({ view: 'platform-authorized-view' });
  });

  it('rejects a snapshot from a different data view', async () => {
    const reader = createSnapshotReader(
      options({ FLEEM_DATA_VIEW: 'platform-authorized-view' }),
      async (command) => {
        await writeFile(command.outputPath, JSON.stringify(makeSnapshot()));
      },
    );
    await expect(reader()).rejects.toThrow(/source view/i);
  });

  it.each(['', 'x'.repeat(129)])('rejects an invalid data view setting: %s', (view) => {
    expect(() => options({ FLEEM_DATA_VIEW: view })).toThrow(/FLEEM_DATA_VIEW/);
  });

  it('passes the configured proxy and temporary system CA bundle to Python', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      HTTPS_PROXY: 'http://proxy.example:8080',
      REQUESTS_CA_BUNDLE: undefined,
      CURL_CA_BUNDLE: undefined,
    });
    let certificatePath = '';
    const configuration = options({ FLEEM_USE_SYSTEM_CA: 'true' });
    expect(configuration.useSystemCa).toBe(true);
    const reader = createSnapshotReader(configuration, async (command) => {
      expect(command.env.HTTPS_PROXY).toBe('http://proxy.example:8080');
      certificatePath = command.env.REQUESTS_CA_BUNDLE ?? '';
      expect(certificatePath).not.toBe('');
      expect(await readFile(certificatePath, 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
      expect(command.env.PYTHONHTTPSVERIFY).not.toBe('0');
      await writeFile(command.outputPath, JSON.stringify(makeSnapshot()));
    });
    await expect(reader()).resolves.toMatchObject({ total: 3 });
    await expect(stat(certificatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an explicitly configured CA bundle', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      REQUESTS_CA_BUNDLE: 'existing-operator-ca.pem',
    });
    const reader = createSnapshotReader(
      options({ FLEEM_USE_SYSTEM_CA: 'true' }),
      async (command) => {
        expect(command.env.REQUESTS_CA_BUNDLE).toBe('existing-operator-ca.pem');
        await writeFile(command.outputPath, JSON.stringify(makeSnapshot()));
      },
    );
    await expect(reader()).resolves.toMatchObject({ total: 3 });
  });

  const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;
  windowsDescribe('Windows CA precedence', () => {
    it.each(['requests_ca_bundle', 'Requests_CA_Bundle', 'curl_ca_bundle'])(
      'preserves mixed-case Windows CA configuration: %s',
      async (key) => {
        jest.replaceProperty(process, 'env', {
          ...process.env,
          REQUESTS_CA_BUNDLE: undefined,
          CURL_CA_BUNDLE: undefined,
          [key]: 'existing-windows-ca.pem',
        });
        const reader = createSnapshotReader(
          options({ FLEEM_USE_SYSTEM_CA: 'true' }),
          async (command) => {
            expect(command.env[key]).toBe('existing-windows-ca.pem');
            expect(command.env.REQUESTS_CA_BUNDLE).toBeUndefined();
            await writeFile(command.outputPath, JSON.stringify(makeSnapshot()));
          },
        );
        await expect(reader()).resolves.toMatchObject({ total: 3 });
      },
    );
  });

  it('coalesces concurrent reads and supports cache expiry and explicit refresh', async () => {
    let now = 1000;
    let calls = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const reader = createSnapshotReader({ ...options(), cacheTtlMs: 1000 }, async (command) => {
      calls += 1;
      await writeFile(command.outputPath, JSON.stringify(makeSnapshot()));
    });
    await Promise.all([reader(), reader()]);
    expect(calls).toBe(1);
    await reader();
    expect(calls).toBe(1);
    now = 2001;
    await reader();
    expect(calls).toBe(2);
    await reader(true);
    expect(calls).toBe(3);
  });

  it('refuses to present an incomplete snapshot as complete data', async () => {
    const reader = createSnapshotReader(options(), async (command) => {
      await writeFile(command.outputPath, JSON.stringify({ ...makeSnapshot(), total: 4 }));
    });
    await expect(reader()).rejects.toThrow(/incomplete snapshot/i);
  });

  it('does not start a subprocess when per-user credentials are missing', async () => {
    let invoked = false;
    const reader = createSnapshotReader({ ...options(), bearerToken: '' }, async () => {
      invoked = true;
    });
    await expect(reader()).rejects.toThrow(/Fleem.*credential/i);
    expect(invoked).toBe(false);
  });

  it('rejects non-Fleem view URLs before starting a subprocess', () => {
    expect(() =>
      loadFleemOptions({
        VIZION_LAB_ROOT: process.cwd(),
        FLEEM_VIEW_URL: 'https://example.com/fleem/Platforms?iql=all&platformStatus=Active',
      }),
    ).toThrow(/FLEEM_VIEW_URL/);
  });

  it('removes temporary output and sanitizes errors when the external client fails', async () => {
    let outputPath = '';
    const reader = createSnapshotReader(options(), async (command) => {
      outputPath = command.outputPath;
      await writeFile(outputPath, 'partial snapshot');
      throw new Error('Authorization: Bearer synthetic-reader-secret; raw child stderr');
    });
    await expect(reader()).rejects.toThrow('Fleem request failed');
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['requests.exceptions.SSLError: CERTIFICATE_VERIFY_FAILED', 'TLS_VERIFY_FAILED'],
    ['requests.exceptions.ConnectTimeout: connection timed out', 'NETWORK_TIMEOUT'],
    ['requests.exceptions.HTTPError: 401 Client Error: Unauthorized', 'AUTH_REJECTED'],
    ['requests.exceptions.HTTPError: 403 Client Error: Forbidden', 'ACCESS_DENIED'],
  ])('classifies %s without returning raw stderr', async (stderr, code) => {
    const reader = createSnapshotReader(options(), async () => {
      throw Object.assign(new Error('External request failed'), {
        stderr: `${stderr}; Authorization: Bearer synthetic-upstream-secret`,
      });
    });
    await expect(reader()).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining('synthetic-upstream-secret'),
    });
  });

  it('rejects snapshots larger than the configured byte limit', async () => {
    const reader = createSnapshotReader(
      { ...options(), maxSnapshotBytes: 100 },
      async (command) => {
        await writeFile(command.outputPath, JSON.stringify(makeSnapshot()));
      },
    );
    await expect(reader()).rejects.toThrow(/size limit/i);
  });

  it('rejects snapshots from a different view instead of misreporting their scope', async () => {
    const reader = createSnapshotReader(options(), async (command) => {
      await writeFile(
        command.outputPath,
        JSON.stringify({ ...makeSnapshot(), source_url: 'https://example.com/fleem/Platforms' }),
      );
    });
    await expect(reader()).rejects.toThrow(/source view/i);
  });

  it('rejects duplicate platform IDs even when the reported row count matches', async () => {
    const reader = createSnapshotReader(options(), async (command) => {
      const snapshot = makeSnapshot();
      snapshot.platforms[1]._id = snapshot.platforms[0]._id;
      await writeFile(command.outputPath, JSON.stringify(snapshot));
    });
    await expect(reader()).rejects.toThrow(/duplicate platform/i);
  });

  it.each<[string, (snapshot: FleemSnapshot) => void]>([
    [
      'missing entries',
      (snapshot) => {
        snapshot.project_market_classification.platforms.pop();
      },
    ],
    [
      'duplicate IDs',
      (snapshot) => {
        snapshot.project_market_classification.platforms[1] = {
          ...snapshot.project_market_classification.platforms[0],
        };
      },
    ],
    [
      'wrong VIN',
      (snapshot) => {
        snapshot.project_market_classification.platforms[0].vin = 'VIN-OTHER';
      },
    ],
    [
      'incorrect counts',
      (snapshot) => {
        snapshot.project_market_classification.market_counts = { CN: 1, UNMAPPED: 2 };
      },
    ],
  ])('rejects inconsistent market classification: %s', async (_name, change) => {
    const reader = createSnapshotReader(options(), async (command) => {
      const snapshot = makeSnapshot();
      change(snapshot);
      await writeFile(command.outputPath, JSON.stringify(snapshot));
    });
    await expect(reader()).rejects.toThrow(/market classification/i);
  });
});
