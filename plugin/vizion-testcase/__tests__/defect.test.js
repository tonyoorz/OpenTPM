const { buildDefectFields } = require('../dist/defect.js');

describe('buildDefectFields', () => {
  test('maps a reviewed Defect draft to Octane field values', () => {
    expect(buildDefectFields({
      name: 'IPA widget does not load',
      descriptionHtml: '<html><body>Observed result</body></html>',
      severity: { type: 'list_node', id: 'list_node.severity.high' },
      phase: { type: 'phase', id: 'phase.defect.new' },
      owner: { type: 'workspace_user', id: '500026' },
      team: { type: 'team', id: '59139' },
      problemFinderTeam: { type: 'team', id: '59139' },
      detectedInRelease: { type: 'release', id: '4025' },
      assignedEcu: { type: 'list_node', id: 'ecu-1' },
      leadModel: { type: 'list_node', id: 'model-1' },
      softwareVersion: 'mainline24w49.5-1',
      vin: 'WBACR6109L9D27145',
      productAreas: [{ type: 'product_area', id: '320184' }],
      customTextFields: [{ fieldName: 'reporting_class_udf', value: 'Road test' }],
      customReferenceFields: [{
        fieldName: 'solution_cluster_udf',
        reference: { type: 'list_node', id: 'cluster-1' },
      }],
      customMultiReferenceFields: [{
        fieldName: 'requirements',
        references: [{ type: 'requirement', id: 'requirement-1' }],
      }],
    })).toEqual({
      name: 'IPA widget does not load',
      description: '<html><body>Observed result</body></html>',
      severity: { type: 'list_node', id: 'list_node.severity.high' },
      phase: { type: 'phase', id: 'phase.defect.new' },
      owner: { type: 'workspace_user', id: '500026' },
      team: { type: 'team', id: '59139' },
      problem_finder_team_udf: { type: 'team', id: '59139' },
      detected_in_release: { type: 'release', id: '4025' },
      assigned_ecu_udf: { type: 'list_node', id: 'ecu-1' },
      lead_model_udf: { type: 'list_node', id: 'model-1' },
      software_version_udf: 'mainline24w49.5-1',
      vin_udf: 'WBACR6109L9D27145',
      product_areas: { data: [{ type: 'product_area', id: '320184' }] },
      reporting_class_udf: 'Road test',
      solution_cluster_udf: { type: 'list_node', id: 'cluster-1' },
      requirements: { data: [{ type: 'requirement', id: 'requirement-1' }] },
    });
  });

  test('rejects custom fields that target reserved entity envelope fields', () => {
    expect(() => buildDefectFields({
      name: 'Widget does not load',
      descriptionHtml: '<p>Observed result</p>',
      severity: { type: 'list_node', id: 'list_node.severity.high' },
      phase: { type: 'phase', id: 'phase.defect.new' },
      owner: { type: 'workspace_user', id: '500026' },
      customTextFields: [{ fieldName: 'type', value: 'work_item' }],
    })).toThrow('custom field type cannot overwrite a reserved Octane entity field');
  });
});