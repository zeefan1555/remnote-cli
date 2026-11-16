import type { RootContent } from 'mdast';
import { isSeq, parseDocument as parseYaml } from 'yaml';
import { prepareDocument } from './markdown.js';

/** Insert only missing tag tokens. All unrelated source bytes, including comments, stay intact. */
export function insertBaselineTags(
  path: string,
  source: string,
  rootTags: string[],
  blockTags: Map<string, string[]>
): string {
  const prepared = prepareDocument(path, source);
  const bodyOffset = source.length - prepared.frontmatter.body.length;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const found = new Set<string>();
  function visit(node: RootContent): void {
    if (node.type === 'listItem') {
      const first = node.children[0];
      const last = first?.type === 'paragraph' ? first.children.at(-1) : undefined;
      const anchor = last?.type === 'text' ? /(?:^| )\^([A-Za-z0-9-]+)$/.exec(last.value) : null;
      const tags = anchor && blockTags.get(anchor[1]!);
      if (anchor && tags?.length) {
        const block = anchor[1]!;
        const end = last?.position?.end.offset;
        if (found.has(block) || end === undefined)
          throw new Error(`Cannot locate one lossless tag insertion: ${path}/${block}`);
        const start = bodyOffset + end - block.length - 1;
        if (source.slice(start, bodyOffset + end) !== `^${block}`)
          throw new Error(`Cannot preserve escaped anchor bytes: ${path}/${block}`);
        edits.push({ start, end: start, value: tags.map((tag) => `#${tag} `).join('') });
        found.add(block);
      }
    }
    if ('children' in node) for (const child of node.children) visit(child as RootContent);
  }
  for (const node of prepared.tree.children) visit(node);
  for (const [block, tags] of blockTags)
    if (tags.length && !found.has(block))
      throw new Error(`No visible bound bullet for tag insertion: ${path}/${block}`);
  if (rootTags.length) {
    const bom = source.startsWith('\uFEFF') ? 1 : 0;
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.slice(bom));
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const value = JSON.stringify(rootTags);
    if (!header) {
      edits.push({
        start: bom,
        end: bom,
        value: `---${newline}tags: ${value}${newline}---${newline}`,
      });
    } else {
      const yaml = header[1]!;
      const yamlOffset = bom + 3 + (header[0]!.startsWith('---\r\n') ? 2 : 1);
      const document = parseYaml(yaml);
      if (document.errors.length) throw new Error(`Invalid YAML tag insertion: ${path}`);
      const tags = document.get('tags', true);
      if (tags !== undefined) {
        if (!isSeq(tags) || tags.items.length || !tags.range)
          throw new Error(`Refusing to replace existing root tags: ${path}`);
        const [start, end] = tags.range;
        if (yaml.slice(start, end).includes('#'))
          throw new Error(`Cannot losslessly replace commented empty root tags: ${path}`);
        edits.push({ start: yamlOffset + start, end: yamlOffset + end, value });
      } else {
        const start = yamlOffset + yaml.length;
        edits.push({ start, end: start, value: `${newline}tags: ${value}` });
      }
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}
