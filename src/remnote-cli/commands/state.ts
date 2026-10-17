import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { INSPECT_FIELDS, type InspectField } from '../../business/state-inspect.js';
import {
  evaluateRules,
  parseStateRulesFile,
  type StateRulesFile,
} from '../../business/state-rules.js';
import { createCommandClient } from '../client/command-client.js';
import { EXIT } from '../config.js';
import { formatError, formatResult, type OutputFormat } from '../output/formatter.js';
import { readContentFileOrStdin } from './content-input.js';

const RULES_BYTES = 1024 * 1024;

function formatOf(program: Command): OutputFormat {
  return program.opts().text ? 'text' : 'json';
}

function fail(format: OutputFormat, error: unknown): void {
  console.error(formatError(error instanceof Error ? error.message : String(error), format));
  process.exitCode = EXIT.ERROR;
}

export function parseIdSource(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const value = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
      throw new Error('ID file must be a JSON array of strings or whitespace-separated ids');
    return value.map((item) => item.trim()).filter(Boolean);
  }
  return trimmed.split(/\s+/);
}

async function readRules(path: string): Promise<{ file: StateRulesFile; directory: string }> {
  const text = path === '-' ? await readContentFileOrStdin(path) : await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > RULES_BYTES) throw new Error('Rules file exceeds 1 MB');
  return {
    file: parseStateRulesFile(JSON.parse(text) as unknown),
    directory: path === '-' ? process.cwd() : dirname(path),
  };
}

function parseFields(value: string | undefined): InspectField[] | undefined {
  if (value === undefined) return undefined;
  const fields = value
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  if (
    fields.length === 0 ||
    fields.some((field) => !INSPECT_FIELDS.includes(field as InspectField))
  )
    throw new Error(
      `Unknown field. Expected a comma-separated list of: ${INSPECT_FIELDS.join(', ')}`
    );
  return fields as InspectField[];
}

function formatInspectText(data: unknown): string {
  const document = data as {
    rems?: Array<{ id?: string; type?: string; missing?: boolean; markdown?: string }>;
    assertions?: {
      rules?: Array<{ id: string; status: string; actual: unknown; expected: unknown }>;
    };
  };
  const lines: string[] = [];
  for (const rem of document.rems ?? [])
    lines.push(`${rem.id ?? ''} ${rem.missing ? 'missing' : (rem.type ?? '')}`.trim());
  for (const rule of document.assertions?.rules ?? [])
    lines.push(
      `${rule.status.toUpperCase()} ${rule.id} actual=${JSON.stringify(rule.actual)} expected=${JSON.stringify(rule.expected)}`
    );
  return lines.join('\n');
}

function formatRulesText(data: unknown): string {
  const report = data as {
    rules?: Array<{ id: string; status: string; actual: unknown; expected: unknown }>;
  };
  return (report.rules ?? [])
    .map(
      (rule) =>
        `${rule.status.toUpperCase()} ${rule.id} actual=${JSON.stringify(rule.actual)} expected=${JSON.stringify(rule.expected)}`
    )
    .join('\n');
}

export function registerInspectCommand(program: Command): void {
  program
    .command('inspect [ids...]')
    .description('Read generic Rem state as JSON in one bridge session')
    .option('--from-file <path|->', 'JSON array or whitespace-separated Rem IDs')
    .option('--descendants <n>', 'Include descendants to this depth (0-20)', '0')
    .option('--fields <list>', `Comma-separated fields: ${INSPECT_FIELDS.join(', ')}`)
    .option('--summary', 'Omit raw text and markdown; keep elements, ids, counts, and hashes')
    .option('--expect <path|->', 'Evaluate a generic rules file against this inspect result')
    .option('--strict', 'Exit 1 when a rule fails or the read is incomplete')
    .addHelpText(
      'after',
      [
        '',
        'One connection loads every requested ID with findMany, then descendant, tag, and ancestor IDs in further batches.',
        'id is always returned. --fields limits both the SDK calls and the JSON. --summary omits text, backText, and markdown unless --fields is set.',
        'elements lists rich-text features. A code block is an element with code:true (and optional language). rem.isCode is not that signal.',
        'Literal [[ counts are separate from rem-reference elements. tags and parent are root-first name/id/type chains; ancestors exclude the node itself.',
        'portal is set for a portal Rem or a Rem carrying powerup sp. query is slot q and filter is slot f (search portals and table filters). An unrecognized portal type is portalType null plus portalTypeRaw, not a read error. When complete is false, errors lists the reason, including each Rem field error.',
        'cards include due/nextRepetition (the same timestamp), history length, and a hash of card id, rem id, type, and repetition history.',
        'Rule failures are reported in assertions and exit 0 unless --strict. assertions.ok is false when a rule fails, the read is incomplete, or the read has errors. Usage and connection errors still exit 1.',
        'Examples:',
        '  remnote-cli inspect REM_ID --fields elements,markdown,isCardItem,hasCardStructure',
        '  remnote-cli inspect --from-file ids.txt --descendants 1 --expect rules.json --strict',
      ].join('\n')
    )
    .action(async (ids: string[], opts) => {
      const format = formatOf(program);
      const client = createCommandClient(program);
      try {
        const fromFile = opts.fromFile
          ? parseIdSource(await readContentFileOrStdin(opts.fromFile))
          : [];
        const remIds = [...ids, ...fromFile];
        const descendants = Number(opts.descendants);
        if (!Number.isInteger(descendants)) throw new Error('Invalid descendants');
        const result = (await client.execute('inspect_state', {
          remIds,
          descendants,
          ...(opts.fields ? { fields: parseFields(opts.fields) } : {}),
          ...(opts.summary ? { summary: true } : {}),
        })) as { complete?: boolean };
        let output: unknown = result;
        if (opts.expect) {
          const { file, directory } = await readRules(opts.expect);
          const assertions = await evaluateRules(result, file.rules, directory);
          output = { ...result, assertions };
          if (opts.strict && (!assertions.ok || result.complete === false))
            process.exitCode = EXIT.ERROR;
        } else if (opts.strict && result.complete === false) process.exitCode = EXIT.ERROR;
        console.log(formatResult(output, format, formatInspectText));
      } catch (error) {
        fail(format, error);
      } finally {
        await client.close();
      }
    });
}

export function registerAssertCommand(program: Command): void {
  program
    .command('assert')
    .description('Evaluate generic rules against inspect JSON')
    .requiredOption('--file <path|->', 'Rules JSON (schemaVersion 1)')
    .option('--against <path>', 'Evaluate an existing inspect JSON file instead of reading RemNote')
    .option('--strict', 'Exit 1 when any rule fails or a live read is incomplete')
    .addHelpText(
      'after',
      [
        '',
        'Rules are generic. There are no domain-specific rule kinds.',
        '  path        dot path; [0] is an index; [*] maps every element (rems[*].isCardItem, rems[*].tags[*].name); [field=value] filters',
        '  equals      deep-equal the selected value to expect',
        '  contains    substring, or an array element deep-equal to expect',
        '  startsWith  string prefix',
        '  regex       RegExp test (search, not a full-string match)',
        '  notContains literal substring or element must be absent; a missing path fails',
        '  count       array length, or a number at the path, compared to expect; optional match filters objects first',
        '  all|any|none  partial object match (listed keys) or scalar equality; all requires a non-empty array',
        '  hashEquals  selected string equals a baseline file (one trailing newline stripped) or expect',
        'The report is {ok, complete, errors, rules}. ok is false when a rule fails, complete is false, or errors is non-empty.',
        'A live file includes remIds. --against skips the bridge. Exit 0 on failure unless --strict.',
        'Examples are in docs/guides/state-verification.md.',
      ].join('\n')
    )
    .action(async (opts: { file: string; against?: string; strict?: boolean }) => {
      const format = formatOf(program);
      try {
        const { file, directory } = await readRules(opts.file);
        if (opts.against) {
          const text = await readFile(opts.against, 'utf8');
          if (Buffer.byteLength(text) > RULES_BYTES) throw new Error('Inspect file exceeds 1 MB');
          const document = JSON.parse(text) as unknown;
          const report = await evaluateRules(document, file.rules, directory);
          console.log(formatResult(report, format, formatRulesText));
          if (opts.strict && !report.ok) process.exitCode = EXIT.ERROR;
          return;
        }
        if (!file.remIds?.length) throw new Error('Live assert needs remIds, or pass --against');
        const client = createCommandClient(program);
        try {
          const result = (await client.execute('inspect_state', {
            remIds: file.remIds,
            descendants: file.descendants ?? 0,
            ...(file.fields ? { fields: file.fields } : {}),
            ...(file.summary ? { summary: true } : {}),
          })) as { complete?: boolean };
          const report = await evaluateRules(result, file.rules, directory);
          console.log(formatResult(report, format, formatRulesText));
          if (opts.strict && (!report.ok || result.complete === false))
            process.exitCode = EXIT.ERROR;
        } finally {
          await client.close();
        }
      } catch (error) {
        fail(format, error);
      }
    });
}
