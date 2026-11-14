import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { RootContent, PhrasingContent, List, ListItem, Paragraph, Heading } from 'mdast';
import { idSchema, nativeBlockId, originalPath, recordPath } from './identity.js';
import { WorkspaceLinks } from './links.js';
import { wikiFromMarkdown, wikiSyntax, wikiToMarkdown } from './wiki-markdown.js';
import {
  nativeDetailsSchema,
  parseFrontmatter,
  renderFrontmatter,
  type NativeMetadata,
  type WorkspaceMetadata,
} from './metadata.js';
import {
  hash,
  type Diagnostic,
  type OutlineNode,
  type ParsedDocument,
  type WorkspaceRem,
} from './types.js';

export { idSchema } from './identity.js';
const MARKDOWN_OPTIONS = {
  bullet: '-' as const,
  emphasis: '*' as const,
  strong: '*' as const,
  extensions: [wikiToMarkdown],
};
const PARSE_OPTIONS = { extensions: [wikiSyntax], mdastExtensions: [wikiFromMarkdown] };

function inline(
  value: unknown,
  links?: WorkspaceLinks,
  byId?: Map<string, WorkspaceRem>
): PhrasingContent[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('rich-text-shape');
  return value.flatMap((part): PhrasingContent[] => {
    if (typeof part === 'string') return [{ type: 'text', value: part }];
    if (!part || typeof part !== 'object') throw new Error('rich-text-value');
    const p = part as Record<string, unknown>;
    if (
      p.i === 'q' &&
      Object.keys(p).every((key) => ['i', '_id'].includes(key)) &&
      typeof p._id === 'string'
    ) {
      idSchema.parse(p._id);
      return [
        {
          type: 'html',
          value: links?.render(p._id, byId?.has(p._id) ? titleOf(byId.get(p._id)!) : p._id) ?? '',
        },
      ];
    }
    if (
      p.i !== 'm' ||
      typeof p.text !== 'string' ||
      Object.keys(p).some((key) => !['i', 'text', 'b', 'l', 'q'].includes(key))
    )
      throw new Error('rich-text-formatting');
    if (['b', 'l', 'q'].some((key) => p[key] !== undefined && typeof p[key] !== 'boolean'))
      throw new Error('rich-text-formatting');
    let node: PhrasingContent = p.q
      ? { type: 'inlineCode', value: p.text }
      : { type: 'text', value: p.text };
    if (p.l) node = { type: 'emphasis', children: [node] };
    if (p.b) node = { type: 'strong', children: [node] };
    return [node];
  });
}

function block(
  value: unknown,
  links?: WorkspaceLinks,
  byId?: Map<string, WorkspaceRem>
): RootContent {
  if (Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === 'object') {
    const p = value[0] as Record<string, unknown>;
    if (
      p.i === 'm' &&
      p.code === true &&
      typeof p.text === 'string' &&
      (p.language === undefined ||
        (typeof p.language === 'string' && /^[\w+-]*$/.test(p.language))) &&
      Object.keys(p).every((key) => ['i', 'text', 'code', 'language'].includes(key))
    )
      return {
        type: 'code',
        lang: typeof p.language === 'string' ? p.language : undefined,
        value: p.text,
      };
  }
  return { type: 'paragraph', children: inline(value, links, byId) };
}

export function readonlyReason(
  rem: WorkspaceRem,
  byId: Map<string, WorkspaceRem>
): string | undefined {
  if (rem.unsupported) return rem.unsupported;
  if (
    [rem.document, rem.folder, rem.cardItem, rem.practice, rem.enablePractice].some(
      (value) => value === null
    )
  )
    return 'unverified-native-flags';
  if (rem.type === 6) return 'portal';
  if (typeof rem.type === 'string' || ![null, 1, 2].includes(rem.type)) return 'native-type';
  try {
    const front = block(rem.text),
      back = inline(rem.backText);
    if (
      !rem.cardItem &&
      Array.isArray(rem.backText) &&
      !back.length &&
      rem.children.length &&
      rem.practice === 'forward'
    ) {
      if (
        front.type !== 'paragraph' ||
        rem.children.some(
          (id) => !byId.has(id) || byId.get(id)!.children.length || byId.get(id)!.cardItem !== true
        )
      )
        return 'multiline-shape';
    } else if (back.length) {
      if (front.type !== 'paragraph' || rem.cardItem || rem.children.length) return 'basic-shape';
    } else if (Array.isArray(rem.backText)) return 'empty-card-shape';
    if ((rem.document || rem.folder || rem.parent === null) && front.type === 'code')
      return 'root-code';
  } catch (error) {
    return error instanceof Error ? error.message : 'rich-text';
  }
  return undefined;
}

export function nodeKind(rem: WorkspaceRem, byId: Map<string, WorkspaceRem>): OutlineNode['kind'] {
  if (readonlyReason(rem, byId)) return 'opaque';
  if (Array.isArray(rem.backText)) return rem.backText.length ? 'basic' : 'multiline';
  return 'text';
}

export function titleOf(rem: WorkspaceRem): string {
  const value = Array.isArray(rem.text)
    ? rem.text
        .map((part) =>
          typeof part === 'string'
            ? part
            : part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
              ? part.text
              : ''
        )
        .join('')
    : '';
  return value.trim() || 'Untitled';
}

export function pathSegment(rem: WorkspaceRem): string {
  return (
    titleOf(rem)
      .normalize('NFC')
      .replace(/[<>:"/\\|?*#^%[\]\p{Cc}]/gu, '_')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 60) || 'Untitled'
  );
}

export function nativeMetadata(rem: WorkspaceRem): NativeMetadata {
  const facts = { ...rem.facts };
  for (const field of ['createdAt', 'localUpdatedAt', 'updatedAt'] as const) {
    const value = rem.public?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) facts[field] = value;
  }
  const core = {
    type: rem.type,
    parent: rem.parent,
    children: [...rem.children],
    isDocument: rem.document,
    isFolder: rem.folder,
    isCardItem: rem.cardItem,
    practiceDirection: rem.practice,
    enablePractice: rem.enablePractice,
    tags: rem.tags ?? null,
    references: rem.references ?? null,
    powerups: rem.powerups ?? null,
    propertyValues: rem.propertyValues ?? null,
    portal: rem.portal ?? null,
    cards: rem.cards ?? null,
  };
  const collected = new Set([
    'type',
    'parent',
    'children',
    ...Object.entries(core)
      .filter(([, value]) => value !== null)
      .map(([key]) => key),
    ...Object.keys(facts),
    ...(rem.collected ?? []),
  ]);
  return {
    ...core,
    ...nativeDetailsSchema.parse(facts),
    collected: [...collected].sort(),
  };
}

export interface RenderOptions {
  blocks?: Map<string, string>;
  display?: Pick<WorkspaceMetadata, 'title' | 'aliases' | 'tags'>;
  originalIds?: Set<string>;
  links?: WorkspaceLinks;
}

export function documentMetadata(
  rootId: string,
  byId: Map<string, WorkspaceRem>,
  documents: Map<string, string>,
  options: RenderOptions = {}
): WorkspaceMetadata {
  const metadata: WorkspaceMetadata = {
    schema: 'remnote-sync/1',
    root: rootId,
    aliases: [],
    tags: [],
    ...options.display,
    rems: {},
  };
  function visit(id: string): void {
    const rem = byId.get(id);
    if (!rem) throw new Error(`Missing native Rem ${id}`);
    const kind = nodeKind(rem, byId);
    metadata.rems[id] = {
      id,
      block: options.blocks?.get(id) ?? nativeBlockId(id),
      content: kind === 'opaque' ? 'readonly' : (kind as 'text' | 'basic' | 'multiline'),
      native: nativeMetadata(rem),
      readOnly: {
        record: recordPath(id),
        public: rem.public ? originalPath('public', id) : null,
        original: options.originalIds?.has(id) ? originalPath('rems', id) : null,
      },
    };
    for (const child of rem.children) if (!documents.has(child)) visit(child);
  }
  visit(rootId);
  return metadata;
}

/** Safe, deliberately read-only display. Rich originals and all unknown fields remain in private sidecars. */
function readonlyInline(
  value: unknown,
  links: WorkspaceLinks,
  byId: Map<string, WorkspaceRem>
): PhrasingContent[] {
  if (!Array.isArray(value))
    return [{ type: 'text', value: value == null ? '' : '[Unsupported value]' }];
  return value.flatMap((part): PhrasingContent[] => {
    if (typeof part === 'string') return [{ type: 'text', value: part }];
    if (!part || typeof part !== 'object') return [{ type: 'text', value: '[Unsupported value]' }];
    const p = part as Record<string, unknown>;
    if (p.i === 'q' && typeof p._id === 'string' && idSchema.safeParse(p._id).success)
      return [
        {
          type: 'html',
          value: links.render(p._id, byId.has(p._id) ? titleOf(byId.get(p._id)!) : p._id),
        },
      ];
    if (p.i === 'i' && typeof p.url === 'string' && /^https?:\/\//i.test(p.url))
      return [
        { type: 'image', url: p.url, alt: typeof p.title === 'string' ? p.title : 'RemNote image' },
      ];
    if (typeof p.text === 'string') return [{ type: 'text', value: p.text }];
    if (typeof p.url === 'string' && /^https?:\/\//i.test(p.url))
      return [
        {
          type: 'link',
          url: p.url,
          children: [{ type: 'text', value: `[${String(p.i ?? 'media')}]` }],
        },
      ];
    return [{ type: 'text', value: `[Native ${String(p.i ?? 'object')}; original retained]` }];
  });
}

export function renderDocument(
  rootId: string,
  path: string,
  byId: Map<string, WorkspaceRem>,
  documents: Map<string, string>,
  options: RenderOptions = {}
): string {
  const root = byId.get(rootId)!;
  const metadata = documentMetadata(rootId, byId, documents, options);
  const links =
    options.links ??
    new WorkspaceLinks(
      [...documents].map(([id, file]) => ({
        path: file,
        title: titleOf(byId.get(id)!),
        metadata: id === rootId ? metadata : documentMetadata(id, byId, documents, options),
      }))
    );
  function ownContent(rem: WorkspaceRem, heading = false): RootContent[] {
    const kind = nodeKind(rem, byId),
      anchor = metadata.rems[rem.id]!.block;
    let front: RootContent =
      kind === 'opaque'
        ? { type: 'paragraph', children: readonlyInline(rem.text, links, byId) }
        : block(rem.text, links, byId);
    const extra: RootContent[] = [];
    if (front.type === 'code') {
      extra.push(front);
      front = { type: 'paragraph', children: [] };
    }
    if (front.type !== 'paragraph') throw new Error('Invalid native front block');
    if (kind === 'opaque') {
      if (!front.children.length)
        front.children.push({ type: 'text', value: rem.type === 6 ? 'Portal' : 'Untitled' });
      extra.push({
        type: 'paragraph',
        children: [
          {
            type: 'text',
            value: `Read only: ${readonlyReason(rem, byId)}. Original retained in ${recordPath(rem.id)}.`,
          },
        ],
      });
      if (Array.isArray(rem.backText) && rem.backText.length)
        extra.push({
          type: 'blockquote',
          children: [{ type: 'paragraph', children: readonlyInline(rem.backText, links, byId) }],
        });
      if (rem.type === 6) {
        const targets = rem.portal?.directlyIncludedRemIds;
        extra.push({
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: targets
                ? 'Portal directly included targets (links, not Obsidian transclusion): '
                : 'Portal membership is unverified; no inferred targets.',
            },
            ...(targets ?? []).flatMap((id, index): PhrasingContent[] => [
              ...(index ? [{ type: 'text' as const, value: ', ' }] : []),
              { type: 'html', value: links.render(id, byId.has(id) ? titleOf(byId.get(id)!) : id) },
            ]),
          ],
        });
      }
    } else if (kind === 'basic')
      extra.push({
        type: 'blockquote',
        children: [{ type: 'paragraph', children: inline(rem.backText, links, byId) }],
      });
    if (!heading)
      front.children.push({ type: 'text', value: `${front.children.length ? ' ' : ''}^${anchor}` });
    return [
      {
        type: heading ? 'heading' : 'paragraph',
        ...(heading ? { depth: 1 as const } : {}),
        children: front.children,
      } as Heading | Paragraph,
      ...extra,
    ];
  }
  function list(ids: string[]): List {
    return {
      type: 'list',
      ordered: false,
      spread: false,
      children: ids.map((id): ListItem => {
        const rem = byId.get(id);
        if (!rem) throw new Error(`Missing child ${id}`);
        if (documents.has(id))
          return {
            type: 'listItem',
            spread: false,
            children: [
              {
                type: 'paragraph',
                children: [{ type: 'html', value: links.render(id, titleOf(rem)) }],
              },
            ],
          };
        const children = ownContent(rem);
        if (rem.children.length) children.push(list(rem.children));
        return { type: 'listItem', spread: false, children: children as ListItem['children'] };
      }),
    };
  }
  const children = ownContent(root, true);
  if (root.children.length) children.push(list(root.children));
  return renderFrontmatter(metadata) + toMarkdown({ type: 'root', children }, MARKDOWN_OPTIONS);
}

/** Semantic rich-text representation ignores segmentation and false formatting flags. */
export function normalizeRichText(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? null;
  const result: unknown[] = [];
  for (let part of value) {
    if (part && typeof part === 'object' && part.i === 'm') {
      part = Object.fromEntries(Object.entries(part).filter(([, value]) => value !== false));
      if (Object.keys(part).every((key) => ['i', 'text'].includes(key))) part = part.text;
    }
    if (part === '') continue;
    const last = result.at(-1);
    if (typeof part === 'string' && typeof last === 'string')
      result[result.length - 1] = last + part;
    else result.push(part);
  }
  return result;
}

export function markdownHeadingTitle(body: string): string {
  const first = fromMarkdown(body, PARSE_OPTIONS).children[0];
  function plain(nodes: PhrasingContent[]): string {
    return nodes
      .map((node) =>
        node.type === 'wikiLink'
          ? (node.alias ?? node.target ?? '')
          : 'children' in node
            ? plain(node.children)
            : 'value' in node
              ? node.value
              : ''
      )
      .join('');
  }
  return first?.type === 'heading' && first.depth === 1 ? plain(first.children) : '';
}

export function parseDocument(
  path: string,
  source: string,
  suppliedLinks?: WorkspaceLinks
): { document: ParsedDocument; diagnostics: Diagnostic[] } {
  const frontmatter = parseFrontmatter(path, source),
    diagnostics = [...frontmatter.diagnostics];
  const result: ParsedDocument = {
    path,
    fileHash: hash(source),
    metadata: frontmatter.metadata,
    nodes: [],
    references: [],
  };
  const metadata = frontmatter.metadata;
  if (!metadata) return { document: result, diagnostics };
  const body = frontmatter.body,
    tree = fromMarkdown(body, PARSE_OPTIONS);
  const title = markdownHeadingTitle(body);
  const links = suppliedLinks ?? new WorkspaceLinks([{ path, title, metadata }]);
  const entriesByBlock = new Map(
    Object.entries(metadata.rems).map(([key, entry]) => [entry.block, { key, entry }])
  );
  const seen = new Set<string>();
  const fail = (line: number, code: string, message: string) =>
    diagnostics.push({ path, line, code, message });
  const atLine = (node?: RootContent | PhrasingContent) =>
    (node?.position?.start.line ?? 1) + frontmatter.bodyLine - 1;
  const reference = (target: string, line: number): unknown[] => {
    try {
      const resolved = links.resolve(path, target);
      if (resolved.id.startsWith('new:'))
        throw new Error('Links to unpublished local keys require an existing native target');
      result.references.push({ id: resolved.id, line });
      return [{ i: 'q', _id: resolved.id }];
    } catch (error) {
      fail(line, 'WIKI_LINK', error instanceof Error ? error.message : String(error));
      return [];
    }
  };
  function readInline(nodes: PhrasingContent[], style: { b?: true; l?: true } = {}): unknown[] {
    const rich = nodes.flatMap((node): unknown[] => {
      const line = atLine(node);
      if (node.type === 'strong') return readInline(node.children, { ...style, b: true });
      if (node.type === 'emphasis') return readInline(node.children, { ...style, l: true });
      if (node.type === 'inlineCode') return [{ i: 'm', text: node.value, ...style, q: true }];
      if (node.type === 'text')
        return node.value
          ? [Object.keys(style).length ? { i: 'm', text: node.value, ...style } : node.value]
          : [];
      if (node.type === 'wikiLink') {
        if (node.embed)
          fail(
            line,
            'UNSUPPORTED_EMBED',
            'New Obsidian embeds are not native references or Portals'
          );
        else if (Object.keys(style).length)
          fail(line, 'WIKI_LINK', 'Formatted reference wrappers are unsupported');
        else if (node.target === null) fail(line, 'WIKI_LINK', 'Malformed or unmodeled Wiki link');
        else return reference(node.target, line);
        return [];
      }
      if (
        node.type === 'link' &&
        node.url.startsWith('remnote:') &&
        !node.title &&
        !Object.keys(style).length
      ) {
        const id = node.url.slice('remnote:'.length);
        if (idSchema.safeParse(id).success) {
          result.references.push({ id, line });
          return [{ i: 'q', _id: id }];
        }
      }
      fail(
        line,
        'UNSUPPORTED_MARKDOWN',
        `Unsupported ${node.type}; keep native complex content read only`
      );
      return [];
    });
    return normalizeRichText(rich) as unknown[];
  }
  function content(
    blocks: RootContent[],
    parent: string | null,
    heading = false
  ): OutlineNode | undefined {
    const first = blocks[0],
      line = atLine(first);
    if (
      !first ||
      (first.type !== 'paragraph' && first.type !== 'heading') ||
      (heading && (first.type !== 'heading' || first.depth !== 1))
    ) {
      fail(line, 'STRUCTURE', 'Require one H1 followed by unordered outline items');
      return;
    }
    const children = structuredClone(first.children),
      last = children.at(-1);
    const anchor =
      !heading && last?.type === 'text' ? /(?:^| )\^([A-Za-z0-9-]+)$/.exec(last.value) : null;
    let key: string, blockId: string, kind: OutlineNode['kind'];
    if (heading) {
      key = metadata!.root;
      blockId = metadata!.rems[key]!.block;
      const content = metadata!.rems[key]!.content;
      kind = content === 'readonly' ? 'opaque' : content;
    } else if (anchor && last?.type === 'text') {
      const target = entriesByBlock.get(anchor[1]!);
      if (!target) {
        fail(line, 'BLOCK_BINDING', 'Block has no corresponding YAML Rem entry');
        return;
      }
      key = target.key;
      blockId = target.entry.block;
      kind = target.entry.content === 'readonly' ? 'opaque' : target.entry.content;
      last.value = last.value.slice(0, -anchor[0].length);
      if (!last.value) children.pop();
    } else {
      const mount = first.children.length === 1 ? first.children[0] : undefined;
      try {
        const target =
          mount?.type === 'wikiLink' && mount.target && !mount.embed
            ? links.resolve(path, mount.target)
            : undefined;
        if (!target?.root || target.path === path)
          throw new Error('Missing stable ^block-id at the end of the item');
        key = target.id;
        blockId = target.block;
        kind = 'mount';
      } catch (error) {
        fail(line, 'BLOCK_BINDING', error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (kind !== 'mount') {
      if (seen.has(key)) fail(line, 'DUPLICATE_ID', 'Every real Rem must occur exactly once');
      seen.add(key);
    }
    const extra = blocks.slice(1).filter((node) => node.type !== 'list');
    let text: unknown[] = [],
      backText: unknown[] = [];
    if (kind !== 'opaque' && kind !== 'mount') {
      if (
        extra.length === 1 &&
        extra[0]?.type === 'code' &&
        !children.length &&
        kind === 'text' &&
        !heading &&
        !extra[0].meta &&
        /^[\w+-]*$/.test(extra[0].lang ?? '')
      )
        text = [
          {
            i: 'm',
            code: true,
            ...(extra[0].lang ? { language: extra[0].lang } : {}),
            text: extra[0].value,
          },
        ];
      else {
        text = readInline(children);
        if (
          kind === 'basic' &&
          extra.length === 1 &&
          extra[0]?.type === 'blockquote' &&
          extra[0].children.length === 1 &&
          extra[0].children[0]?.type === 'paragraph'
        )
          backText = readInline(extra[0].children[0].children);
        else if (extra.length || kind === 'basic')
          fail(
            line,
            'STRUCTURE',
            'A Rem is one paragraph, one fenced code block, or an existing basic front plus blockquote back'
          );
      }
      if ((kind === 'multiline' || kind === 'basic' || key.startsWith('new:')) && !text.length)
        fail(line, 'EMPTY_QUESTION', 'New notes and card questions cannot be empty');
      if (kind === 'basic' && !backText.length)
        fail(line, 'EMPTY_ANSWER', 'Basic card answer cannot be empty');
    }
    const own = blocks.filter((node) => node.type !== 'list');
    const node: OutlineNode = {
      key,
      blockId,
      parent,
      line,
      kind,
      text,
      backText,
      children: [],
      contentHash:
        kind === 'mount'
          ? hash({ mount: key })
          : hash(toMarkdown({ type: 'root', children: own }, MARKDOWN_OPTIONS)),
    };
    result.nodes.push(node);
    for (const list of blocks.filter((node): node is List => node.type === 'list')) {
      if (list.ordered)
        fail(atLine(list), 'STRUCTURE', 'Only unordered outline lists are supported');
      for (const child of list.children) {
        if (child.checked != null)
          fail(
            atLine(list),
            'UNSUPPORTED_MARKDOWN',
            'Task checkboxes are not modeled native properties'
          );
        const parsed = content(child.children, key);
        if (parsed) node.children.push(parsed.key);
      }
    }
    if (kind === 'multiline' && !node.children.length)
      fail(line, 'EMPTY_ANSWER', 'Multiline card requires answer children');
    if ((kind === 'mount' || kind === 'basic') && node.children.length)
      fail(line, 'NESTING', 'Mounts and basic cards cannot acquire children');
    return node;
  }
  const [first, ...rest] = tree.children;
  content(first ? [first, ...rest] : [], null, true);
  for (const key of Object.keys(metadata.rems))
    if (!seen.has(key)) fail(1, 'YAML_NODE_MISSING', `YAML entry ${key} has no real body node`);
  return { document: result, diagnostics };
}
