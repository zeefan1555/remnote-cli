import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectPages,
  paginationOptions,
  type PaginationOptions,
} from '../../../src/remnote-cli/commands/pagination.js';
import { CliFailure } from '../../../src/remnote-cli/output/errors.js';

interface Client {
  execute(action: string, payload: Record<string, unknown>): Promise<unknown>;
}

const all = (overrides: Partial<PaginationOptions> = {}): PaginationOptions => ({
  all: true,
  pageDelayMs: 0,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pagination options', () => {
  it('keeps automatic paging unbounded unless the operator sets a bound', () => {
    expect(paginationOptions({ all: true })).toEqual({ all: true, pageDelayMs: 0 });
    expect(paginationOptions({ all: true, maxPages: '2', pageDelay: '25' })).toEqual({
      all: true,
      maxPages: 2,
      pageDelayMs: 25,
    });
  });

  it('requires all for max-pages and rejects invalid numbers', () => {
    expect(() => paginationOptions({ maxPages: '2' })).toThrow('--max-pages requires --all');
    expect(() => paginationOptions({ all: true, maxPages: '0' })).toThrow(
      '--max-pages must be an integer'
    );
    expect(() => paginationOptions({ all: true, pageDelay: '-1' })).toThrow(
      '--page-delay must be an integer'
    );
  });
});

describe('collectPages', () => {
  it('follows all pages from one cursor snapshot', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: Client = {
      execute: vi.fn(async (_action, payload) => {
        calls.push(payload);
        if (payload.cursor === undefined)
          return { results: [{ id: 'a' }], hasMore: true, nextCursor: 'p2' };
        if (payload.cursor === 'p2')
          return { results: [{ id: 'b' }], hasMore: true, nextCursor: 'p3' };
        return { results: [{ id: 'c' }], hasMore: false };
      }),
    };

    const result = await collectPages(client, 'search', { query: 'q', limit: 1 }, 'results', all());

    expect(calls).toEqual([
      { query: 'q', limit: 1 },
      { query: 'q', limit: 1, cursor: 'p2' },
      { query: 'q', limit: 1, cursor: 'p3' },
    ]);
    expect(result).toMatchObject({
      results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      hasMore: false,
      paging: { complete: true, pages: 3, itemCount: 3 },
    });
  });

  it('returns an incomplete result with the next cursor at an explicit bound', async () => {
    const client: Client = {
      execute: vi.fn(async (_action, payload) => ({
        children: payload.cursor === undefined ? [{ id: 'a' }] : [{ id: 'b' }],
        hasMore: true,
        nextCursor: payload.cursor === undefined ? 'p2' : 'p3',
      })),
    };

    const result = await collectPages(
      client,
      'list_children',
      { parentRemId: 'root', limit: 1 },
      'children',
      all({ maxPages: 2 })
    );

    expect(result).toMatchObject({
      children: [{ id: 'a' }, { id: 'b' }],
      hasMore: true,
      nextCursor: 'p3',
      paging: { complete: false, pages: 2, itemCount: 2, nextCursor: 'p3' },
    });
  });

  it('adds paging metadata to a raw one-page response', async () => {
    const client: Client = {
      execute: vi.fn().mockResolvedValue({
        results: [{ id: 'a' }],
        hasMore: true,
        nextCursor: 'next',
      }),
    };

    await expect(
      collectPages(client, 'search', { query: 'q' }, 'results', {
        all: false,
        pageDelayMs: 0,
      })
    ).resolves.toMatchObject({
      paging: { complete: false, pages: 1, itemCount: 1, nextCursor: 'next' },
    });
  });

  it('fails when hasMore has no cursor', async () => {
    const client: Client = {
      execute: vi.fn().mockResolvedValue({ results: [], hasMore: true }),
    };

    await expect(
      collectPages(client, 'search', { query: 'q' }, 'results', all())
    ).rejects.toMatchObject({ type: 'conflict', subtype: 'pagination_cursor_missing' });
  });

  it('fails on a repeated cursor instead of looping forever', async () => {
    const client: Client = {
      execute: vi.fn().mockResolvedValue({
        results: [{ id: 'a' }],
        hasMore: true,
        nextCursor: 'same',
      }),
    };

    await expect(
      collectPages(client, 'search', { query: 'q', cursor: 'same' }, 'results', all())
    ).rejects.toMatchObject({
      type: 'conflict',
      subtype: 'pagination_cursor_repeated',
    });
  });

  it('applies page delay only between pages', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client: Client = {
      execute: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? { results: [{ id: 'a' }], hasMore: true, nextCursor: 'p2' }
          : { results: [{ id: 'b' }], hasMore: false };
      }),
    };

    const pending = collectPages(
      client,
      'search',
      { query: 'q' },
      'results',
      all({ pageDelayMs: 100 })
    );
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      paging: { complete: true, pages: 2, itemCount: 2 },
    });
  });

  it('fails malformed pages as internal errors', async () => {
    const client: Client = { execute: vi.fn().mockResolvedValue({ items: [] }) };
    await expect(
      collectPages(client, 'search', { query: 'q' }, 'results', all())
    ).rejects.toBeInstanceOf(CliFailure);
  });
});
