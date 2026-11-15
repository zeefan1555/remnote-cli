import { describe, expect, it } from 'vitest';
import { publicVerificationIds } from '../../../src/business/workspace/selection.js';
import type { LocalContext } from '../../../src/business/workspace/local.js';
import type { WorkspacePlan, WorkspaceRem } from '../../../src/business/workspace/types.js';

const rem = (id: string, extra: Partial<WorkspaceRem> = {}): WorkspaceRem => ({
  id,
  text: [id],
  backText: null,
  parent: id === 'root' ? null : 'root',
  children: [],
  type: null,
  document: false,
  folder: false,
  cardItem: false,
  practice: 'forward',
  enablePractice: true,
  tags: [],
  ...extra,
});
const ref = (id: string) => [{ i: 'q', _id: id }];
const plan: WorkspacePlan = {
  version: 1,
  directory: '/synthetic',
  kbId: 'kb',
  baseHash: '',
  files: {},
  changes: [],
  selection: {
    scope: 'changed',
    paths: [],
    files: [],
    outgoingKeys: [],
    reconcileIds: ['root', 'p', 'x', 'old', 'new', 'tag'],
    verificationIds: [],
  },
};

describe('public verification graph closure', () => {
  it.each(['text', 'backText', 'tag'] as const)(
    'includes a dependency introduced only by intended %s',
    (kind) => {
      const native = new Map(['root', 'p', 'x', 'leaf'].map((id) => [id, rem(id)]));
      native.set('x', rem('x', { text: ref('leaf') }));
      const intended: WorkspacePlan = {
        ...plan,
        changes: [
          {
            key: 'p',
            path: 'p.md',
            parent: 'root',
            position: 0,
            kind: 'text',
            cardItem: false,
            fields: kind === 'tag' ? {} : { [kind]: ref('x') },
            ...(kind === 'tag' ? { tags: { before: [], after: ['x'] } } : {}),
          },
        ],
      };
      expect(
        publicVerificationIds({ native } as LocalContext, intended, native, ['p'], [])
      ).toEqual(['leaf', 'p', 'root', 'x']);
    }
  );

  it('revisits before dependencies discovered only in the observed/after graph', () => {
    const before = new Map(['root', 'p', 'x', 'old', 'new', 'tag'].map((id) => [id, rem(id)]));
    before.set('x', rem('x', { text: ref('old'), tags: ['tag'] }));
    const observed = new Map(before);
    observed.set('p', rem('p', { text: ref('x') }));
    observed.set('x', rem('x', { text: ref('new'), tags: [] }));
    const frozenSelection = structuredClone(plan.selection);
    expect(
      publicVerificationIds({ native: before } as LocalContext, plan, observed, ['p'], [])
    ).toEqual(['new', 'old', 'p', 'root', 'tag', 'x']);
    expect(plan.selection).toEqual(frozenSelection);
  });

  it.each(['all', 'delete', 'guarded'] as const)(
    'preserves the original exact observed set for %s',
    (scope) => {
      const native = new Map([
        ['p', rem('p', { text: ref('x') })],
        ['x', rem('x')],
      ]);
      const observed = new Map([['p', native.get('p')!]]);
      expect(
        publicVerificationIds(
          { native } as LocalContext,
          {
            ...plan,
            selection: { ...plan.selection!, scope: scope === 'guarded' ? 'changed' : scope },
            ...(scope === 'guarded'
              ? { guarded: { path: 'p.md', fileHash: 'file', beforeHash: 'before' } }
              : {}),
          },
          observed,
          ['p'],
          []
        )
      ).toEqual(['p']);
    }
  );
});
