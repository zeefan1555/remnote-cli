import { describe, expect, it, vi } from 'vitest';
import { RemAdapter } from '../../../src/business/rem-adapter.js';
import { normalizeCardMarkdown } from '../../../src/remnote-cli/commands/card.js';
import { MockRem, MockRemNotePlugin } from '../../helpers/business-mocks.js';

function fixture() {
  const plugin = new MockRemNotePlugin();
  plugin.enableTaskSemantics();
  const parent = plugin.addTestRem('daily', 'Daily');
  const adapter = new RemAdapter(plugin as never);
  return { plugin, parent, adapter };
}

const text = normalizeCardMarkdown(
  '- First >>>\n  - Why\n  - Reason\n\n  - How\n  - Action\n\n  - What\n  - Result\n\n  - Source\n  - Evidence\n\n' +
    '- Ordinary\n  - A\n  -\n  - B\n\n' +
    '- Second >>>\n  - Why\n  - Another reason\n\n  - How\n  - Another action'
);

describe('card creation empty answer items', () => {
  it('marks every separator on both cards but leaves an ordinary empty Rem alone', async () => {
    const { plugin, parent, adapter } = fixture();
    const result = await adapter.createCard({ content: text, parentId: parent._id });
    const roots = await parent.getChildrenRem();
    expect(roots.map((rem) => rem.text)).toEqual([['First'], ['Ordinary'], ['Second']]);
    const first = await roots[0].getChildrenRem();
    const ordinary = await roots[1].getChildrenRem();
    const second = await roots[2].getChildrenRem();
    for (const children of [first, second]) {
      const empties = children.filter((rem) => rem.text.length === 0);
      expect(empties.length).toBe(children === first ? 3 : 1);
      expect(await Promise.all(empties.map((rem) => rem.isCardItem()))).toEqual(
        Array(empties.length).fill(true)
      );
    }
    expect(ordinary[1].text).toEqual(['']);
    expect(await ordinary[1].isCardItem()).toBe(false);
    expect(result.titles.filter((title) => title === '')).toHaveLength(5);
    expect(result.titles.join(' ')).not.toContain('REMNOTECARDSEPARATOR');
    expect(plugin.storage.setLocal).toHaveBeenLastCalledWith(
      expect.stringMatching(/^additive:/),
      expect.objectContaining({ operation: 'create_note', state: 'applied' })
    );
  });

  it('identifies separators by unique text, not the SDK return order', async () => {
    const { plugin, parent, adapter } = fixture();
    const create = plugin.rem.createTreeWithMarkdown.getMockImplementation();
    if (!create) throw new Error('missing mock parser');
    plugin.rem.createTreeWithMarkdown.mockImplementation(async (...args) =>
      (await create(...args)).reverse()
    );
    await adapter.createCard({ content: text, parentId: parent._id });
    const [first, , second] = await parent.getChildrenRem();
    for (const root of [first, second]) {
      const children = await root.getChildrenRem();
      const empties = children.filter((rem) => rem.text.length === 0);
      expect(empties.length).toBeGreaterThan(0);
      expect(await Promise.all(empties.map((rem) => rem.isCardItem()))).toEqual(
        Array(empties.length).fill(true)
      );
    }
  });

  it('also supports an explicit title without changing generic rem create', async () => {
    const { plugin, parent, adapter } = fixture();
    const cardText = normalizeCardMarkdown('- Question >>>\n  - One\n\n  - Two');
    const result = await adapter.createCard({
      content: cardText,
      title: 'Topic',
      parentId: parent._id,
    });
    const title = await plugin.rem.findOne(result.remIds[0]);
    const question = (await title!.getChildrenRem())[0];
    const children = await question.getChildrenRem();
    expect(children[1].text).toEqual([]);
    expect(await children[1].isCardItem()).toBe(true);

    const plain = await adapter.createNote({ content: cardText, parentId: parent._id });
    const plainRoot = await plugin.rem.findOne(plain.remIds[0]);
    const plainChildren = await plainRoot!.getChildrenRem();
    expect(plainChildren[1].text).toEqual(['']);
    expect(await plainChildren[1].isCardItem()).toBe(false);
  });

  it('reports unknown with recovery key and all known IDs when the setter fails', async () => {
    const { plugin, parent, adapter } = fixture();
    const setter = vi
      .spyOn(MockRem.prototype, 'setIsCardItem')
      .mockRejectedValueOnce(new Error('failed'));
    try {
      const failure = await adapter
        .createCard({ content: text, parentId: parent._id })
        .catch((error) => error);
      expect(failure).toMatchObject({
        type: 'unknown_outcome',
        subtype: 'card_create_unverified',
        retryable: false,
        details: {
          recoveryKey: expect.stringMatching(/^additive:/),
          knownRemIds: expect.arrayContaining([parent._id]),
        },
      });
      const created = await plugin.rem.createTreeWithMarkdown.mock.results[0].value;
      expect(failure.details.knownRemIds).toEqual(
        expect.arrayContaining(created.map((rem) => rem._id))
      );
      expect(plugin.storage.setLocal).toHaveBeenLastCalledWith(
        failure.details.recoveryKey,
        expect.objectContaining({ state: 'unknown', remIds: failure.details.knownRemIds })
      );
      expect(plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(1);
      expect(setter).toHaveBeenCalledTimes(1);
    } finally {
      setter.mockRestore();
    }
  });

  it('fails unknown if the SDK does not keep a separator as an answer item', async () => {
    const { adapter, parent } = fixture();
    const setter = vi
      .spyOn(MockRem.prototype, 'setIsCardItem')
      .mockImplementation(async function () {
        this.setIsCardItemMock(false);
      });
    try {
      await expect(
        adapter.createCard({ content: text, parentId: parent._id })
      ).rejects.toMatchObject({
        type: 'unknown_outcome',
        retryable: false,
        details: { reason: expect.stringContaining('could not be verified') },
      });
    } finally {
      setter.mockRestore();
    }
  });

  it('does not mutate any marker if identification is incomplete', async () => {
    const { plugin, parent, adapter } = fixture();
    const create = plugin.rem.createTreeWithMarkdown.getMockImplementation();
    if (!create) throw new Error('missing mock parser');
    plugin.rem.createTreeWithMarkdown.mockImplementation(async (...args) => {
      const created = await create(...args);
      const marker = created.find((rem) => String(rem.text[0]).startsWith('REMNOTECARDSEPARATOR'));
      if (!marker) throw new Error('missing mock marker');
      marker.text = ['changed'];
      return created;
    });
    const setter = vi.spyOn(MockRem.prototype, 'setIsCardItem');
    try {
      await expect(
        adapter.createCard({ content: text, parentId: parent._id })
      ).rejects.toMatchObject({
        type: 'unknown_outcome',
        retryable: false,
        details: { reason: expect.stringContaining('uniquely identify') },
      });
      expect(setter).not.toHaveBeenCalled();
    } finally {
      setter.mockRestore();
    }
  });
});
