import { isSeq, parseDocument as parseYaml } from 'yaml';
import { insertBaselineTags } from './baseline-tags.js';
import { prepareDocument } from './markdown.js';
import { hash } from './types.js';

/** Whole-body adoption does not authorize discarding local YAML comments or display attributes. */
export function preserveSourceHeader(
  path: string,
  source: string,
  rendered: string,
  tags: string[]
): string {
  const original = prepareDocument(path, source).frontmatter;
  const before = original.attributes?.tags ?? [];
  if (hash([...before].sort()) !== hash([...tags].sort())) {
    if (!before.length) source = insertBaselineTags(path, source, tags, new Map());
    else {
      const bom = source.startsWith('\uFEFF') ? 1 : 0;
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.slice(bom));
      if (!header) throw new Error('Cannot locate existing source tags');
      const yaml = header[1]!;
      const document = parseYaml(yaml);
      const value = document.get('tags', true);
      if (document.errors.length || !isSeq(value) || !value.range)
        throw new Error('Cannot preserve source tag attributes');
      const offset = bom + 3 + (header[0].startsWith('---\r\n') ? 2 : 1);
      const [start, end] = value.range;
      const previous = yaml.slice(start, end);
      if (previous.includes('#'))
        throw new Error('Cannot replace source tags without losing internal comments');
      const ending = /\r?\n$/.exec(previous)?.[0] ?? '';
      source =
        source.slice(0, offset + start) +
        JSON.stringify(tags) +
        ending +
        source.slice(offset + end);
    }
  }
  const header = prepareDocument(path, source).frontmatter;
  const body = prepareDocument(path, rendered).frontmatter.body;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return source.slice(0, source.length - header.body.length) + body.replace(/\r?\n/g, newline);
}
