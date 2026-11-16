import type { ListItem, RootContent } from 'mdast';
import { prepareDocument, readonlyReason } from './markdown.js';
import { hash, type WorkspaceRem } from './types.js';

/** Only the named parent's exact new leaves can extend an already sealed graph. */
export function verifyNewChildren(
  before: WorkspaceRem,
  current: WorkspaceRem,
  ids: string[],
  observed: Map<string, WorkspaceRem>
): void {
  const added = new Set(ids);
  if (
    before.feedback ||
    new Set(current.children).size !== current.children.length ||
    hash(current.children.filter((id) => !added.has(id))) !== hash(before.children) ||
    hash([...current.children.filter((id) => added.has(id))].sort()) !== hash([...ids].sort())
  )
    throw new Error(
      'Exact new children must be the complete difference, preserving old child order'
    );
  for (const id of ids) {
    const rem = observed.get(id)!;
    if (
      rem.parent !== before.id ||
      rem.children.length ||
      rem.document !== false ||
      rem.folder !== false ||
      typeof rem.cardItem !== 'boolean' ||
      typeof rem.enablePractice !== 'boolean' ||
      !['forward', 'backward', 'both', 'none'].includes(rem.practice ?? '') ||
      !Array.isArray(rem.tags) ||
      rem.feedback ||
      rem.portal ||
      rem.powerups?.length ||
      Object.values(rem.powerupPresence ?? {}).some(Boolean) ||
      rem.propertyValues?.length ||
      readonlyReason(rem, observed)
    )
      throw new Error(`New child is not a verified supported leaf: ${id}`);
  }
}

function bulletIndex(path: string, source: string) {
  const prepared = prepareDocument(path, source);
  const offset = source.length - prepared.frontmatter.body.length;
  const items = new Map<string, ListItem>();
  function visit(node: RootContent): void {
    if (node.type === 'listItem') {
      const first = node.children[0];
      const last = first?.type === 'paragraph' ? first.children.at(-1) : undefined;
      const anchor = last?.type === 'text' ? /(?:^| )\^([A-Za-z0-9-]+)$/.exec(last.value) : null;
      if (anchor) {
        if (items.has(anchor[1]!)) throw new Error(`Duplicate insertion anchor: ${path}`);
        items.set(anchor[1]!, node);
      }
    }
    if ('children' in node) for (const child of node.children) visit(child as RootContent);
  }
  for (const node of prepared.tree.children) visit(node);
  function position(block: string) {
    const item = items.get(block);
    const start = item?.position?.start,
      end = item?.position?.end;
    if (start?.offset === undefined || end?.offset === undefined)
      throw new Error(`No visible bound bullet for child insertion: ${path}/${block}`);
    const lineStart = offset + start.offset - start.column + 1;
    const indent = source.slice(lineStart, offset + start.offset);
    if (!/^ *$/.test(indent))
      throw new Error(`Unsupported insertion indentation: ${path}/${block}`);
    return { item: item!, start: lineStart, end: offset + end.offset, indent };
  }
  return { position };
}

/** Splice renderer-produced new bullets only; never re-render any existing source byte. */
export function insertBaselineChildren(
  path: string,
  source: string,
  rendered: string,
  parent: { block: string; root: boolean },
  childBlocks: string[],
  addedBlocks: Set<string>
): string {
  const original = bulletIndex(path, source),
    generated = bulletIndex(path, rendered);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const edits: Array<{ start: number; value: string }> = [];
  const oldBlocks = childBlocks.filter((block) => !addedBlocks.has(block));
  function afterLine(end: number): { start: number; prefix: string } {
    const newlineAt = source.indexOf('\n', end);
    if (newlineAt < 0)
      return { start: source.length, prefix: source.endsWith('\n') ? '' : newline };
    if (source.slice(end, newlineAt).trim())
      throw new Error(`Cannot preserve child line suffix: ${path}`);
    return { start: newlineAt + 1, prefix: '' };
  }
  for (let i = 0; i < childBlocks.length;) {
    if (!addedBlocks.has(childBlocks[i]!)) {
      i++;
      continue;
    }
    const run: string[] = [];
    while (i < childBlocks.length && addedBlocks.has(childBlocks[i]!)) run.push(childBlocks[i++]!);
    const following = childBlocks[i];
    let start: number,
      indent: string,
      prefix = '';
    if (following) ({ start, indent } = original.position(following));
    else if (oldBlocks.length) {
      const last = original.position(oldBlocks.at(-1)!);
      ({ start, prefix } = afterLine(last.end));
      indent = last.indent;
    } else if (parent.root) {
      start = source.length;
      indent = '';
      prefix = source.endsWith('\n') ? newline : newline + newline;
    } else {
      const own = original.position(parent.block);
      if (own.item.children.some((node) => node.type === 'list'))
        throw new Error(`Unexpected existing child list: ${path}`);
      ({ start, prefix } = afterLine(own.end));
      const paragraphColumn = own.item.children[0]?.position?.start.column;
      if (paragraphColumn === undefined) throw new Error(`Unknown child indentation: ${path}`);
      indent = ' '.repeat(paragraphColumn - 1);
    }
    const value = run
      .map((block) => {
        const item = generated.position(block);
        const lines = rendered.slice(item.start, item.end).split('\n');
        return lines.map((line) => indent + line.slice(item.indent.length)).join(newline) + newline;
      })
      .join('');
    edits.push({ start, value: prefix + value });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.start);
  return source;
}
