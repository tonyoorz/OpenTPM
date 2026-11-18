import supersub from 'remark-supersub';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { defaultUrlTransform } from 'react-markdown';
import { apiBaseUrl } from 'librechat-data-provider';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { directive } from 'micromark-extension-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';
import type {
  AlignType,
  Definition,
  FootnoteDefinition,
  ListItem,
  Root,
  RootContent,
  Table,
} from 'mdast';
import type { Extension as MicromarkExtension } from 'micromark-util-types';
import { mcpUIResourcePlugin } from '~/components/MCPUIResource/plugin';
import { remarkApproxTilde } from './tilde';
import { singleDollarMath } from './latex';

export type MarkdownVariant = 'full' | 'lite';

export type RichTextMode = {
  variant: MarkdownVariant;
  userId?: string;
  latex: boolean;
  reserved?: ReadonlySet<string>;
};

type SuperSubTransformer = ReturnType<typeof supersub>;

const applySuperSub = supersub() as (
  tree: Root,
  file?: Parameters<SuperSubTransformer>[1],
  next?: Parameters<SuperSubTransformer>[2],
) => void;

type SuperSubNode = {
  type: 'superscript' | 'subscript';
  children: SerializableNode[];
};

type McpResourceNode = {
  type: 'mcp-ui-resource' | 'mcp-ui-carousel';
};

type SerializableNode = RootContent | SuperSubNode | McpResourceNode;

const MONOSPACE = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

/** External clipboard documents have no theme stylesheet, so colors must travel in readable pairs. */
const CODE_COLORS = 'background-color:#f6f8fa;color:#24292f;';
const BORDER = '1px solid #d0d7de';

const STYLES = {
  inlineCode: `font-family:${MONOSPACE};${CODE_COLORS}border-radius:4px;padding:0.15em 0.35em;`,
  codeBlock: `font-family:${MONOSPACE};${CODE_COLORS}border-radius:6px;padding:12px;white-space:pre-wrap;`,
  blockquote: 'margin:0 0 16px;padding:0 1em;border-left:4px solid #d0d7de;',
  table: 'border-collapse:collapse;',
  headerCell: `border:${BORDER};padding:6px 13px;${CODE_COLORS}`,
  cell: `border:${BORDER};padding:6px 13px;`,
} as const;

const EMPTY_RESERVED: ReadonlySet<string> = new Set();
const ARTIFACT_DIRECTIVE = 'artifact';
const ARTIFACT_DEFAULT_TITLE = 'untitled';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

type SerializeContext = {
  userId?: string;
  definitions: Map<string, Definition>;
  footnotes: Map<string, number>;
  reserved: ReadonlySet<string>;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);

const escapeText = (value: string): string => escapeHtml(value).replace(/\n/g, '<br />');

const alignStyle = (align: AlignType | undefined): string =>
  align == null ? '' : `text-align:${align};`;

const taskMarker = (checked: boolean | null | undefined): string => {
  if (checked === true) {
    return '\u2611 ';
  }
  return checked === false ? '\u2610 ' : '';
};

function isAbsoluteUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function resolveUrl(url: string): string {
  const transformed = defaultUrlTransform(url);
  if (transformed.length === 0 || isAbsoluteUrl(transformed)) {
    return transformed;
  }

  try {
    return new URL(transformed, document.baseURI).href;
  } catch {
    return transformed;
  }
}

const artifactTitle = (attributes: Record<string, string | null | undefined> | null | undefined) =>
  `<p>${escapeText(attributes?.title || ARTIFACT_DEFAULT_TITLE)}</p>`;

function generatedFileUrl(url: string, userId: string | undefined): string {
  if (userId == null || userId.length === 0) {
    return url;
  }

  const match = url.match(new RegExp(`(?:files|outputs)/${userId}/([^\\s]+)`));
  const filepath = match?.[0] ?? '';
  if (filepath.length === 0) {
    return url;
  }

  const parts = filepath.split('/');
  const filename = parts.pop() ?? '';
  const fileId = parts.pop() ?? '';
  if (fileId.length === 0 || filename.length === 0) {
    return url;
  }

  const base = `${apiBaseUrl()}/api`;
  return filepath.startsWith('files/') ? `${base}/${filepath}` : `${base}/files/${filepath}`;
}

const anchor = (url: string, children: string, userId: string | undefined): string => {
  const resolved = resolveUrl(generatedFileUrl(url, userId));
  return resolved.length > 0 ? `<a href="${escapeHtml(resolved)}">${children}</a>` : children;
};

const IMAGE_ROOT = '/images/';

const image = (url: string, alt: string): string => {
  const rooted = url.startsWith(IMAGE_ROOT) ? `${apiBaseUrl()}${url}` : url;
  const resolved = resolveUrl(rooted);
  return resolved.length > 0
    ? `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" />`
    : escapeHtml(alt);
};

function collectContext(nodes: readonly SerializableNode[], context: SerializeContext): void {
  for (const node of nodes) {
    if (node.type === 'definition') {
      if (!context.definitions.has(node.identifier)) {
        context.definitions.set(node.identifier, node);
      }
      continue;
    }
    if (node.type === 'footnoteReference' && !context.footnotes.has(node.identifier)) {
      context.footnotes.set(node.identifier, context.footnotes.size + 1);
    }
    if ('children' in node) {
      collectContext(node.children, context);
    }
  }
}

type Reference = {
  identifier: string;
  label?: string | null;
  referenceType: 'shortcut' | 'collapsed' | 'full';
};

const resolveReference = (node: Reference, context: SerializeContext): Definition | undefined =>
  context.reserved.has(node.identifier) ? undefined : context.definitions.get(node.identifier);

function revertReference(node: Reference, inner: string, prefix: string): string {
  if (node.referenceType === 'full') {
    return `${prefix}[${inner}][${escapeText(node.label ?? node.identifier)}]`;
  }
  if (node.referenceType === 'collapsed') {
    return `${prefix}[${inner}][]`;
  }
  return `${prefix}[${inner}]`;
}

function serializeTable(node: Table, context: SerializeContext): string {
  const align = node.align ?? [];
  const [headerRow, ...bodyRows] = node.children;

  const cells = (row: (typeof node.children)[number], tag: 'th' | 'td', style: string): string => {
    let html = '';
    for (let index = 0; index < row.children.length; index++) {
      const cell = row.children[index];
      html += `<${tag} style="${style}${alignStyle(align[index])}">${serializeChildren(
        cell.children,
        context,
      )}</${tag}>`;
    }
    return `<tr>${html}</tr>`;
  };

  const head = headerRow ? `<thead>${cells(headerRow, 'th', STYLES.headerCell)}</thead>` : '';
  let body = '';
  for (const row of bodyRows) {
    body += cells(row, 'td', STYLES.cell);
  }

  return `<table style="${STYLES.table}">${head}${body && `<tbody>${body}</tbody>`}</table>`;
}

function serializeNode(node: SerializableNode, context: SerializeContext): string {
  switch (node.type) {
    case 'text':
    case 'html':
      return escapeText(node.value);
    case 'paragraph':
      return `<p>${serializeChildren(node.children, context)}</p>`;
    case 'heading':
      return `<h${node.depth}>${serializeChildren(node.children, context)}</h${node.depth}>`;
    case 'strong':
      return `<strong>${serializeChildren(node.children, context)}</strong>`;
    case 'emphasis':
      return `<em>${serializeChildren(node.children, context)}</em>`;
    case 'delete':
      return `<s>${serializeChildren(node.children, context)}</s>`;
    case 'superscript':
      return `<sup>${serializeChildren(node.children, context)}</sup>`;
    case 'subscript':
      return `<sub>${serializeChildren(node.children, context)}</sub>`;
    case 'inlineCode':
      return `<code style="${STYLES.inlineCode}">${escapeHtml(node.value)}</code>`;
    case 'code':
      return `<pre style="${STYLES.codeBlock}"><code>${escapeHtml(node.value)}</code></pre>`;
    case 'blockquote':
      return `<blockquote style="${STYLES.blockquote}">${serializeChildren(
        node.children,
        context,
      )}</blockquote>`;
    case 'list': {
      const tag = node.ordered === true ? 'ol' : 'ul';
      const start = node.ordered === true && node.start != null && node.start !== 1;
      let items = '';
      for (const item of node.children) {
        items += serializeListItem(item, context, node.spread === true);
      }
      return `<${tag}${start ? ` start="${node.start}"` : ''}>${items}</${tag}>`;
    }
    case 'listItem':
      return serializeListItem(node, context, false);
    case 'table':
      return serializeTable(node, context);
    case 'link':
      return anchor(node.url, serializeChildren(node.children, context), context.userId);
    case 'image':
      return image(node.url, node.alt ?? '');
    case 'linkReference': {
      const children = serializeChildren(node.children, context);
      const definition = resolveReference(node, context);
      return definition
        ? anchor(definition.url, children, context.userId)
        : revertReference(node, children, '');
    }
    case 'imageReference': {
      const alt = node.alt ?? '';
      const definition = resolveReference(node, context);
      return definition ? image(definition.url, alt) : revertReference(node, escapeText(alt), '!');
    }
    case 'thematicBreak':
      return '<hr />';
    case 'break':
      return '<br />';
    case 'inlineMath':
      return `\\(${escapeText(node.value)}\\)`;
    case 'math':
      return `<p>\\[${escapeText(node.value)}\\]</p>`;
    case 'footnoteReference':
      return `<sup>${context.footnotes.get(node.identifier) ?? ''}</sup>`;
    case 'footnoteDefinition': {
      const number = context.footnotes.get(node.identifier);
      if (number == null) {
        return '';
      }
      return `<div><sup>${number}</sup>${serializeChildren(node.children, context)}</div>`;
    }
    case 'textDirective':
      return escapeText(`:${node.name}`);
    case 'containerDirective':
    case 'leafDirective':
      if (node.name === 'thinking') {
        return '';
      }
      return node.name === ARTIFACT_DIRECTIVE
        ? artifactTitle(node.attributes)
        : serializeChildren(node.children, context);
    case 'definition':
    case 'mcp-ui-resource':
    case 'mcp-ui-carousel':
      return '';
    default:
      return 'children' in node ? serializeChildren(node.children, context) : '';
  }
}

function serializeListItem(node: ListItem, context: SerializeContext, loose: boolean): string {
  const [firstChild] = node.children;
  const tight = !loose && node.spread !== true && firstChild?.type === 'paragraph';
  const children = tight
    ? serializeChildren(firstChild.children, context) +
      serializeChildren(node.children.slice(1), context)
    : serializeChildren(node.children, context);
  return `<li>${taskMarker(node.checked)}${children}</li>`;
}

function serializeChildren(nodes: readonly SerializableNode[], context: SerializeContext): string {
  let html = '';
  for (const node of nodes) {
    html += serializeNode(node, context);
  }
  return html;
}

/** Render clipboard HTML using the message renderer's parsing rules, without activating raw HTML. */
export function markdownToHtml(
  markdown: string,
  mode: RichTextMode = { variant: 'full', latex: false },
): string {
  const extensions: MicromarkExtension[] = [gfm(), math({ singleDollarTextMath: false })];
  if (mode.latex) {
    extensions.push(singleDollarMath);
  }
  if (mode.variant === 'full') {
    extensions.push(directive());
  }

  const tree = fromMarkdown(markdown, {
    extensions,
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown(), mathFromMarkdown()],
  });

  remarkApproxTilde()(tree);
  applySuperSub(tree);
  if (mode.variant === 'full') {
    mcpUIResourcePlugin()(tree);
  }

  const children = tree.children as SerializableNode[];
  const context: SerializeContext = {
    userId: mode.userId,
    definitions: new Map(),
    footnotes: new Map(),
    reserved: mode.reserved ?? EMPTY_RESERVED,
  };
  collectContext(children, context);

  const blocks: string[] = [];
  const notes: FootnoteDefinition[] = [];
  for (const node of children) {
    if (node.type === 'footnoteDefinition') {
      notes.push(node);
      continue;
    }
    blocks.push(serializeNode(node, context));
  }

  notes.sort(
    (first, second) =>
      (context.footnotes.get(first.identifier) ?? 0) -
      (context.footnotes.get(second.identifier) ?? 0),
  );
  for (const note of notes) {
    blocks.push(serializeNode(note, context));
  }

  return blocks.filter((block) => block.length > 0).join('\n');
}
