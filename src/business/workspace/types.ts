import { createHash } from 'node:crypto';
import type {
  DocumentAttributes,
  NativeDetails,
  NativeMetadata,
  WorkspaceMetadata,
} from './metadata.js';

export function hash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)])
      );
    return input;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value ?? null)))
    .digest('hex');
}
export interface WorkspaceRem {
  id: string;
  parent: string | null;
  children: string[];
  type: number | string | null;
  text: unknown;
  backText: unknown;
  document: boolean | null;
  folder: boolean | null;
  cardItem: boolean | null;
  practice: 'forward' | 'backward' | 'both' | 'none' | null;
  enablePractice: boolean | null;
  unsupported?: string;
  /** Complete public snapshot, including unknown fields and explicit SDK timestamps. Never written back. */
  public?: Record<string, unknown>;
  tags?: NativeMetadata['tags'];
  references?: NativeMetadata['references'];
  powerups?: NativeMetadata['powerups'];
  propertyValues?: NativeMetadata['propertyValues'];
  portal?: NativeMetadata['portal'];
  cards?: NativeMetadata['cards'];
  facts?: Partial<NativeDetails>;
  collected?: string[];
}
export interface WorkspaceEntry {
  path: string;
  blockId: string;
  rawPath: string;
  rawHash: string;
  nativeHash: string;
  editable: boolean;
  publicHash?: string;
  originalHash?: string;
}
export interface WorkspaceDocument {
  rootId: string;
  fileHash: string;
  nodeIds: string[];
}
/** Millisecond version evidence, not a claim about cross-device physical edit order. */
export interface ContentVersion {
  contentHash: string;
  timestamp: number | null;
  source: 'cli-save' | 'rem-updated-at';
  /** Native content changed since publication, including an observed return to baseline. */
  sinceBaseline?: true;
}
export interface WorkspaceState {
  version: 1;
  directory: string;
  kbId: string;
  snapshotAt: string;
  complete: boolean;
  scope: 'library' | 'subtree';
  rootIds: string[];
  globalDiscoveryComplete: boolean;
  official?: {
    archiveSha256: string;
    exportDate: string;
    manifestPath: string;
    manifestHash: string;
    remCount: number;
    cardCount: number;
  };
  errors: string[];
  entries: Record<string, WorkspaceEntry>;
  documents: Record<string, WorkspaceDocument>;
  localVersions?: Record<string, ContentVersion>;
  remoteVersions?: Record<string, ContentVersion>;
  pending?: { planHash: string; journalKey: string };
}
export interface Diagnostic {
  path: string;
  line: number;
  code: string;
  message: string;
}
export type NodeKind = 'text' | 'multiline' | 'basic' | 'opaque' | 'mount';
export interface OutlineNode {
  key: string;
  blockId: string;
  parent: string | null;
  line: number;
  kind: NodeKind;
  text: unknown[];
  backText: unknown[];
  children: string[];
  contentHash: string;
}
export interface ParsedOutline {
  path: string;
  attributes?: DocumentAttributes;
  metadata?: WorkspaceMetadata;
  nodes: OutlineNode[];
  references: Array<{ id: string; line: number }>;
}
export interface ParsedDocument extends ParsedOutline {
  fileHash: string;
}
export interface WorkspaceChange {
  key: string;
  path: string;
  parent: string | null;
  position: number;
  kind: NodeKind;
  cardItem: boolean;
  beforeHash?: string;
  fields: Partial<Record<'text' | 'backText', unknown[]>>;
}
export interface WorkspacePlan {
  version: 1;
  directory: string;
  kbId: string;
  baseHash: string;
  /** Whole-vault byte seal, including verification-only records and excluded owned guides. */
  inputHash?: string;
  files: Record<string, string>;
  changes: WorkspaceChange[];
  deletion?: { rootId: string; scopeRoot: string; ids: string[] };
  selection?: SyncSelection;
}
/** Outgoing intent, reconciliation candidates and verification dependencies are distinct sets. */
export interface SyncSelection {
  scope: 'changed' | 'all' | 'delete';
  paths: string[];
  files: string[];
  outgoingKeys: string[];
  reconcileIds: string[];
  verificationIds: string[];
}
export interface SyncConflict {
  id: string;
  path: string;
  reason: 'untrusted-edit-order' | 'remote-structure' | 'remote-missing';
  baseHash: string;
  localHash: string;
  remoteHash: string | null;
  remoteUpdatedAt: number | null;
}
export interface SyncResolution {
  id: string;
  path: string;
  baseHash: string;
  local: ContentVersion;
  remote: ContentVersion;
  policy: 'version-time-lww';
  winner: 'local' | 'remote';
}
export interface SyncPlan extends WorkspacePlan {
  remoteHashes: Record<string, string>;
  incoming: string[];
  converged: string[];
  conflicts: SyncConflict[];
  resolutions: SyncResolution[];
}
export interface MetadataStore {
  getLocal<T>(key: string): Promise<T | undefined>;
  setLocal<T>(key: string, value: T): Promise<void>;
}
export type NativeFlags = Partial<
  Pick<
    WorkspaceRem,
    | 'document'
    | 'folder'
    | 'cardItem'
    | 'practice'
    | 'enablePractice'
    | 'unsupported'
    | 'portal'
    | 'cards'
    | 'facts'
    | 'collected'
    | 'tags'
    | 'references'
    | 'powerups'
    | 'propertyValues'
  >
>;
export interface PublicDiscovery {
  snapshots: Record<string, unknown>[];
  flags: Record<string, NativeFlags>;
}
/** Adapter seam: atomic SDK operations, CLI-owned composition. */
export interface WorkspaceBackend {
  journal: MetadataStore;
  identity(): Promise<{ kbId: string; writable: boolean; destructive?: boolean }>;
  enumerate(): Promise<WorkspaceRem[]>;
  subtree(rootIds: string[]): Promise<WorkspaceRem[]>;
  discover(ids: string[]): Promise<PublicDiscovery>;
  readPublic(ids: string[]): Promise<Record<string, unknown>[]>;
  read(ids: string[]): Promise<WorkspaceRem[]>;
  guard(ids: string[]): Promise<string>;
  create(markdown?: string): Promise<string>;
  writeField(id: string, field: 'text' | 'backText', value: unknown[]): Promise<void>;
  setParent(id: string, parent: string, position: number): Promise<void>;
  setCardItem(id: string, value: boolean): Promise<void>;
  cardFacts(id: string): Promise<Array<{ id: string; hash: string }>>;
  remove(id: string): Promise<void>;
  existingIds(ids: string[]): Promise<string[]>;
}
