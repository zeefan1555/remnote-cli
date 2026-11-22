import { emit, fail } from '../output/runtime.js';
import { Command } from 'commander';
import { InspectManySchema, VerifyScopeSchema } from '../../schemas/composite-schemas.js';
import { createCommandClient } from '../client/command-client.js';
import { CliFailure } from '../output/errors.js';
import { formatResult } from '../output/formatter.js';
import { readContentFileOrStdin } from './content-input.js';
import { summarizeReceipt } from '../output/receipt-summary.js';
export function registerCompositeCommands(program: Command): void {
  async function execute(
    action: 'inspect_many' | 'verify_scope',
    path: string,
    summary = false
  ): Promise<void> {
    const format = program.opts().text ? 'text' : 'json';
    const client = createCommandClient(program);
    try {
      const input: unknown = JSON.parse(await readContentFileOrStdin(path));
      const schema = action === 'inspect_many' ? InspectManySchema : VerifyScopeSchema;
      const result = (await client.execute(action, schema.parse(input))) as Record<string, unknown>;
      const output = summary ? summarizeReceipt(result) : result;
      if (
        result.complete !== true ||
        !Array.isArray(result.errors) ||
        result.errors.length > 0 ||
        (action === 'verify_scope' && result.status !== 'passed')
      )
        fail(
          program,
          new CliFailure('conflict', 'receipt_incomplete', 'Receipt is failed or incomplete', {
            details: output,
          })
        );
      else
        emit(
          program,
          formatResult(output, format, () => JSON.stringify(output, null, 2))
        );
    } finally {
      await client.close();
    }
  }
  program
    .command('context')
    .description('Read one bounded, structured context receipt without modifying RemNote')
    .requiredOption(
      '--request <path|->',
      'Read a schemaVersion=1 inspection request from JSON file or stdin'
    )
    .addHelpText(
      'after',
      [
        '',
        'Request example:',
        '  {"schemaVersion":1,"remIds":["REM_ID"],"subtreeRootIds":["ROOT_ID"],"tagRemIds":["TAG_ID"],"maxRems":1000,"ancestorDepth":20}',
        'At least one selector ID is required. Raw text/title/aliases are returned only for remIds;',
        'subtree/tag-only objects contain structural metadata and textHash. Reads are not atomic.',
        'Incomplete receipts exit nonzero. Preserve required proof scopes when retrying.',
      ].join('\n')
    )
    .action(async (opts: { request: string }) => execute('inspect_many', opts.request));
  program
    .command('verify')
    .description('Verify explicit expectations against fresh read-only evidence')
    .command('scope')
    .description(
      'Verify scope expectations; emits a receipt and exits nonzero on failed/incomplete evidence'
    )
    .requiredOption(
      '--expect <path|->',
      'Read a schemaVersion=1 verification request from JSON file or stdin'
    )
    .option(
      '--summary',
      'Emit scope, IDs, hashes, counts and failures without content/history bodies'
    )
    .addHelpText(
      'after',
      [
        '',
        'Verification example:',
        '  {"schemaVersion":1,"inspect":{"schemaVersion":1,"remIds":["REM_ID"],"subtreeRootIds":["ROOT_ID"]},"expectations":[{"kind":"parent","remId":"REM_ID","value":"ROOT_ID"}]}',
        'All check kinds (each requires remId):',
        '  parent / ancestor: value=exact Rem ID; remType: value=folder|document|dailyDocument|concept|descriptor|portal|text',
        '  tag: value=tag ID, present=true, inverse=true (requires that tag in inspect.tagRemIds)',
        '  powerup: code=cc|u, value=boolean',
        '  references / children: value=ID array, exact=true (children preserve order)',
        '  cardRemIds: value=card-generating Rem ID array; zeroCards: noCardStructure=true',
        'cardRemIds and zeroCards require their root in inspect.subtreeRootIds.',
        'Only status=passed succeeds. Failed/incomplete receipts are emitted before nonzero exit;',
        'never narrow away required WIKI or full-card scope merely to obtain a pass.',
      ].join('\n')
    )
    .action(async (opts: { expect: string; summary?: boolean }) =>
      execute('verify_scope', opts.expect, opts.summary)
    );
}
