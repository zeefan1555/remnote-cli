import type { Literal } from 'mdast';
import type { Extension as MdastExtension } from 'mdast-util-from-markdown';
import type { Options as MarkdownOptions } from 'mdast-util-to-markdown';
import type { Extension, State, Tokenizer } from 'micromark-util-types';
import { tagTokenSchema } from './tags.js';

interface ObsidianTag extends Literal {
  type: 'obsidianTag';
  value: string;
}
declare module 'mdast' {
  interface PhrasingContentMap {
    obsidianTag: ObsidianTag;
  }
  interface RootContentMap {
    obsidianTag: ObsidianTag;
  }
}
declare module 'micromark-util-types' {
  interface TokenTypeMap {
    workspaceTag: 'workspaceTag';
  }
}

const tokenize: Tokenizer = function (effects, ok, nok) {
  let value = '';
  const previous = this.previous;
  if (
    previous !== null &&
    previous >= 0 &&
    /[\p{L}\p{M}\p{N}_/\\#:-]/u.test(String.fromCodePoint(previous))
  )
    return nok;
  const inside: State = (code) => {
    if (code !== null && code >= 0 && /[\p{L}\p{M}\p{N}_/-]/u.test(String.fromCodePoint(code))) {
      value += String.fromCodePoint(code);
      effects.consume(code);
      return inside;
    }
    if (!tagTokenSchema.safeParse(value).success) return nok(code);
    effects.exit('workspaceTag');
    return ok(code);
  };
  return (code) => {
    effects.enter('workspaceTag');
    effects.consume(code);
    return inside;
  };
};
export const tagSyntax: Extension = { text: { 35: { name: 'workspaceTag', tokenize } } };
export const tagFromMarkdown: MdastExtension = {
  enter: {
    workspaceTag(token) {
      this.enter({ type: 'obsidianTag', value: this.sliceSerialize(token).slice(1) }, token);
    },
  },
  exit: {
    workspaceTag(token) {
      this.exit(token);
    },
  },
};
export const tagToMarkdown: MarkdownOptions = {
  unsafe: [{ character: '#', inConstruct: 'phrasing' }],
  handlers: { obsidianTag: (node) => `#${node.value}` },
};
