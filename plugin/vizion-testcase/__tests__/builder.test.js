const {
  buildTestCaseDescription,
  buildTestStepsScript,
  DEFAULT_SERVICEPACK_NODE_ID,
} = require('../dist/builder.js');

describe('buildTestStepsScript', () => {
  test('renders all three step types in order', () => {
    const script = buildTestStepsScript({
      preconditions: ['Vehicle is running', 'Software version PU2707'],
      steps: ['Start the service', 'Monitor CPU load'],
      checkpoints: ['CPU load < 80%', 'No memory leak'],
    });
    const lines = script.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('- [PreCon] Vehicle is running');
    expect(lines[1]).toBe('- [PreCon] Software version PU2707');
    expect(lines[2]).toBe('- Start the service');
    expect(lines[3]).toBe('- Monitor CPU load');
    expect(lines[4]).toBe('- ? CPU load < 80%');
    expect(lines[5]).toBe('- ? No memory leak');
  });

  test('handles empty inputs', () => {
    const script = buildTestStepsScript({});
    expect(script).toBe('');
  });

  test('handles only checkpoints', () => {
    const script = buildTestStepsScript({ checkpoints: ['Verify result'] });
    expect(script).toBe('- ? Verify result');
  });
});

describe('buildTestCaseDescription', () => {
  const defect = {
    defect_id: '2804379',
    name: 'pps CPU load spike when car is moving',
    severity: 'High',
    software_version: 'PU2707',
    assigned_ecu: 'IDCEVO',
    lead_model: 'G01',
  };

  test('produces valid HTML structure', () => {
    const html = buildTestCaseDescription({
      defect,
      procedureSteps: ['Start service', 'Monitor load'],
      expected: ['Load < 80%'],
      preconditions: ['Vehicle running'],
    });
    expect(html).toMatch(/^<html><body>/);
    expect(html).toMatch(/<\/body><\/html>$/);
    expect(html).toContain('<b>Objective:</b>');
    expect(html).toContain('D2804379');
    expect(html).toContain('<b>Reference:</b>');
    expect(html).toContain('<b>Preconditions:</b>');
    expect(html).toContain('<b>procedure:</b>');
    expect(html).toContain('1. Start service');
    expect(html).toContain('2. Monitor load');
    expect(html).toContain('<b>expected:</b>');
  });

  test('includes defect link', () => {
    const html = buildTestCaseDescription({
      defect,
      procedureSteps: ['Step'],
      expected: ['Result'],
    });
    expect(html).toContain('href=');
    expect(html).toContain('entity-navigation');
    expect(html).toContain('id=2804379');
  });

  test('includes pass/fail criteria when provided', () => {
    const html = buildTestCaseDescription({
      defect,
      procedureSteps: ['Step'],
      expected: ['Result'],
      passCriteria: 'CPU stable',
      failCriteria: 'CPU exceeds 90%',
    });
    expect(html).toContain('<b>Pass criteria:</b> CPU stable');
    expect(html).toContain('<b>Fail criteria:</b> CPU exceeds 90%');
  });

  test('escapes HTML in user content', () => {
    const html = buildTestCaseDescription({
      defect: { defect_id: '123', name: '<script>alert(1)</script>' },
      procedureSteps: ['<img src=x>'],
      expected: ['Result'],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('exports correct servicepack constant', () => {
    expect(DEFAULT_SERVICEPACK_NODE_ID).toBe('d1598r3mjrp37by4yjvy1860k');
  });
});
