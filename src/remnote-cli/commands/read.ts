import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, formatError, type OutputFormat } from '../output/formatter.js';
import { EXIT } from '../config.js';

function formatTags(tags: unknown): string {
  if (!Array.isArray(tags)) return '';
  return tags
    .map((tag) => {
      if (
        tag &&
        typeof tag === 'object' &&
        typeof (tag as Record<string, unknown>).name === 'string' &&
        typeof (tag as Record<string, unknown>).tagRemId === 'string'
      ) {
        const { name, tagRemId } = tag as { name: string; tagRemId: string };
        return `${name} [${tagRemId}]`;
      }
      return typeof tag === 'string' ? tag : '';
    })
    .filter(Boolean)
    .join(', ');
}

function formatReadText(data: unknown): string {
  const r = data as Record<string, unknown>;
  if (typeof r.error === 'string' && r.remId === undefined) return `Error: ${r.error}`;
  const lines: string[] = [];
  if (r.headline) {
    lines.push(`Title: ${r.headline}`);
  } else if (r.title) {
    lines.push(`Title: ${r.title}`);
  }
  if (r.remId) lines.push(`ID: ${r.remId}`);
  if (r.remType) lines.push(`Type: ${r.remType}`);
  if (typeof r.parentTitle === 'string' && r.parentTitle.length > 0) {
    const parentIdSuffix = typeof r.parentRemId === 'string' ? ` [${r.parentRemId}]` : '';
    lines.push(`Parent: ${r.parentTitle}${parentIdSuffix}`);
  }
  if (Array.isArray(r.ancestors) && r.ancestors.length > 0) {
    lines.push(
      `Ancestors: ${r.ancestors
        .map((ancestor) =>
          ancestor && typeof ancestor === 'object'
            ? (ancestor as Record<string, unknown>).title
            : ''
        )
        .filter(Boolean)
        .join(' <- ')}`
    );
  }
  if (r.aliases && Array.isArray(r.aliases) && r.aliases.length > 0) {
    lines.push(`Aliases: ${(r.aliases as string[]).join(', ')}`);
  }
  const formattedTags = formatTags(r.tags);
  if (formattedTags) {
    lines.push(`Tags: ${formattedTags}`);
  }
  if (r.cardDirection) lines.push(`Card: ${r.cardDirection}`);
  if (Array.isArray(r.media) && r.media.length > 0) {
    lines.push(`Media: ${r.media.length}`);
    for (const item of r.media) {
      if (!item || typeof item !== 'object') continue;
      const media = item as Record<string, unknown>;
      lines.push(
        `  - ${String(media.kind)} ${String(media.field)} ${String(media.mediaId)}${
          typeof media.mimeType === 'string' ? ` (${media.mimeType})` : ''
        }`
      );
    }
  }
  if (r.contentProperties) {
    const cp = r.contentProperties as Record<string, unknown>;
    lines.push(
      `Children: ${cp.childrenRendered}/${cp.childrenTotal}${cp.contentTruncated ? ' (truncated)' : ''}`
    );
  }
  if (r.content && typeof r.content === 'string' && r.content.length > 0) {
    lines.push('');
    lines.push(r.content as string);
  }
  return lines.join('\n');
}

function formatManyText(data: unknown, formatOne: (value: unknown) => string): string | undefined {
  const results = (data as { results?: unknown }).results;
  if (!results || typeof results !== 'object' || Array.isArray(results)) return undefined;
  return Object.entries(results as Record<string, unknown>)
    .map(([id, value]) => `# ${id}\n${formatOne(value)}`)
    .join('\n\n');
}

export function registerReadCommand(program: Command): void {
  program
    .command('read <rem-id...>')
    .description('Read one or more notes by Rem ID')
    .option('-d, --depth <n>', 'Depth of child hierarchy to render (default: 5)', '5')
    .option(
      '--content-mode <mode>',
      'Content rendering mode: "markdown" (default), "none", or "structured"'
    )
    .option('--view <view>', 'Output detail level: compact, standard, or full')
    .option('--ancestor-depth <n>', 'Number of parent Rems to include, direct parent first')
    .option('--child-limit <n>', 'Maximum children per level (default: 100)')
    .option('--max-content-length <n>', 'Maximum content character length (default: 100000)')
    .option('--include-media-metadata', 'Include ordered root image metadata for get-media')
    .action(async (remIds: string[], opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        if (new Set(remIds).size !== remIds.length) throw new Error('Duplicate Rem IDs');
        const payload: Record<string, unknown> = {
          depth: parseInt(opts.depth, 10),
        };
        if (remIds.length === 1) payload.remId = remIds[0];
        else payload.remIds = remIds;
        if (opts.contentMode) payload.contentMode = opts.contentMode;
        if (opts.view) payload.view = opts.view;
        if (opts.ancestorDepth) payload.ancestorDepth = parseInt(opts.ancestorDepth, 10);
        if (opts.childLimit) payload.childLimit = parseInt(opts.childLimit, 10);
        if (opts.maxContentLength) payload.maxContentLength = parseInt(opts.maxContentLength, 10);
        if (opts.includeMediaMetadata) payload.includeMediaMetadata = true;

        const result = await client.execute('read_note', payload);
        console.log(
          formatResult(
            result,
            format,
            (data) => formatManyText(data, formatReadText) ?? formatReadText(data)
          )
        );
        const many = (result as { results?: Record<string, { error?: string }> }).results;
        if (many && Object.values(many).some((value) => typeof value?.error === 'string'))
          process.exitCode = EXIT.ERROR;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(formatError(message, format));
        process.exitCode = EXIT.ERROR;
      } finally {
        await client.close();
      }
    });
}
