/** Cross-repository synthetic contract fixture. Uses the real parser/sync engine, never a plugin. */
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importWorkspace,
  pushWorkspace,
  readWorkspace,
} from '../../src/business/workspace/workspace.js';
import { localStore, loadState } from '../../src/business/workspace/local.js';
import {
  hash,
  type WorkspaceRem,
  type WorkspaceBackend,
} from '../../src/business/workspace/types.js';
import { immutableProjection } from '../../src/business/workspace/snapshots.js';
import { writePrivate } from '../../src/business/workspace/files.js';

const output = await realpath(await mkdtemp(join(tmpdir(), 'remnote-learning-contract-')));
process.env.REMNOTE_CLI_CONFIG = join(output, 'config', 'connection.json');
const vault = join(output, 'vault'),
  rems = new Map<string, WorkspaceRem>();
function node(id: string, text: string, parent: string | null, extra: Partial<WorkspaceRem> = {}) {
  rems.set(id, {
    id,
    text: [text],
    parent,
    children: [],
    type: null,
    backText: null,
    document: false,
    folder: false,
    cardItem: false,
    practice: 'forward',
    enablePractice: true,
    tags: [],
    cards: [],
    ...extra,
  });
  if (parent) rems.get(parent)!.children.push(id);
}
node('home-root', 'HOME', null, { folder: true });
node('category', '合成分类', 'home-root');
node('term-root', 'Term', null, { folder: true });
node('term', '反证', 'term-root');
node('document', 'Synthetic learning', null, { document: true });
node('theme', '合成练习主题', 'document', { powerups: [{ code: 'cc', slots: [] }] });
node('question', '怎样检验一个合成结论？', 'theme', {
  backText: [],
  tags: ['category', 'term'],
  cards: [
    {
      id: 'synthetic-card',
      remId: 'question',
      type: 'forward',
      createdAt: 1,
      repetitionHistory: [{ score: 1, at: 2 }],
      nextRepetitionTime: null,
      lastRepetitionTime: null,
      timesWrongInRow: null,
    },
  ],
});
[
  'What',
  '明确要检验的结论。',
  '',
  'Why',
  '①先找到能反驳它的条件。',
  '②再区分观察和推断。',
  '',
  'How',
  '构造一例能推翻结论的测试。',
  '',
  '来源',
  '合成教材，第 2 节。',
].forEach((text, index) => node(`answer-${index}`, text, 'question', { cardItem: true }));
function snapshot(rem: WorkspaceRem): WorkspaceRem {
  return structuredClone({
    ...rem,
    public: {
      $type: 'rem',
      id: rem.id,
      parent: rem.parent,
      children: rem.children,
      text: rem.text,
      backText: rem.backText,
      type: rem.type,
    },
  });
}
const forbidden = async (): Promise<never> => {
  throw new Error('Fixture is read-only');
};
const backend: WorkspaceBackend = {
  journal: localStore('synthetic-kb'),
  identity: async () => ({ kbId: 'synthetic-kb', writable: false }),
  enumerate: async () => [...rems.values()].map(snapshot),
  subtree: forbidden,
  discover: forbidden,
  readPublic: async (ids) => ids.map((id) => snapshot(rems.get(id)!).public!),
  readProbe: async (ids, options) =>
    ids.map((id) => ({
      snapshot: snapshot(rems.get(id)!).public!,
      tags: rems.get(id)!.tags!,
      ...(options?.powerupCodes?.[id]?.length
        ? {
            powerupPresence: Object.fromEntries(
              options.powerupCodes[id].map((code) => [
                code,
                rems.get(id)!.powerups?.some((powerup) => powerup.code === code) ?? false,
              ])
            ),
          }
        : {}),
    })),
  read: async (ids, options) =>
    ids.map((id) => ({
      ...snapshot(rems.get(id)!),
      ...(options?.powerupCodes?.[id]?.length
        ? {
            powerupPresence: Object.fromEntries(
              options.powerupCodes[id].map((code) => [
                code,
                rems.get(id)!.powerups?.some((powerup) => powerup.code === code) ?? false,
              ])
            ),
          }
        : {}),
    })),
  guard: async (ids) => hash(ids.map((id) => immutableProjection(snapshot(rems.get(id)!)))),
  create: forbidden,
  writeField: forbidden,
  addTag: forbidden,
  removeTag: forbidden,
  setParent: forbidden,
  setCardItem: forbidden,
  setCardCluster: forbidden,
  cardFacts: forbidden,
  remove: forbidden,
  existingIds: async (ids) => ids.filter((id) => rems.has(id)),
};
await importWorkspace(vault, 'synthetic-kb', async () => backend);
const state = await loadState(vault),
  path = state.entries.question!.path;
const read = await readWorkspace(vault, path);
const receipt = await pushWorkspace(vault, async () => backend, {
  apply: true,
  paths: [path],
  expectedFileHash: read.fileHash,
});
const scope = {
  schema: 'remnote-learning-scope/1',
  path,
  cards: ['question'],
  parents: ['theme'],
  homeRootId: 'home-root',
  requiredTagIds: { question: ['category', 'term'] },
};
for (const [name, value] of Object.entries({ read, receipt, scope }))
  await writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
const after = await readWorkspace(vault, path);
await writePrivate(vault, path, after.content.replace('What', 'What：正文'));
await writeFile(
  join(output, 'bad-read.json'),
  JSON.stringify(await readWorkspace(vault, path), null, 2) + '\n',
  { mode: 0o600 }
);
await writePrivate(vault, path, after.content);
console.log(
  JSON.stringify({ output, vault, path, status: (receipt as { status: string }).status })
);
