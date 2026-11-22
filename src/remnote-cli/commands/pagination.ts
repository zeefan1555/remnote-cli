import type { Command } from 'commander';
import { CliFailure } from '../output/errors.js';

interface PageClient {
  execute(action: string, payload: Record<string, unknown>): Promise<unknown>;
}

interface PaginationInput {
  all?: boolean;
  maxPages?: string;
  pageDelay?: string;
}

export interface PaginationOptions {
  all: boolean;
  maxPages?: number;
  pageDelayMs: number;
}

interface Page {
  value: Record<string, unknown>;
  items: unknown[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PagingMetadata {
  complete: boolean;
  pages: number;
  itemCount: number;
  nextCursor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: string | undefined, flag: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new CliFailure(
      'usage',
      'invalid_pagination_value',
      flag + ' must be an integer >= ' + minimum
    );
  return parsed;
}

export function paginationOptions(options: PaginationInput): PaginationOptions {
  const all = options.all === true;
  const maxPages = integer(options.maxPages, '--max-pages', 1);
  const pageDelayMs = integer(options.pageDelay, '--page-delay', 0) ?? 0;
  if (maxPages !== undefined && !all)
    throw new CliFailure('usage', 'max_pages_requires_all', '--max-pages requires --all');
  return { all, maxPages, pageDelayMs };
}

export function registerPaginationOptions(command: Command): Command {
  return command
    .option('--all', 'Fetch every page from the current cursor snapshot')
    .option(
      '--max-pages <n>',
      'Explicit page bound for --all; reports an incomplete result at the bound'
    )
    .option('--page-delay <ms>', 'Delay between page requests in milliseconds', '0');
}

function pageFrom(value: unknown, itemsKey: 'results' | 'children'): Page {
  if (!isRecord(value))
    throw new CliFailure(
      'internal',
      'pagination_response_shape',
      'Pagination returned a non-object'
    );
  const items = value[itemsKey];
  if (!Array.isArray(items))
    throw new CliFailure(
      'internal',
      'pagination_items_shape',
      'Pagination response is missing the ' + itemsKey + ' array'
    );
  const hasMore = value.hasMore === true;
  const nextCursor =
    typeof value.nextCursor === 'string' && value.nextCursor.length > 0
      ? value.nextCursor
      : undefined;
  if (hasMore && !nextCursor)
    throw new CliFailure(
      'conflict',
      'pagination_cursor_missing',
      'Pagination reported more results without a next cursor'
    );
  return { value, items, hasMore, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function collectPages(
  client: PageClient,
  action: string,
  payload: Record<string, unknown>,
  itemsKey: 'results' | 'children',
  options: PaginationOptions
): Promise<Record<string, unknown>> {
  const initialCursor = typeof payload.cursor === 'string' ? payload.cursor : undefined;
  const seen = new Set<string>(initialCursor === undefined ? [] : [initialCursor]);
  const items: unknown[] = [];
  let cursor = initialCursor;
  let pages = 0;
  let firstPage: Page | undefined;
  let lastPage: Page | undefined;

  while (true) {
    const page = pageFrom(
      await client.execute(action, {
        ...payload,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      itemsKey
    );
    firstPage ??= page;
    lastPage = page;
    pages += 1;
    items.push(...page.items);

    if (!options.all || !page.hasMore) break;
    if (options.maxPages !== undefined && pages >= options.maxPages) break;
    if (page.nextCursor === undefined || seen.has(page.nextCursor))
      throw new CliFailure(
        'conflict',
        'pagination_cursor_repeated',
        'Pagination returned a missing or repeated cursor'
      );
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
    await delay(options.pageDelayMs);
  }

  if (!firstPage || !lastPage)
    throw new CliFailure('internal', 'pagination_empty', 'Pagination returned no pages');
  const complete = !lastPage.hasMore;
  const nextCursor = complete ? undefined : lastPage.nextCursor;
  const paging: PagingMetadata = {
    complete,
    pages,
    itemCount: items.length,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
  return {
    ...firstPage.value,
    ...lastPage.value,
    [itemsKey]: items,
    hasMore: !complete,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    paging,
  };
}
