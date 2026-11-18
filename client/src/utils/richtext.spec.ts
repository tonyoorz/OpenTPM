import { markdownToHtml } from './richtext';

describe('markdownToHtml', () => {
  it('renders headings, emphasis, links and lists', () => {
    const html = markdownToHtml('# Title\n\n**Bold** and *italic*.\n\n- One\n- Two');

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<ul><li>One</li><li>Two</li></ul>');
  });

  it('renders GFM tables with inline styling and alignment', () => {
    const html = markdownToHtml('| Name | Value |\n| :--- | ---: |\n| Test | 42 |');
    const document = new DOMParser().parseFromString(html, 'text/html');

    expect(document.querySelectorAll('th')).toHaveLength(2);
    expect(document.querySelectorAll('td')).toHaveLength(2);
    expect(document.querySelector('table')?.style.borderCollapse).toBe('collapse');
    expect(document.querySelectorAll('td')[1].style.textAlign).toBe('right');
  });

  it('keeps soft line breaks visible', () => {
    expect(markdownToHtml('First\nSecond')).toContain('First<br />Second');
  });

  it('escapes code without activating markup', () => {
    const html = markdownToHtml('```html\n<script>alert(1)</script>\n```');
    const document = new DOMParser().parseFromString(html, 'text/html');

    expect(document.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>');
    expect(document.querySelector('script')).toBeNull();
  });

  it('copies raw HTML as visible text', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)>');
    const document = new DOMParser().parseFromString(html, 'text/html');

    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'vbscript:alert(1)'])(
    'does not activate unsafe link protocol %s',
    (url) => {
      const document = new DOMParser().parseFromString(
        markdownToHtml(`[Unsafe](${url})`),
        'text/html',
      );

      expect(document.querySelector('a')).toBeNull();
      expect(document.body.textContent).toBe('Unsafe');
    },
  );

  it('resolves relative links against the application', () => {
    expect(markdownToHtml('[Conversation](/c/example)')).toContain(
      'href="http://localhost:3080/c/example"',
    );
  });

  it('escapes quotes in link URLs', () => {
    const document = new DOMParser().parseFromString(
      markdownToHtml('[Link](<https://example.com/?value="quoted">)'),
      'text/html',
    );

    expect(document.querySelector('a')?.getAttributeNames()).toEqual(['href']);
  });

  it.each([false, true])('keeps currency text intact when LaTeX parsing is %s', (latex) => {
    expect(markdownToHtml('From $5 to $10', { variant: 'full', latex })).toContain(
      'From $5 to $10',
    );
  });

  it('uses the existing currency-safe math tokenizer when enabled', () => {
    expect(markdownToHtml('$x + y$', { variant: 'full', latex: true })).toBe('<p>\\(x + y\\)</p>');
  });

  it('keeps recognizable delimiters around block math', () => {
    expect(markdownToHtml('$$\n\\frac{1}{2}\n$$')).toBe('<p>\\[\\frac{1}{2}\\]</p>');
  });

  it('excludes legacy thinking directives from the rich answer', () => {
    const html = markdownToHtml(':::thinking\nInternal step\n:::\n\nFinal answer');

    expect(html).toContain('Final answer');
    expect(html).not.toContain('Internal step');
  });

  it('keeps single-dollar text literal when LaTeX parsing is disabled', () => {
    expect(markdownToHtml('$x + y$', { variant: 'full', latex: false })).toBe('<p>$x + y$</p>');
  });

  it('renders task list state', () => {
    const html = markdownToHtml('- [x] Done\n- [ ] Pending');

    expect(html).toContain('\u2611 Done');
    expect(html).toContain('\u2610 Pending');
  });

  it('preserves the start of an ordered list', () => {
    expect(markdownToHtml('3. Third\n4. Fourth')).toContain('<ol start="3">');
  });

  it('shows artifact titles without copying hidden implementation content', () => {
    const html = markdownToHtml(':::artifact{title="Report"}\nHidden implementation\n:::');

    expect(html).toContain('Report');
    expect(html).not.toContain('Hidden implementation');
  });

  it('does not interpret directives in the lite renderer', () => {
    const html = markdownToHtml(':::artifact{title="Report"}\nVisible text\n:::', {
      variant: 'lite',
      latex: false,
    });

    expect(html).toContain('Visible text');
    expect(html).toContain(':::');
  });

  it('does not resolve reserved citation labels as Markdown references', () => {
    const html = markdownToHtml('Citation [1].\n\n[1]: https://unrelated.example/', {
      variant: 'full',
      latex: false,
      reserved: new Set(['1']),
    });

    expect(html).toContain('[1]');
    expect(html).not.toContain('<a');
  });

  it('keeps the first Markdown definition for a label', () => {
    const html = markdownToHtml(
      '[Link][same]\n\n[same]: https://first.example/\n[same]: https://second.example/',
    );

    expect(html).toContain('href="https://first.example/"');
    expect(html).not.toContain('href="https://second.example/"');
  });

  it('numbers footnotes by their first appearance', () => {
    const html = markdownToHtml('Second[^b], first[^a].\n\n[^a]: Alpha\n[^b]: Beta');

    expect(html.indexOf('<sup>1</sup><p>Beta')).toBeLessThan(html.indexOf('<sup>2</sup><p>Alpha'));
  });

  it('routes generated files through the application file endpoint', () => {
    const html = markdownToHtml(
      '[Report](https://provider.example/outputs/user-1/file-1/report.txt)',
      { variant: 'full', latex: false, userId: 'user-1' },
    );

    expect(html).toContain(
      'href="http://localhost:3080/api/files/outputs/user-1/file-1/report.txt"',
    );
  });
});
