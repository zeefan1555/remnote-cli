import { describe, expect, it } from 'vitest';
import { mutationReadIds } from '../../../src/business/workspace/selection.js';
import { snapshotEditGuards } from '../../../src/business/workspace/relations.js';
import type { WorkspaceChange, WorkspaceRem } from '../../../src/business/workspace/types.js';

const node = (
  id: string,
  parent: string | null,
  extra: Partial<WorkspaceRem> = {}
): WorkspaceRem => ({
  id,
  parent,
  children: [],
  type: null,
  text: [id],
  backText: null,
  document: false,
  folder: false,
  cardItem: false,
  practice: 'forward',
  enablePractice: true,
  cards: [],
  tags: [],
  ...extra,
});
function graph() {
  return new Map(
    [
      node('root', null, { children: ['chapter', 'references'] }),
      node('chapter', 'root', { children: ['first', 'second'] }),
      node('first', 'chapter', { backText: [], children: ['answer', 'sibling'] }),
      node('answer', 'first', { cardItem: true }),
      node('sibling', 'first', { cardItem: true }),
      node('second', 'chapter', { backText: [], children: ['unrelated'] }),
      node('unrelated', 'second', { cardItem: true }),
      node('references', 'root', { children: ['old', 'new', 'tag', 'oldtag'] }),
      ...['old', 'new', 'tag', 'oldtag'].map((id) => node(id, 'references')),
    ].map((rem) => [rem.id, rem])
  );
}
const change = (
  key: string,
  parent: string | null,
  extra: Partial<WorkspaceChange> = {}
): WorkspaceChange => ({
  key,
  parent,
  path: 'chapter.md',
  position: 0,
  kind: 'text',
  cardItem: true,
  fields: { text: ['Edited'] },
  ...extra,
});

describe('mutation graph readsets', () => {
  it('includes the owning card family and old/new references and tags, not unrelated siblings', () => {
    const rems = graph();
    rems.get('answer')!.text = [{ i: 'q', _id: 'old' }];
    rems.get('answer')!.tags = ['oldtag'];
    expect(
      mutationReadIds(
        change('answer', 'first', {
          fields: { text: [{ i: 'q', _id: 'new' }] },
          relations: { tags: ['tag'] },
        }),
        rems
      )
    ).toEqual([
      'answer',
      'chapter',
      'first',
      'new',
      'old',
      'oldtag',
      'references',
      'root',
      'sibling',
      'tag',
    ]);
  });

  it('resolves only persisted new identities while retaining the intended parent family', () => {
    const rems = graph(),
      edit = change('new:answer', 'first');
    expect(mutationReadIds(edit, rems)).toEqual(['answer', 'chapter', 'first', 'root', 'sibling']);
    rems.set('created', node('created', null));
    expect(mutationReadIds(edit, rems, { 'new:answer': 'created' })).toEqual([
      'answer',
      'chapter',
      'created',
      'first',
      'root',
      'sibling',
    ]);
  });

  it('checks descendants only for an explicit Powerup mutation', () => {
    const rems = graph();
    expect(mutationReadIds(change('chapter', 'root'), rems)).toEqual(['chapter', 'root']);
    expect(
      mutationReadIds(change('chapter', 'root', { relations: { powerups: { cc: true } } }), rems)
    ).toEqual(['answer', 'chapter', 'first', 'root', 'second', 'sibling', 'unrelated']);
  });

  it('keeps exact Portal children and native included targets in a reference footprint', () => {
    const rems = graph();
    rems.set(
      'portal',
      node('portal', 'references', {
        type: 6,
        children: ['wrapper'],
        portal: { type: null, directlyIncludedRemIds: ['old', 'absent'] },
      })
    );
    rems.set('wrapper', node('wrapper', 'portal'));
    const ids = mutationReadIds(
      change('answer', 'first', { fields: { text: [{ i: 'q', _id: 'portal' }] } }),
      rems
    );
    expect(ids).toEqual([
      'answer',
      'chapter',
      'first',
      'old',
      'portal',
      'references',
      'root',
      'sibling',
      'wrapper',
    ]);
    expect(mutationReadIds(change('new:child', 'new:parent'), rems)).toEqual([]);
  });

  it('preserves empty known code sets without inventing unknown states or Card history', () => {
    const rems = graph();
    expect(snapshotEditGuards(rems, ['answer'], [])[0]).toMatchObject({
      cardIds: [],
      tags: [],
      powerups: {},
    });
    expect(() => snapshotEditGuards(rems, ['answer'], ['cc'])).toThrow(
      'Incomplete exact native edit relationships'
    );
    rems.get('answer')!.powerupStates = { cc: false };
    expect(snapshotEditGuards(rems, ['answer'], ['cc'])[0]).toMatchObject({
      powerups: { cc: false },
    });
    delete rems.get('answer')!.cards;
    expect(() => snapshotEditGuards(rems, ['answer'], ['cc'])).toThrow(
      'Exact Card identities and review history'
    );
    expect(() => snapshotEditGuards(rems, ['absent'], [])).toThrow(
      'Incomplete exact native edit relationships'
    );
    rems.get('sibling')!.tags = ['tag', 'tag'];
    expect(() => snapshotEditGuards(rems, ['sibling'], [])).toThrow(
      'Incomplete exact native edit relationships'
    );
  });

  it('requires unique Card IDs and hashes full history plus creation time in a stable order', () => {
    const rems = graph();
    const card = {
      id: 'a',
      remId: 'first',
      type: 'forward',
      createdAt: 1,
      repetitionHistory: [{ score: 1 }],
      nextRepetitionTime: null,
      lastRepetitionTime: null,
      timesWrongInRow: null,
    };
    const second = { ...card, id: 'b' };
    rems.get('first')!.cards = [second, card];
    const proof = snapshotEditGuards(rems, ['first'], [])[0]!;
    rems.get('first')!.cards = [card, second];
    expect(snapshotEditGuards(rems, ['first'], [])[0]).toEqual(proof);
    rems.get('first')!.cards = [card, { ...second, createdAt: 2 }];
    expect(snapshotEditGuards(rems, ['first'], [])[0]!.reviewHash).not.toBe(proof.reviewHash);
    rems.get('first')!.cards = [card, card];
    expect(() => snapshotEditGuards(rems, ['first'], [])).toThrow(
      'Duplicate native Card identities'
    );
    rems.get('first')!.cards = [{ ...card, repetitionHistory: null }];
    expect(() => snapshotEditGuards(rems, ['first'], [])).toThrow(
      'Exact Card identities and review history'
    );
  });
});
