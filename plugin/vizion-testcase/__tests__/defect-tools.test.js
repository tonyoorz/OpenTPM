const { registerDefectTicketTools } = require('../dist/defect-tools.js');

function makeInput(overrides = {}) {
  return {
    name: 'Widget does not load',
    description_html: '<p>Observed result</p>',
    severity: { type: 'list_node', id: 'list_node.severity.high' },
    phase: { type: 'phase', id: 'phase.defect.new' },
    owner: { type: 'workspace_user', id: '500026' },
    custom_multi_reference_fields: [{
      field_name: 'requirements',
      references: [{ type: 'requirement', id: 'requirement-1' }],
    }],
    ...overrides,
  };
}

describe('registerDefectTicketTools', () => {
  test('registers a non-writing preview before the production commit tool', async () => {
    const registrations = new Map();
    const server = {
      registerTool(name, definition, handler) {
        registrations.set(name, { definition, handler });
      },
    };

    registerDefectTicketTools(server);

    expect([...registrations.keys()]).toEqual([
      'validate_defect_ticket',
      'commit_defect_ticket',
    ]);

    const preview = await registrations.get('validate_defect_ticket').handler(makeInput());
    expect(JSON.parse(preview.content[0].text)).toEqual({
      success: true,
      octane_fields: {
        name: 'Widget does not load',
        description: '<p>Observed result</p>',
        severity: { type: 'list_node', id: 'list_node.severity.high' },
        phase: { type: 'phase', id: 'phase.defect.new' },
        owner: { type: 'workspace_user', id: '500026' },
        requirements: { data: [{ type: 'requirement', id: 'requirement-1' }] },
      },
    });
  });

  test('commits the reviewed draft and returns the created Defect link', async () => {
    const registrations = new Map();
    const createDefect = jest.fn().mockResolvedValue({ id: '2809999' });
    const server = {
      registerTool(name, definition, handler) {
        registrations.set(name, { definition, handler });
      },
    };

    registerDefectTicketTools(server, {
      createDefect,
      buildDefectUrl: (defectId) => `https://octane.example/defects/${defectId}`,
    });

    const committed = await registrations.get('commit_defect_ticket').handler(makeInput());

    expect(createDefect).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Widget does not load',
      descriptionHtml: '<p>Observed result</p>',
      customMultiReferenceFields: [{
        fieldName: 'requirements',
        references: [{ type: 'requirement', id: 'requirement-1' }],
      }],
    }));
    expect(JSON.parse(committed.content[0].text)).toEqual({
      success: true,
      defect_id: '2809999',
      octane_url: 'https://octane.example/defects/2809999',
    });
  });
});