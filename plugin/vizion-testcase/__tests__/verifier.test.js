const { verifyTestCase } = require('../dist/verifier.js');

describe('verifyTestCase', () => {
  const goodDefect = { defect_id: '2804379', name: 'pps CPU load spike when car is moving' };
  const goodDescription = '<html><body><p>Regression test for D2804379</p></body></html>';
  const goodSteps = [
    '- [PreCon] Vehicle is in driving mode',
    '- Start the pps service',
    '- Monitor CPU load for 60 seconds',
    '- Record the peak CPU load value',
    '- ? CPU load should not exceed 80%',
    '- ? No memory leaks detected within 5 minutes',
  ].join('\n');

  test('passes all checks for well-formed input', () => {
    const result = verifyTestCase({
      defect: goodDefect,
      descriptionHtml: goodDescription,
      stepsText: goodSteps,
    });
    expect(result.passed).toBe(true);
    expect(result.pass_count).toBe(5);
    expect(result.total_count).toBe(5);
    expect(result.feedback).toBe('');
  });

  test('fails format_compliance when missing [PreCon]', () => {
    const badSteps = '- Step 1\n- Step 2\n- ? Check result';
    const result = verifyTestCase({
      defect: goodDefect,
      descriptionHtml: goodDescription,
      stepsText: badSteps,
    });
    const formatCheck = result.criteria.find((c) => c.name === 'format_compliance');
    expect(formatCheck.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  test('fails defect_traceability when description lacks defect ID', () => {
    const badDescription = '<html><body><p>Regression test without ID</p></body></html>';
    const result = verifyTestCase({
      defect: goodDefect,
      descriptionHtml: badDescription,
      stepsText: goodSteps,
    });
    const traceCheck = result.criteria.find((c) => c.name === 'defect_traceability');
    expect(traceCheck.passed).toBe(false);
  });

  test('fails step_reproducibility with fewer than 3 action steps', () => {
    const fewSteps = '- [PreCon] Setup\n- One action\n- ? Check something';
    const result = verifyTestCase({
      defect: goodDefect,
      descriptionHtml: goodDescription,
      stepsText: fewSteps,
    });
    const reproCheck = result.criteria.find((c) => c.name === 'step_reproducibility');
    expect(reproCheck.passed).toBe(false);
  });

  test('fails checkpoint_quantification when checkpoints lack values', () => {
    const vagueSteps = '- [PreCon] Setup\n- Do something\n- Do another thing\n- ? Check it works\n- ? Verify behavior';
    const result = verifyTestCase({
      defect: goodDefect,
      descriptionHtml: goodDescription,
      stepsText: vagueSteps,
    });
    const quantCheck = result.criteria.find((c) => c.name === 'checkpoint_quantification');
    expect(quantCheck.passed).toBe(false);
  });
});
