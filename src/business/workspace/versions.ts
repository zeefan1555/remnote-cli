import { contentProjection, remoteEditedAt } from './snapshots.js';
import { hash, type ContentVersion, type OutlineNode, type WorkspaceRem } from './types.js';

/** A bounded allowance for ordinary device clock skew, not an adjustable ordering policy. */
const FUTURE_SKEW_MS = 5 * 60 * 1_000;

export function nodeContent(node: OutlineNode, base?: WorkspaceRem) {
  if (node.kind === 'opaque' && base) return contentProjection(base);
  return contentProjection({
    text: node.text,
    backText:
      node.kind === 'basic'
        ? node.backText
        : (base?.backText ?? (node.kind === 'multiline' ? [] : null)),
  });
}

export function remoteVersion(
  rem: WorkspaceRem,
  previous?: ContentVersion,
  baselineHash?: string
): ContentVersion {
  const contentHash = hash(contentProjection(rem));
  // Only the last observed version is retained: observed A -> B -> A gets a new timestamp.
  // A review/metadata-only change to the same content does not promote its version time.
  const unchanged = previous?.contentHash === contentHash;
  const timestamp = unchanged ? previous.timestamp : remoteEditedAt(rem);
  const sinceBaseline =
    baselineHash !== undefined &&
    (contentHash !== baselineHash ||
      previous?.sinceBaseline ||
      (previous !== undefined && !unchanged));
  return {
    contentHash,
    timestamp:
      timestamp !== null &&
      previous?.timestamp !== null &&
      previous?.timestamp !== undefined &&
      timestamp < previous.timestamp
        ? null
        : timestamp,
    source: 'rem-updated-at',
    ...(sinceBaseline ? { sinceBaseline: true } : {}),
  };
}

export function usableVersion(
  version: ContentVersion | undefined,
  contentHash: string,
  source: ContentVersion['source'],
  now = Date.now()
): version is ContentVersion & { timestamp: number } {
  return Boolean(
    version &&
    version.source === source &&
    version.contentHash === contentHash &&
    version.timestamp !== null &&
    Number.isSafeInteger(version.timestamp) &&
    version.timestamp > 0 &&
    version.timestamp <= now + FUTURE_SKEW_MS
  );
}
