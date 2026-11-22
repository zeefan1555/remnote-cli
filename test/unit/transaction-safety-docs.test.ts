import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('native transaction safety documentation', () => {
  it('distinguishes rejected metadata updates from verified non-atomic text updates', async () => {
    const adr = await readFile('docs/adr/0003-disable-unsafe-native-transactions.md', 'utf8');

    expect(adr).toContain(
      'commands (metadata-only `rem update`, `rem children replace`, and `rem property set`)'
    );
    expect(adr).toContain('`rem update --content`');
    expect(adr).toContain('`rem update-answer` use one native text setter');
    expect(adr).toContain('These checks are not an atomic compare-and-swap.');
    expect(adr).not.toContain('commands (`rem update`,');
    expect(adr).not.toContain('same-key replay');
  });
});
