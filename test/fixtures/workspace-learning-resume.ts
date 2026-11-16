/** Real parser/engine cross-repo fixture; SDK effects stay entirely in this synthetic map. */
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importWorkspace,
  pushWorkspace,
  readWorkspace,
  resumeWorkspace,
} from '../../src/business/workspace/workspace.js';
import { localStore, loadState } from '../../src/business/workspace/local.js';
import {
  hash,
  type WorkspaceRem,
  type WorkspaceBackend,
} from '../../src/business/workspace/types.js';
import { immutableProjection } from '../../src/business/workspace/snapshots.js';
import { writePrivate } from '../../src/business/workspace/files.js';
import { localNodeKey } from '../../src/business/workspace/identity.js';
import { parseFrontmatter, renderFrontmatter } from '../../src/business/workspace/metadata.js';

const output = await realpath(await mkdtemp(join(tmpdir(), 'remnote-learning-resume-')));
process.env.REMNOTE_CLI_CONFIG = join(output, 'config', 'connection.json');
const vault = join(output, 'vault'),
  rems = new Map<string, WorkspaceRem>();
const calls: string[] = [];
function node(id: string, text: string, parent: string | null, extra: Partial<WorkspaceRem> = {}) {
  rems.set(id, {
    id,
    text: text ? [text] : [],
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
    ...extra,
  });
  if (parent) rems.get(parent)!.children.push(id);
}
node('home-root', 'HOME', null, { folder: true });
node('category', '合成分类', 'home-root');
node('term-root', 'Term', null, { folder: true });
node('term', '反证', 'term-root');
node('document', 'Synthetic new learning', null, { document: true });
function cards(rem: WorkspaceRem): NonNullable<WorkspaceRem['cards']> {
  if (rem.cards) return rem.cards;
  return Array.isArray(rem.backText) && rem.children.some((id) => rems.get(id)?.cardItem)
    ? [
        {
          id: `card-${rem.id}`,
          remId: rem.id,
          type: 'forward',
          createdAt: 1,
          repetitionHistory: [],
          nextRepetitionTime: null,
          lastRepetitionTime: null,
          timesWrongInRow: null,
        },
      ]
    : [];
}
function snapshot(rem: WorkspaceRem): WorkspaceRem {
  return structuredClone({
    ...rem,
    cards: cards(rem),
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
function presence(id: string, codes: string[] | undefined) {
  return codes?.length
    ? {
        powerupPresence: Object.fromEntries(
          codes.map((code) => [code, rems.get(id)!.powerupPresence?.[code] ?? false])
        ),
      }
    : {};
}
let next = 0,
  loseAck = true;
let loseFieldAck: string | undefined;
const backend: WorkspaceBackend = {
  journal: localStore('synthetic-kb'),
  identity: async () => ({ kbId: 'synthetic-kb', writable: true }),
  enumerate: async () => [...rems.values()].map(snapshot),
  subtree: async () => {
    throw new Error('Unused fixture operation');
  },
  discover: async () => {
    throw new Error('Unused fixture operation');
  },
  readPublic: async (ids) => ids.map((id) => snapshot(rems.get(id)!).public!),
  readProbe: async (ids, options) =>
    ids.map((id) => ({
      snapshot: snapshot(rems.get(id)!).public!,
      tags: rems.get(id)!.tags!,
      ...presence(id, options?.powerupCodes?.[id]),
    })),
  read: async (ids, options) =>
    ids.map((id) => ({ ...snapshot(rems.get(id)!), ...presence(id, options?.powerupCodes?.[id]) })),
  guard: async (ids) => hash(ids.map((id) => immutableProjection(snapshot(rems.get(id)!)))),
  create: async (markdown) => {
    const id = `created-${++next}`;
    node(id, markdown ? 'Workspace question' : '', null, { backText: markdown ? [] : null });
    calls.push(`create:${id}`);
    return id;
  },
  writeField: async (id, field, value) => {
    calls.push(`${field}:${id}`);
    rems.get(id)![field] = value;
    if (id === loseFieldAck) {
      loseFieldAck = undefined;
      throw new Error('synthetic lost existing-card field ack');
    }
  },
  addTag: async (id, tag) => {
    calls.push(`tag:${id}:${tag}`);
    rems.get(id)!.tags!.push(tag);
    rems.get(id)!.tags!.sort();
  },
  removeTag: async () => {
    throw new Error('Fixture never removes tags');
  },
  removeMirrorTag: async () => {
    throw new Error('Fixture never removes tags');
  },
  setParent: async (id, parent, position) => {
    calls.push(`parent:${id}`);
    rems.get(id)!.parent = parent;
    rems.get(parent)!.children.splice(position, 0, id);
  },
  setCardItem: async (id, value) => {
    calls.push(`cardItem:${id}`);
    rems.get(id)!.cardItem = value;
  },
  setCardCluster: async (id) => {
    calls.push(`cc:${id}`);
    rems.get(id)!.powerupPresence = { cc: true };
    if (loseAck) {
      loseAck = false;
      throw new Error('synthetic lost cc acknowledgment');
    }
  },
  cardFacts: async (id) =>
    cards(rems.get(id)!).map(({ id, remId, type }) => ({ id, hash: hash({ id, remId, type }) })),
  remove: async () => {
    throw new Error('Fixture never deletes');
  },
  removeMirror: async () => {
    throw new Error('Fixture never deletes');
  },
  existingIds: async (ids) => ids.filter((id) => rems.has(id)),
};
await importWorkspace(vault, 'synthetic-kb', async () => backend);
const path = (await loadState(vault)).entries.document!.path;
const initial = await readWorkspace(vault, path),
  header = parseFrontmatter(path, initial.content);
const attributes = {
  rems: { topic: { cardCluster: true as const }, question: { content: 'multiline' as const } },
};
const answers = [
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
];
const source =
  renderFrontmatter(attributes) +
  `<!-- remnote:${header.documentKey} -->\n\n` +
  header.body +
  '\n- 合成练习主题 ^topic\n  - 怎样检验一个合成结论？ #HOME/合成分类 #Term/反证 ^question\n' +
  answers.map((text, index) => `    - ${text}${text ? ' ' : ''}^answer-${index}\n`).join('');
await writePrivate(vault, path, source);
const before = await readWorkspace(vault, path);
const scope = {
  schema: 'remnote-learning-scope/1',
  path,
  cards: [localNodeKey('document', 'question')],
  parents: [localNodeKey('document', 'topic')],
  homeRootId: 'home-root',
  requiredTagIds: { [localNodeKey('document', 'question')]: ['category', 'term'] },
};
const interrupted = (await pushWorkspace(vault, async () => backend, {
  apply: true,
  paths: [path],
  expectedFileHash: before.fileHash,
})) as { status: string; planHash: string };
if (interrupted.status !== 'unknown')
  throw new Error(`Expected injected unknown, got ${interrupted.status}`);
const receipt = (await resumeWorkspace(vault, async () => backend, interrupted.planHash)) as {
  status: string;
  ids: Record<string, string>;
};
if (receipt.status !== 'verified' || calls.filter((call) => call.startsWith('cc:')).length !== 1)
  throw new Error('Resume did not verify exact one-cc execution');
const after = await readWorkspace(vault, path);
const afterScope = {
  ...scope,
  cards: scope.cards.map((key) => receipt.ids[key]!),
  parents: scope.parents.map((key) => receipt.ids[key]!),
  requiredTagIds: { [receipt.ids[scope.cards[0]!]!]: ['category', 'term'] },
};
for (const [name, value] of Object.entries({
  before,
  scope,
  interrupted,
  receipt,
  after,
  'after-scope': afterScope,
  calls,
}))
  await writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
// A second actual engine run exercises conservation of an existing card's nonempty history.
const questionId = afterScope.cards[0]!,
  question = rems.get(questionId)!;
question.cards = cards(question).map((card) => ({
  ...card,
  repetitionHistory: [{ score: 1, time: 2, scheduled: 3 }],
}));
await pushWorkspace(vault, async () => backend, {
  apply: true,
  paths: [path],
  expectedFileHash: after.fileHash,
});
const existing = await readWorkspace(vault, path);
await writePrivate(
  vault,
  path,
  existing.content.replace('明确要检验的结论。', '精确列出要检验的结论。')
);
const existingBefore = await readWorkspace(vault, path);
loseFieldAck = receipt.ids[localNodeKey('document', 'answer-1')]!;
const existingInterrupted = (await pushWorkspace(vault, async () => backend, {
  apply: true,
  paths: [path],
  expectedFileHash: existingBefore.fileHash,
})) as { status: string; planHash: string };
if (existingInterrupted.status !== 'unknown') throw new Error('Expected existing-card lost ack');
const existingReceipt = (await resumeWorkspace(
  vault,
  async () => backend,
  existingInterrupted.planHash
)) as { status: string };
if (existingReceipt.status !== 'verified') throw new Error('Existing-card proof did not resume');
for (const [name, value] of Object.entries({
  'existing-before': existingBefore,
  'existing-scope': afterScope,
  'existing-interrupted': existingInterrupted,
  'existing-receipt': existingReceipt,
}))
  await writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
console.log(JSON.stringify({ output, vault, path, status: receipt.status }));
