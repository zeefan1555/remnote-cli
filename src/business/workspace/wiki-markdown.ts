import type { Literal } from 'mdast';
import type { Extension as MdastExtension } from 'mdast-util-from-markdown';
import type { Options as MarkdownOptions } from 'mdast-util-to-markdown';
import type { Extension, State, Tokenizer } from 'micromark-util-types';

interface WikiLink extends Literal {
  type: 'wikiLink';
  /** Exact single-line token, including its markers; Markdown inside an alias is literal. */
  value: string;
  target: string | null;
  alias: string | null;
  embed: boolean;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLink;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    workspaceWiki: 'workspaceWiki';
  }
}

/** Tokenize before emphasis/code/html. CommonMark still owns escaping and code contexts. */
const tokenize: Tokenizer = function (effects, ok, nok) {
  let closing = false;
  const start: State = (code) => {
    effects.enter('workspaceWiki');
    if (code === 33) {
      effects.consume(code);
      return firstBracket;
    }
    return firstBracket(code);
  };
  const firstBracket: State = (code) => {
    if (code !== 91) return nok(code);
    effects.consume(code);
    return secondBracket;
  };
  const secondBracket: State = (code) => {
    if (code !== 91) return nok(code);
    effects.consume(code);
    return inside;
  };
  const inside: State = (code) => {
    // Negative micromark codes represent line endings and tabs. Neither is a Wiki token body.
    if (code === null || code < 0) {
      effects.exit('workspaceWiki');
      return ok(code);
    }
    effects.consume(code);
    if (code === 93 && closing) {
      effects.exit('workspaceWiki');
      return ok;
    }
    closing = code === 93;
    return inside;
  };
  return start;
};

export const wikiSyntax: Extension = {
  text: {
    33: { name: 'workspaceWiki', tokenize },
    91: { name: 'workspaceWiki', tokenize },
  },
};

export const wikiFromMarkdown: MdastExtension = {
  enter: {
    workspaceWiki(token) {
      const value = this.sliceSerialize(token),
        embed = value.startsWith('!'),
        body = value.slice(embed ? 3 : 2, value.endsWith(']]') ? -2 : undefined),
        divider = body.indexOf('|'),
        target = divider < 0 ? body : body.slice(0, divider);
      this.enter(
        {
          type: 'wikiLink',
          value,
          target:
            value.endsWith(']]') && target && !target.includes('[') && !target.includes(']')
              ? target
              : null,
          alias: divider < 0 ? null : body.slice(divider + 1),
          embed,
        },
        token
      );
    },
  },
  exit: {
    workspaceWiki(token) {
      this.exit(token);
    },
  },
};

export const wikiToMarkdown: MarkdownOptions = {
  handlers: { wikiLink: (node) => node.value },
};
