import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateRules,
  parseStateRulesFile,
  type StateRule,
} from '../../../src/business/state-rules.js';

const document = {
  rems: [
    {
      id: 'answer',
      markdown: 'See the line',
      backMarkdown: 'return 1\n[[not a ref',
      elements: {
        backText: {
          items: [
            { kind: 'code', language: 'python', text: 'return 1' },
            { kind: 'plain', text: 'tail' },
          ],
        },
      },
      tags: [
        {
          id: 'tag',
          name: 'Code',
          type: 'concept',
          ancestors: [
            { id: 'root', name: 'Home', type: 'folder' },
            { id: 'mid', name: 'Projects', type: 'document' },
          ],
        },
      ],
      children: ['c1', 'c2'],
      portal: {
        portalType: 'searchPortal',
        includedIds: ['row'],
        query: 'parent:Home',
        filter: null,
      },
      cards: [{ id: 'card-1', hash: 'abc123', historyLength: 2 }],
    },
  ],
};

function rule(partial: StateRule): StateRule {
  return partial;
}

describe('generic state rules', () => {
  it('evaluates path ops and reports actual against expected', async () => {
    const rules: StateRule[] = [
      rule({
        id: 'code-line',
        path: 'rems[0].elements.backText.items',
        op: 'count',
        match: { kind: 'code', language: 'python' },
        expect: 1,
      }),
      rule({ id: 'answer-text', path: 'rems[0].backMarkdown', op: 'contains', expect: 'return 1' }),
      rule({ id: 'prefix', path: 'rems[0].markdown', op: 'startsWith', expect: 'See' }),
      rule({ id: 'pattern', path: 'rems[0].markdown', op: 'regex', expect: 'the l.ne' }),
      rule({ id: 'no-brackets', path: 'rems[0].markdown', op: 'notContains', expect: '[[' }),
      rule({
        id: 'tag-name',
        path: 'rems[0].tags',
        op: 'any',
        expect: { name: 'Code', type: 'concept' },
      }),
      rule({
        id: 'tag-ancestor',
        path: 'rems[0].tags[0].ancestors',
        op: 'any',
        expect: { name: 'Projects', id: 'mid' },
      }),
      rule({
        id: 'all-ancestors',
        path: 'rems[0].tags[0].ancestors',
        op: 'all',
        expect: { type: 'folder' },
      }),
      rule({ id: 'children', path: 'rems[0].children', op: 'none', expect: 'missing' }),
      rule({ id: 'child-count', path: 'rems[0].children', op: 'count', expect: 2 }),
      rule({
        id: 'portal',
        path: 'rems[0].portal.portalType',
        op: 'equals',
        expect: 'searchPortal',
      }),
      rule({ id: 'included', path: 'rems[0].portal.includedIds', op: 'contains', expect: 'row' }),
      rule({
        id: 'by-id',
        path: 'rems[id=answer][0].cards[0].hash',
        op: 'equals',
        expect: 'abc123',
      }),
      rule({ id: 'mapped', path: 'rems.markdown', op: 'count', expect: 1 }),
      rule({ id: 'number-count', path: 'rems[0].cards[0].historyLength', op: 'count', expect: 2 }),
    ];
    const report = await evaluateRules(document, rules, process.cwd());
    expect(report.rules.find((item) => item.id === 'all-ancestors')?.status).toBe('fail');
    expect(report.rules.find((item) => item.id === 'all-ancestors')).toMatchObject({
      actual: document.rems[0].tags[0].ancestors,
      expected: { type: 'folder' },
    });
    expect(
      report.rules
        .filter((item) => item.id !== 'all-ancestors')
        .every((item) => item.status === 'pass')
    ).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('fails a missing path and an empty all, and passes none on an empty list', async () => {
    const report = await evaluateRules(
      { rems: [{ id: 'x', tags: [] }] },
      [
        { id: 'missing', path: 'rems[0].markdown', op: 'notContains', expect: '[[' },
        { id: 'empty-all', path: 'rems[0].tags', op: 'all', expect: { name: 'Code' } },
        { id: 'empty-none', path: 'rems[0].tags', op: 'none', expect: { name: 'Code' } },
        { id: 'empty-any', path: 'rems[0].tags', op: 'any', expect: { name: 'Code' } },
        { id: 'filtered', path: 'rems', op: 'count', match: { id: 'absent' }, expect: 0 },
      ],
      process.cwd()
    );
    expect(report.rules.map((item) => item.status)).toEqual([
      'fail',
      'fail',
      'pass',
      'fail',
      'pass',
    ]);
    expect(report.rules[0]).toMatchObject({ id: 'missing', actual: null, expected: '[[' });
  });

  it('compares a hash to a baseline file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnote-rule-baseline-'));
    await writeFile(join(directory, 'card.hash'), 'abc123\n', 'utf8');
    const pass = await evaluateRules(
      document,
      [{ id: 'unchanged', path: 'rems[0].cards[0].hash', op: 'hashEquals', baseline: 'card.hash' }],
      directory
    );
    expect(pass.rules[0]).toEqual({
      id: 'unchanged',
      status: 'pass',
      actual: 'abc123',
      expected: 'abc123',
    });
    const fail = await evaluateRules(
      document,
      [{ id: 'changed', path: 'rems[0].cards[0].hash', op: 'hashEquals', expect: 'nope' }],
      directory
    );
    expect(fail.rules[0]).toMatchObject({ status: 'fail', actual: 'abc123', expected: 'nope' });
  });

  it('rejects unknown ops, duplicate ids, and invalid regex', () => {
    expect(() =>
      parseStateRulesFile({
        schemaVersion: 1,
        rules: [{ id: 'x', path: 'rems', op: 'cardUnchanged' }],
      })
    ).toThrow(/unknown op/);
    expect(() =>
      parseStateRulesFile({
        schemaVersion: 1,
        rules: [
          { id: 'x', path: 'rems', op: 'count', expect: 1 },
          { id: 'x', path: 'rems', op: 'count', expect: 1 },
        ],
      })
    ).toThrow(/Duplicate rule id/);
    expect(() =>
      parseStateRulesFile({
        schemaVersion: 1,
        rules: [{ id: 'x', path: 'rems[', op: 'equals', expect: 1 }],
      })
    ).toThrow(/Invalid rule path/);
    expect(() =>
      parseStateRulesFile({
        schemaVersion: 1,
        rules: [{ id: 'x', path: 'rems[0]', op: 'regex', expect: '[' }],
      })
    ).toThrow(/invalid regex/);
  });

  it('maps wildcard paths without a per-index rule', async () => {
    const report = await evaluateRules(
      {
        rems: [
          { id: 'a', isCardItem: true, tags: [{ name: 'T' }], children: ['c1'] },
          {
            id: 'b',
            isCardItem: true,
            tags: [{ name: 'U' }, { name: 'T' }],
            children: ['c2'],
          },
        ],
      },
      [
        { id: 'cards', path: 'rems[*].isCardItem', op: 'all', expect: true },
        { id: 'names', path: 'rems[*].tags[*].name', op: 'any', expect: 'U' },
        { id: 'child-ids', path: 'rems[*].children[*]', op: 'equals', expect: ['c1', 'c2'] },
        { id: 'one-index', path: 'rems[0].isCardItem', op: 'equals', expect: true },
      ],
      process.cwd()
    );
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.rules.every((rule) => rule.status === 'pass')).toBe(true);
  });

  it('includes the read complete flag and errors and fails ok when the read is incomplete', async () => {
    const report = await evaluateRules(
      {
        complete: false,
        errors: [{ message: 'batch_read_failed: timeout' }],
        rems: [{ id: 'a', markdown: 'See', errors: [{ field: 'cards', message: 'nope' }] }],
      },
      [{ id: 'text', path: 'rems[0].markdown', op: 'equals', expect: 'See' }],
      process.cwd()
    );
    expect(report.rules[0].status).toBe('pass');
    expect(report.complete).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      { message: 'batch_read_failed: timeout' },
      { id: 'a', field: 'cards', message: 'nope' },
    ]);
    const errorsOnly = await evaluateRules(
      {
        complete: true,
        errors: [{ message: 'field failed' }],
        rems: [{ id: 'a', markdown: 'See' }],
      },
      [{ id: 'text', path: 'rems[0].markdown', op: 'equals', expect: 'See' }],
      process.cwd()
    );
    expect(errorsOnly.complete).toBe(true);
    expect(errorsOnly.ok).toBe(false);
    expect(errorsOnly.errors).toEqual([{ message: 'field failed' }]);
    const duplicated = await evaluateRules(
      {
        complete: false,
        errors: [{ id: 'a', field: 'cards', message: 'nope' }],
        rems: [{ id: 'a', errors: [{ field: 'cards', message: 'nope' }] }],
      },
      [{ id: 'text', path: 'rems[0].id', op: 'equals', expect: 'a' }],
      process.cwd()
    );
    expect(duplicated.errors).toEqual([{ id: 'a', field: 'cards', message: 'nope' }]);
  });
});
