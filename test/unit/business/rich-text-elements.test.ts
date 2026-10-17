import { describe, expect, it } from 'vitest';
import { summarizeRichText } from '../../../src/business/rich-text-elements.js';

describe('rich text element summary', () => {
  it('counts every feature, including several on one element', () => {
    const summary = summarizeRichText([
      'see [[ and [[',
      { i: 'm', text: 'plain line' },
      { i: 'm', text: 'print(1)', code: true, language: 'python', b: true, cId: 'c1' },
      { i: 'm', text: 'inline', l: true, url: 'https://example.test' },
      { i: 'm', text: 'ref link', qId: 'rem-link' },
      { i: 'x', text: 'x^2', cId: 'latex-1' },
      { i: 'i', url: 'https://cdn.example/a.png', blocks: [{ cId: 'img-1' }, { cId: '' }] },
      { i: 'q', _id: 'target', aliasId: 'alias-1', cId: 'ref-cloze' },
      { i: 'q', _id: 'other' },
      { i: 'm', code: true, text: 'no-lang' },
    ]);
    expect(summary.counts).toEqual({
      plain: 2,
      code: 2,
      cloze: 4,
      latex: 1,
      image: 1,
      rem: 2,
      alias: 1,
      bold: 1,
      italic: 1,
      link: 2,
      literalBrackets: 2,
    });
    expect(summary.items).toEqual(
      expect.arrayContaining([
        { kind: 'plain', text: 'see [[ and [[' },
        { kind: 'plain', text: 'plain line' },
        { kind: 'code', text: 'print(1)', language: 'python' },
        { kind: 'bold', text: 'print(1)' },
        { kind: 'cloze', cId: 'c1' },
        { kind: 'italic', text: 'inline' },
        { kind: 'link', url: 'https://example.test', text: 'inline' },
        { kind: 'link', url: 'rem-link', text: 'ref link' },
        { kind: 'latex', text: 'x^2', cId: 'latex-1' },
        { kind: 'cloze', cId: 'latex-1' },
        { kind: 'image', url: 'https://cdn.example/a.png' },
        { kind: 'cloze', cId: 'img-1' },
        { kind: 'rem', id: 'target' },
        { kind: 'alias', id: 'target', aliasId: 'alias-1' },
        { kind: 'cloze', cId: 'ref-cloze' },
        { kind: 'rem', id: 'other' },
        { kind: 'code', text: 'no-lang' },
      ])
    );
  });

  it('does not treat a text element as code unless code is true', () => {
    const summary = summarizeRichText([{ i: 'm', text: 'not a code block' }]);
    expect(summary.counts.code).toBe(0);
    expect(summary.items).toEqual([{ kind: 'plain', text: 'not a code block' }]);
  });

  it('counts literal brackets inside code text and ignores a non-array', () => {
    expect(
      summarizeRichText([{ i: 'm', code: true, language: 'ts', text: '[[' }]).counts
    ).toMatchObject({ code: 1, literalBrackets: 1, plain: 0 });
    expect(summarizeRichText(undefined)).toEqual({
      counts: {
        plain: 0,
        code: 0,
        cloze: 0,
        latex: 0,
        image: 0,
        rem: 0,
        alias: 0,
        bold: 0,
        italic: 0,
        link: 0,
        literalBrackets: 0,
      },
      items: [],
    });
    expect(summarizeRichText([{ i: 'q' }, { i: 's' }, null, 1]).items).toEqual([]);
  });
});
