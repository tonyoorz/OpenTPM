const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDefectUrl, clearCookieCache, createDefect } = require('../dist/octane.js');

const originalFetch = global.fetch;
const originalCookieFile = process.env.OCTANE_COOKIE_FILE;

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('createDefect', () => {
  let cookieFile;

  beforeEach(() => {
    cookieFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vizion-octane-')), 'cookie.txt');
    fs.writeFileSync(cookieFile, 'AUTH=abc; XSRF_COOKIE=xsrf-token');
    process.env.OCTANE_COOKIE_FILE = cookieFile;
    clearCookieCache();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: '2809999' }] }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreEnvironmentVariable('OCTANE_COOKIE_FILE', originalCookieFile);
    clearCookieCache();
    fs.rmSync(path.dirname(cookieFile), { recursive: true, force: true });
  });

  test('posts a Defect envelope with the XSRF header', async () => {
    await expect(createDefect({
      name: 'Widget does not load',
      descriptionHtml: '<p>Observed result</p>',
      severity: { type: 'list_node', id: 'list_node.severity.high' },
      phase: { type: 'phase', id: 'phase.defect.new' },
      owner: { type: 'workspace_user', id: '500026' },
    })).resolves.toEqual({ id: '2809999' });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://octane-prod.bmwgroup.net/api/shared_spaces/1002/workspaces/2001/defects',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'XSRF-HEADER': 'xsrf-token' }),
        body: JSON.stringify({
          data: [{
            type: 'defect',
            name: 'Widget does not load',
            description: '<p>Observed result</p>',
            severity: { type: 'list_node', id: 'list_node.severity.high' },
            phase: { type: 'phase', id: 'phase.defect.new' },
            owner: { type: 'workspace_user', id: '500026' },
          }],
        }),
      }),
    );
  });

  test('builds the Octane Defect navigation URL', () => {
    expect(buildDefectUrl('2809999')).toBe(
      'https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=defect&id=2809999',
    );
  });
});