import { contentProjection } from './snapshots.js';
import type { OutlineNode, WorkspaceRem } from './types.js';

export function nodeContent(node: OutlineNode, base?: WorkspaceRem) {
  if (node.kind === 'opaque' && base) return contentProjection(base);
  return contentProjection({
    text: node.text,
    backText:
      node.kind === 'basic'
        ? node.backText
        : (base?.backText ?? (node.kind === 'multiline' ? [] : null)),
  });
}
