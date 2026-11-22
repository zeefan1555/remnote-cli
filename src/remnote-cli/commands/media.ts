import { emit } from '../output/runtime.js';
import { constants } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';

interface MediaResult extends Record<string, unknown> {
  data: string;
  mimeType: string;
  sizeBytes: number;
}

function requireMediaResult(value: unknown): MediaResult {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).data !== 'string' ||
    typeof (value as Record<string, unknown>).mimeType !== 'string' ||
    typeof (value as Record<string, unknown>).sizeBytes !== 'number'
  ) {
    throw new Error('Invalid media result');
  }
  return value as MediaResult;
}

export function registerGetMediaCommand(program: Command): void {
  program
    .command('get-media <rem-id>')
    .description('Save one RemNote-managed image returned by read --include-media-metadata')
    .requiredOption('--field <field>', 'Rich-text field: text or backText')
    .requiredOption('--media-id <id>', 'Stable media ID returned by read')
    .requiredOption(
      '-o, --output <path>',
      'Destination file; existing files are protected by default'
    )
    .option('--max-inline-bytes <n>', 'Maximum image bytes to retrieve (default: 5242880)')
    .option('--force', 'Overwrite an existing destination file')
    .action(async (remId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const payload: Record<string, unknown> = {
          remId,
          field: opts.field,
          mediaId: opts.mediaId,
        };
        if (opts.maxInlineBytes) payload.maxInlineBytes = Number.parseInt(opts.maxInlineBytes, 10);

        const media = requireMediaResult(await client.execute('get_media', payload));
        const bytes = Buffer.from(media.data, 'base64');
        if (bytes.length !== media.sizeBytes || bytes.toString('base64') !== media.data) {
          throw new Error('Invalid or truncated base64 image data');
        }

        const outputPath = resolve(opts.output);
        await writeFile(outputPath, bytes, {
          flag: opts.force ? 'w' : 'wx',
          mode: constants.S_IRUSR | constants.S_IWUSR | constants.S_IRGRP | constants.S_IROTH,
        });

        const { data: _data, ...metadata } = media;
        const output = { ...metadata, outputPath };
        emit(
          program,
          formatResult(
            output,
            format,
            () => `Saved ${media.mimeType} (${media.sizeBytes} bytes) to ${outputPath}`
          )
        );
      } finally {
        await client.close();
      }
    });
}
