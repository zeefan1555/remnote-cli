import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

interface PagedOutput {
  results?: Array<{ remId: string }>;
  children?: Array<{ remId: string }>;
  hasMore: boolean;
  nextCursor?: string;
  paging: {
    complete: boolean;
    pages: number;
    itemCount: number;
    nextCursor?: string;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('automatic search pagination', () => {
  it('follows all search pages with the same query and scope', async () => {
    const execute = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockImplementation(async (_action, payload) => {
        if (payload.cursor === undefined)
          return { results: [{ remId: 'a' }], hasMore: true, nextCursor: 'p2' };
        return { results: [{ remId: 'b' }], hasMore: false };
      });

    const result = await runCliForTest(['rem', 'search', 'term', '--all', '--limit', '1']);
    const output = parseSuccess(result.stdout) as PagedOutput;

    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenNthCalledWith(1, 'search', { query: 'term', limit: 1 });
    expect(execute).toHaveBeenNthCalledWith(2, 'search', {
      query: 'term',
      limit: 1,
      cursor: 'p2',
    });
    expect(output.results).toEqual([{ remId: 'a' }, { remId: 'b' }]);
    expect(output.paging).toEqual({
      complete: true,
      pages: 2,
      itemCount: 2,
    });
  });

  it('follows search-by-tag pages', async () => {
    const execute = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockImplementation(async (_action, payload) => {
        if (payload.cursor === undefined)
          return { results: [{ remId: 'a' }], hasMore: true, nextCursor: 'p2' };
        return { results: [{ remId: 'b' }], hasMore: false };
      });

    const result = await runCliForTest(['rem', 'search-by-tag', '--tag-id', 'tag', '--all']);
    const output = parseSuccess(result.stdout) as PagedOutput;

    expect(execute).toHaveBeenNthCalledWith(2, 'search_by_tag', {
      tagRemId: 'tag',
      limit: 50,
      cursor: 'p2',
    });
    expect(output.paging).toMatchObject({ complete: true, pages: 2, itemCount: 2 });
  });

  it('follows all pages for one list-children parent', async () => {
    const execute = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockImplementation(async (_action, payload) => {
        if (payload.cursor === undefined)
          return { children: [{ remId: 'a' }], hasMore: true, nextCursor: 'p2' };
        return { children: [{ remId: 'b' }], hasMore: false };
      });

    const result = await runCliForTest([
      'rem',
      'children',
      'list',
      'parent',
      '--all',
      '--limit',
      '1',
    ]);
    const output = parseSuccess(result.stdout) as PagedOutput;

    expect(execute).toHaveBeenCalledTimes(2);
    expect(output.children).toEqual([{ remId: 'a' }, { remId: 'b' }]);
    expect(output.paging.complete).toBe(true);
  });

  it('rejects all for several list-children parents before dispatch', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute');
    const result = await runCliForTest([
      'rem',
      'children',
      'list',
      'parent-a',
      'parent-b',
      '--all',
    ]);

    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr).message).toContain('page one parent');
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires all when max-pages is set', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute');
    const result = await runCliForTest(['rem', 'search', 'term', '--max-pages', '2']);

    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr).message).toContain('--max-pages requires --all');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports incomplete state at max-pages with the next cursor', async () => {
    vi.spyOn(DirectClient.prototype, 'execute').mockImplementation(async (_action, payload) => ({
      results: [{ remId: payload.cursor === undefined ? 'a' : 'b' }],
      hasMore: true,
      nextCursor: payload.cursor === undefined ? 'p2' : 'p3',
    }));

    const result = await runCliForTest(['rem', 'search', 'term', '--all', '--max-pages', '2']);
    const output = parseSuccess(result.stdout) as PagedOutput;

    expect(output.hasMore).toBe(true);
    expect(output.nextCursor).toBe('p3');
    expect(output.paging).toMatchObject({
      complete: false,
      pages: 2,
      itemCount: 2,
      nextCursor: 'p3',
    });
  });
});
